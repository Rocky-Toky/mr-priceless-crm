// Edge Function: sync-ghl-leads
// Brings every new lead from each client's GoHighLevel into client_leads, so
// the Lead Follow Up queue has it within minutes and our caller can ring
// them. Uses the same per-client GHL key as ghl-report-data (client_ghl,
// service role only).
//
//   Scheduled (sql/078 pg_cron, every 5 minutes): header x-cron-secret
//     matches app_secrets.leads_cron_secret.
//   Signed-in allowlisted user, body { action: "sync" }: the same, now.
//
// Only opportunities created in the last 2 days are looked at. A lead is
// skipped if it's already in (same GHL opportunity), or the same phone or
// email came in for that client in the last 14 days (e.g. it was also
// imported from Meta's Lead Center). Logs carry counts only, never names.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const GHL = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const WINDOW_MS = 2 * 86400e3;

async function ghl(path: string, token: string) {
  const res = await fetch(GHL + path, { headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(res.status === 401 ? "GHL rejected the key" : String(body?.message || `GHL returned ${res.status}`));
  return body;
}

// Opportunities created in the window. GHL lists newest first, so this stops
// at the first page that's entirely older; if it ever lists oldest first it
// still works, just reads more pages.
async function recentOpportunities(locationId: string, token: string) {
  const since = Date.now() - WINDOW_MS;
  const created = (o: any) => new Date(o.createdAt || o.dateAdded || 0).getTime();
  const out: any[] = [];
  let query = `location_id=${encodeURIComponent(locationId)}&limit=100`;
  for (let page = 0; page < 50; page++) {
    const body = await ghl(`/opportunities/search?${query}`, token);
    const batch = body?.opportunities || [];
    out.push(...batch.filter((o: any) => created(o) >= since));
    if (!batch.length || batch.length < 100 || batch.every((o: any) => created(o) < since)) break;
    const meta = body?.meta || {};
    if (meta.startAfterId && meta.startAfter != null) query = `location_id=${encodeURIComponent(locationId)}&limit=100&startAfterId=${encodeURIComponent(meta.startAfterId)}&startAfter=${encodeURIComponent(meta.startAfter)}`;
    else if (meta.nextPage) query = `location_id=${encodeURIComponent(locationId)}&limit=100&page=${encodeURIComponent(meta.nextPage)}`;
    else break;
  }
  return out;
}

const digits = (s: string) => String(s || "").replace(/\D/g, "").slice(-9); // last 9 digits: ignores +64 / 0 prefixes
const clean = (s: unknown, n = 200) => String(s ?? "").trim().slice(0, n);

async function syncClient(admin: any, conn: any, client: any) {
  const opps = await recentOpportunities(conn.location_id, conn.token);
  if (!opps.length) return 0;
  // Stage names, so Carmen can see if the client has already moved it on.
  const stageName = new Map<string, string>();
  try {
    const pipes = await ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(conn.location_id)}`, conn.token);
    for (const p of pipes?.pipelines || []) for (const s of p.stages || []) stageName.set(s.id, s.name || "");
  } catch { /* names are a nice-to-have */ }
  const since = new Date(Date.now() - 14 * 86400e3).toISOString();
  const { data: recent } = await admin.from("client_leads").select("external_lead_id, phone, email")
    .eq("client_id", client.id).gte("created_at", since).limit(2000);
  const ids = new Set((recent || []).map((r: any) => r.external_lead_id));
  const phones = new Set((recent || []).map((r: any) => digits(r.phone)).filter((p: string) => p.length >= 8));
  const emails = new Set((recent || []).map((r: any) => String(r.email || "").toLowerCase()).filter(Boolean));
  const rows: any[] = [];
  for (const o of opps) {
    const ext = "ghl:" + o.id;
    const c = o.contact || {};
    const phone = clean(c.phone, 40), email = clean(c.email, 200).toLowerCase();
    if (ids.has(ext) || (digits(phone).length >= 8 && phones.has(digits(phone))) || (email && emails.has(email))) continue;
    if (!phone && !email) continue; // nothing to call
    ids.add(ext); if (digits(phone).length >= 8) phones.add(digits(phone)); if (email) emails.add(email);
    rows.push({
      client_id: client.id, external_lead_id: ext, source: "ghl",
      name: clean(c.name || o.name || [c.firstName, c.lastName].filter(Boolean).join(" ")),
      phone, email, status: clean(stageName.get(o.pipelineStageId) || o.status, 100), form_name: clean(o.source || "GoHighLevel", 120),
      lead_created_at: new Date(o.createdAt || o.dateAdded || Date.now()).toISOString(), follow_status: "new",
    });
  }
  if (rows.length) {
    const { error } = await admin.from("client_leads").insert(rows);
    if (error) throw new Error(error.message);
  }
  return rows.length;
}

async function syncAll(admin: any) {
  const [{ data: conns }, { data: clients }] = await Promise.all([
    admin.from("client_ghl").select("client_id, location_id, token"),
    admin.from("clients").select("id, name, stage"),
  ]);
  const byId = new Map((clients || []).map((c: any) => [c.id, c]));
  let added = 0, failed = 0, checked = 0;
  for (const conn of conns || []) {
    const client: any = byId.get(conn.client_id);
    if (!client || ["churned", "archived"].includes(String(client.stage || ""))) continue;
    checked++;
    try { added += await syncClient(admin, conn, client); }
    catch (e) { failed++; console.warn("sync-ghl-leads: a client failed:", String((e as any)?.message || e).slice(0, 120)); }
  }
  return { checked, added, failed };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: "Server misconfigured." }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) {
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "leads_cron_secret").maybeSingle();
    if (!secret?.value || secret.value !== cronHeader) return json({ error: "Unauthorized." }, 401);
    return json(await syncAll(admin));
  }

  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const email = userData?.user?.email;
  if (!email) return json({ error: "Unauthorized." }, 401);
  const { data: allowed } = await admin.from("allowlist").select("email").ilike("email", email).maybeSingle();
  if (!allowed) return json({ error: "Unauthorized." }, 401);
  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }
  if (body.action === "sync") return json(await syncAll(admin));
  return json({ error: "Unknown action." }, 400);
});
