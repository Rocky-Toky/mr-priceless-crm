// Edge Function: ghl-report-data
// Reads a client's GoHighLevel opportunities for the fortnightly finance
// report. Each client's GHL Private Integration key is stored in client_ghl,
// which the browser can't read (RLS with no policies) - only this function,
// using the service role, ever touches it.
//
// Body: { action, client_id, ... } from a signed-in allowlisted user.
//   status      -> { connected, location_id, location_name }
//   connect     -> { location_id, token }  checks the key against GHL, then saves it
//   disconnect  -> removes the saved key
//   pull        -> { from, to } (YYYY-MM-DD) -> { metrics }
//
// What "pull" works out, from every opportunity in the sub-account, for the
// period asked for (the CRM asks for the month so far and works out what's new
// since the last report itself):
//   revenue_won / jobs_won   status "won" with the win landing in the period
//   enquiries                opportunities created in the period
//   quote_ready              created in the period and at or past the "quote booked" stage
//   quoted                   created in the period and at or past the "quote sent" stage
// Which stages count as "quote booked" and "quote sent" is picked per client in
// the CRM (body.stages = { booked, sent }, stage ids). Without a pick, a stage
// name with "book", "appoint" or "visit" is booked, one with "sent" or "quote"
// is sent, and anything past the first stage counts as booked.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const GHL = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";

async function ghl(path: string, token: string) {
  const res = await fetch(GHL + path, {
    headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json" },
  });
  const text = await res.text();
  let body: any = null;
  try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!res.ok) {
    const msg = Array.isArray(body?.message) ? body.message.join(", ") : (body?.message || body?.error || `GHL returned ${res.status}`);
    throw new Error(res.status === 401 ? "GHL rejected the key - check it's a Private Integration key for this sub-account." : String(msg));
  }
  return body;
}

// Every opportunity in the location, following GHL's pagination.
async function allOpportunities(locationId: string, token: string) {
  const out: any[] = [];
  let query = `location_id=${encodeURIComponent(locationId)}&limit=100`;
  for (let page = 0; page < 100; page++) {
    const body = await ghl(`/opportunities/search?${query}`, token);
    const batch = body?.opportunities || [];
    out.push(...batch);
    const meta = body?.meta || {};
    if (!batch.length || batch.length < 100) break;
    if (meta.startAfterId && meta.startAfter != null) {
      query = `location_id=${encodeURIComponent(locationId)}&limit=100&startAfterId=${encodeURIComponent(meta.startAfterId)}&startAfter=${encodeURIComponent(meta.startAfter)}`;
    } else if (meta.nextPage) {
      query = `location_id=${encodeURIComponent(locationId)}&limit=100&page=${encodeURIComponent(meta.nextPage)}`;
    } else break;
  }
  return out;
}

export function summarise(opps: any[], pipelines: any[], from: string, to: string, picked: { booked?: string; sent?: string } = {}) {
  const start = new Date(from + "T00:00:00Z").getTime() - 13 * 3600e3; // NZ day starts ~13h before UTC midnight
  const end = new Date(to + "T23:59:59Z").getTime() - 11 * 3600e3;
  const inPeriod = (d: any) => { const t = d ? new Date(d).getTime() : NaN; return t >= start && t <= end; };
  // For each pipeline: where every stage sits, and the booked and sent points.
  const stageAt = new Map<string, { pipeline: string; index: number }>();
  const marks = new Map<string, { booked: number; sent: number; bookedName: string; sentName: string }>();
  for (const p of pipelines || []) {
    const stages = p.stages || [];
    stages.forEach((s: any, i: number) => stageAt.set(s.id, { pipeline: p.id, index: i }));
    const find = (re: RegExp, after = -1) => stages.findIndex((s: any, i: number) => i > after && re.test(s.name || ""));
    let booked = stages.findIndex((s: any) => s.id === picked.booked);
    if (booked < 0) booked = find(/book|appoint|visit|site/i);
    if (booked < 0) booked = Math.min(1, stages.length - 1);
    let sent = stages.findIndex((s: any) => s.id === picked.sent);
    if (sent < 0) sent = find(/sent|quoted|proposal/i, booked);
    if (sent < 0) sent = find(/quot/i, booked);
    if (sent < 0) sent = stages.length; // no sent stage: only won counts as quoted
    marks.set(p.id, { booked, sent, bookedName: stages[booked]?.name || "", sentName: stages[sent]?.name || "Won" });
  }
  const value = (o: any) => Number(o.monetaryValue) || 0;
  const status = (o: any) => String(o.status || "").toLowerCase();
  const wonAt = (o: any) => o.lastStatusChangeAt || o.updatedAt || o.createdAt;
  const reached = (o: any, which: "booked" | "sent") => {
    if (status(o) === "won") return true;
    const at = stageAt.get(o.pipelineStageId), m = at && marks.get(at.pipeline);
    return Boolean(at && m && at.index >= m[which]);
  };
  const won = opps.filter((o) => status(o) === "won");
  const wonInPeriod = won.filter((o) => inPeriod(wonAt(o)));
  const created = opps.filter((o) => inPeriod(o.createdAt || o.dateAdded));
  const firstMarks = [...marks.values()][0];
  return {
    revenue_won: Math.round(wonInPeriod.reduce((s, o) => s + value(o), 0)),
    jobs_won: wonInPeriod.length,
    revenue_won_to_date: Math.round(won.reduce((s, o) => s + value(o), 0)),
    enquiries: created.length,
    quote_ready: created.filter((o) => reached(o, "booked")).length,
    quoted: created.filter((o) => reached(o, "sent")).length,
    won_missing_value: wonInPeriod.filter((o) => !value(o)).length,
    opportunities_checked: opps.length,
    booked_stage: firstMarks?.bookedName || "",
    sent_stage: firstMarks?.sentName || "",
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: "Server misconfigured: missing Supabase environment variables." }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // Signed-in, allowlisted users only.
  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const email = userData?.user?.email;
  if (!email) return json({ error: "Unauthorized." }, 401);
  const { data: allowed } = await admin.from("allowlist").select("email").eq("email", email).maybeSingle();
  if (!allowed) return json({ error: "Unauthorized." }, 401);

  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }
  const { action, client_id } = body;
  if (!client_id) return json({ error: "client_id is required." }, 400);

  try {
    if (action === "status") {
      const { data, error } = await admin.from("client_ghl").select("location_id, location_name, connected_at").eq("client_id", client_id).maybeSingle();
      if (error) return json({ error: error.message.includes("client_ghl") ? "Run sql/056_ghl_connections.sql in Supabase first." : error.message }, 500);
      if (!data) return json({ connected: false });
      // The stages, so the CRM can ask which ones mean "quote booked" and "quote sent".
      let pipelines: any[] = [];
      try {
        const { data: conn } = await admin.from("client_ghl").select("token").eq("client_id", client_id).maybeSingle();
        const pipes = await ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(data.location_id)}`, conn!.token);
        pipelines = (pipes?.pipelines || []).map((p: any) => ({ id: p.id, name: p.name, stages: (p.stages || []).map((s: any) => ({ id: s.id, name: s.name })) }));
      } catch (_e) { /* still connected; stages just can't be listed right now */ }
      return json({ connected: true, location_id: data.location_id, location_name: data.location_name || null, pipelines });
    }
    if (action === "connect") {
      const location_id = String(body.location_id || "").trim(), token = String(body.token || "").trim();
      if (!location_id || !token) return json({ error: "Location ID and key are both needed." }, 400);
      const loc = await ghl(`/locations/${encodeURIComponent(location_id)}`, token);
      const location_name = loc?.location?.name || null;
      await ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(location_id)}`, token); // proves the Opportunities scope
      const { error } = await admin.from("client_ghl").upsert({ client_id, location_id, token, location_name, updated_at: new Date().toISOString() });
      if (error) return json({ error: error.message }, 500);
      return json({ connected: true, location_name });
    }
    if (action === "disconnect") {
      await admin.from("client_ghl").delete().eq("client_id", client_id);
      return json({ connected: false });
    }
    if (action === "pull") {
      const { from, to } = body;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from || "") || !/^\d{4}-\d{2}-\d{2}$/.test(to || "")) return json({ error: "from and to dates are needed." }, 400);
      const { data: conn } = await admin.from("client_ghl").select("location_id, token").eq("client_id", client_id).maybeSingle();
      if (!conn) return json({ error: "This client's GHL isn't connected yet." }, 400);
      const pipes = await ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(conn.location_id)}`, conn.token);
      const opps = await allOpportunities(conn.location_id, conn.token);
      return json({ metrics: summarise(opps, pipes?.pipelines || [], from, to, body.stages || {}) });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 502);
  }
});
