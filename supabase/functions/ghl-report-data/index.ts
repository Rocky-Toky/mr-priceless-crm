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
// What "pull" works out, from every opportunity in the sub-account:
//   revenue_won / jobs_won   status "won" with the win landing in the period
//   revenue_won_to_date      every won opportunity, all time
//   open_quotes(_value)      status "open" sitting in a quote stage
//   enquiries                opportunities created in the period
//   quoted                   created in the period and now in a quote stage or won
//   quote_ready              created in the period and past the first stage
// A "quote stage" is any pipeline stage whose name contains "quote".

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

export function summarise(opps: any[], pipelines: any[], from: string, to: string) {
  const start = new Date(from + "T00:00:00Z").getTime() - 13 * 3600e3; // NZ day starts ~13h before UTC midnight
  const end = new Date(to + "T23:59:59Z").getTime() - 11 * 3600e3;
  const inPeriod = (d: any) => { const t = d ? new Date(d).getTime() : NaN; return t >= start && t <= end; };
  const stageInfo = new Map<string, { name: string; index: number; quote: boolean }>();
  const quoteStageNames = new Set<string>();
  for (const p of pipelines || []) {
    (p.stages || []).forEach((s: any, i: number) => {
      const quote = /quot/i.test(s.name || "");
      if (quote) quoteStageNames.add(s.name);
      stageInfo.set(s.id, { name: s.name, index: i, quote });
    });
  }
  const value = (o: any) => Number(o.monetaryValue) || 0;
  const status = (o: any) => String(o.status || "").toLowerCase();
  const wonAt = (o: any) => o.lastStatusChangeAt || o.updatedAt || o.createdAt;
  const won = opps.filter((o) => status(o) === "won");
  const wonInPeriod = won.filter((o) => inPeriod(wonAt(o)));
  const openQuotes = opps.filter((o) => status(o) === "open" && stageInfo.get(o.pipelineStageId)?.quote);
  const created = opps.filter((o) => inPeriod(o.createdAt || o.dateAdded));
  const atOrPastQuote = (o: any) => status(o) === "won" || Boolean(stageInfo.get(o.pipelineStageId)?.quote);
  const pastFirst = (o: any) => status(o) === "won" || (stageInfo.get(o.pipelineStageId)?.index ?? 0) > 0;
  return {
    revenue_won: Math.round(wonInPeriod.reduce((s, o) => s + value(o), 0)),
    jobs_won: wonInPeriod.length,
    revenue_won_to_date: Math.round(won.reduce((s, o) => s + value(o), 0)),
    jobs_won_to_date: won.length,
    open_quotes: openQuotes.length,
    open_quotes_value: Math.round(openQuotes.reduce((s, o) => s + value(o), 0)),
    enquiries: created.length,
    quoted: created.filter(atOrPastQuote).length,
    quote_ready: created.filter(pastFirst).length,
    opportunities_checked: opps.length,
    quote_stage_names: [...quoteStageNames],
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
      return json({ connected: Boolean(data), location_id: data?.location_id || null, location_name: data?.location_name || null });
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
      return json({ metrics: summarise(opps, pipes?.pipelines || [], from, to) });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 502);
  }
});
