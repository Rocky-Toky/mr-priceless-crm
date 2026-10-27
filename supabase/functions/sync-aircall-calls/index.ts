// Edge Function: sync-aircall-calls
// Copies every Aircall call (in and out) into aircall_calls for the Lead
// Follow Up "Recorded calls" page, matched to the lead or client by phone
// number. Recordings stay in Aircall; Play asks for a fresh link each time,
// because Aircall's recording links only last a few minutes.
//
//   Scheduled (sql/092 pg_cron, every 5 minutes): header x-cron-secret
//     matches app_secrets.aircall_cron_secret. Re-reads the last 2 hours
//     each run, so calls that were still going (or whose recording wasn't
//     ready yet) get filled in. The first run catches up on 30 days.
//   Signed-in allowlisted user:
//     { action: "sync" }               the same, now
//     { action: "recording", call_id } a short-lived link to play it
//
// Needs the function secrets AIRCALL_API_ID and AIRCALL_API_TOKEN (set from
// the repo secrets by the deploy workflow). Without them it does nothing and
// records connected = false. Logs carry counts only.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const AIRCALL = "https://api.aircall.io/v1";
const FIRST_RUN_MS = 30 * 86400e3;
const OVERLAP_MS = 2 * 3600e3;
const MAX_PAGES = 40;          // 50 calls a page
const RUN_BUDGET_MS = 100e3;

class AircallError extends Error { constructor(msg: string, public status: number) { super(msg); } }
async function aircall(path: string, auth: string) {
  const res = await fetch(AIRCALL + path, { headers: { Authorization: `Basic ${auth}`, Accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new AircallError(res.status === 401 || res.status === 403 ? "Aircall rejected the API key" : String(body?.message || body?.error || `Aircall returned ${res.status}`), res.status);
  return body;
}
function aircallAuth() {
  const id = Deno.env.get("AIRCALL_API_ID"), token = Deno.env.get("AIRCALL_API_TOKEN");
  return id && token ? btoa(`${id}:${token}`) : null;
}

const last9 = (n: unknown) => String(n ?? "").replace(/\D/g, "").slice(-9);
const iso = (unix: unknown) => (typeof unix === "number" && unix > 0 ? new Date(unix * 1000).toISOString() : null);
// Numbers written anywhere in a client's key contacts.
const numbersIn = (text: unknown) => (String(text ?? "").match(/\+?\d[\d\s()-]{6,}\d/g) || []).map(last9);

export function callRow(c: any, leadByPhone: Map<string, any>, clientByPhone: Map<string, string>) {
  const key = last9(c.raw_digits);
  const lead = key.length >= 7 ? leadByPhone.get(key) : null;
  const voicemail = !!c.voicemail;
  const status = voicemail ? "voicemail" : c.answered_at ? (c.status === "done" ? "done" : "answered") : c.status === "done" ? "missed" : String(c.status || "initial");
  return {
    id: Number(c.id),
    direction: c.direction === "outbound" ? "outbound" : "inbound",
    status,
    number: c.raw_digits ? String(c.raw_digits) : null,
    line: c.number?.name || c.number?.digits || null,
    user_name: c.user?.name || null,
    user_email: c.user?.email || null,
    started_at: iso(c.started_at),
    answered_at: iso(c.answered_at),
    ended_at: iso(c.ended_at),
    duration: typeof c.duration === "number" ? c.duration : null,
    recorded: !!c.recording,
    voicemail,
    lead_id: lead?.id || null,
    client_id: lead?.client_id || (key.length >= 7 ? clientByPhone.get(key) : null) || null,
    synced_at: new Date().toISOString(),
  };
}

async function phoneMaps(admin: any) {
  const since = new Date(Date.now() - 365 * 86400e3).toISOString();
  const [{ data: leads }, { data: clients }] = await Promise.all([
    admin.from("client_leads").select("id, client_id, phone, created_at").not("phone", "is", null).gte("created_at", since).order("created_at", { ascending: true }).limit(20000),
    admin.from("clients").select("id, phone, key_contacts"),
  ]);
  // Oldest first, so the newest lead for a number wins.
  const leadByPhone = new Map<string, any>();
  for (const l of leads || []) { const k = last9(l.phone); if (k.length >= 7) leadByPhone.set(k, l); }
  const clientByPhone = new Map<string, string>();
  for (const c of clients || []) for (const k of [last9(c.phone), ...numbersIn(c.key_contacts)]) if (k.length >= 7) clientByPhone.set(k, c.id);
  return { leadByPhone, clientByPhone };
}

async function setStatus(admin: any, patch: Record<string, unknown>) {
  await admin.from("aircall_sync_status").upsert({ id: 1, ...patch, updated_at: new Date().toISOString() });
}

export async function syncCalls(admin: any) {
  const auth = aircallAuth();
  if (!auth) { await setStatus(admin, { connected: false, last_error: null }); return { connected: false }; }
  const started = Date.now();
  const { data: st } = await admin.from("aircall_sync_status").select("cursor_at").eq("id", 1).maybeSingle();
  const fromMs = st?.cursor_at ? new Date(st.cursor_at).getTime() - OVERLAP_MS : Date.now() - FIRST_RUN_MS;
  const from = Math.floor(fromMs / 1000), to = Math.floor(Date.now() / 1000);
  try {
    const { leadByPhone, clientByPhone } = await phoneMaps(admin);
    let saved = 0, pages = 0, reachedEnd = false, lastStart = fromMs;
    for (let page = 1; page <= MAX_PAGES; page++) {
      if (Date.now() - started > RUN_BUDGET_MS) break;
      const body = await aircall(`/calls?from=${from}&to=${to}&order=asc&per_page=50&page=${page}`, auth);
      pages++;
      const calls = Array.isArray(body?.calls) ? body.calls : [];
      if (calls.length) {
        const rows = calls.map((c: any) => callRow(c, leadByPhone, clientByPhone)).filter((r: any) => r.id);
        const { error } = await admin.from("aircall_calls").upsert(rows, { onConflict: "id" });
        if (error) throw new Error("Couldn't save calls: " + error.message);
        saved += rows.length;
        for (const r of rows) if (r.started_at) lastStart = Math.max(lastStart, new Date(r.started_at).getTime());
      }
      if (!body?.meta?.next_page_link || calls.length < 50) { reachedEnd = true; break; }
    }
    // Caught up: carry on from now next time. Otherwise from the last call saved.
    const cursor = new Date(reachedEnd ? to * 1000 : lastStart).toISOString();
    await setStatus(admin, { connected: true, cursor_at: cursor, last_ok_at: new Date().toISOString(), last_error: null });
    console.log(`aircall sync: ${saved} calls over ${pages} page(s)${reachedEnd ? "" : ", more to come"}`);
    return { connected: true, saved, pages, done: reachedEnd };
  } catch (e) {
    const msg = String((e as any)?.message || e).slice(0, 300);
    await setStatus(admin, { connected: true, last_error: msg });
    console.log("aircall sync failed: " + msg);
    return { connected: true, error: msg };
  }
}

export async function recordingLink(callId: unknown) {
  const auth = aircallAuth();
  if (!auth) return { error: "Aircall isn't connected yet." };
  const id = Number(callId);
  if (!Number.isFinite(id) || id <= 0) return { error: "No call picked." };
  try {
    const body = await aircall(`/calls/${id}`, auth);
    const c = body?.call || {};
    const url = c.recording || c.voicemail || null;
    return url ? { url } : { error: "There's no recording for this call." };
  } catch (e) {
    return { error: String((e as any)?.message || e) };
  }
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
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "aircall_cron_secret").maybeSingle();
    if (!secret?.value || secret.value !== cronHeader) return json({ error: "Unauthorized." }, 401);
    return json(await syncCalls(admin));
  }

  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const email = userData?.user?.email;
  if (!email) return json({ error: "Unauthorized." }, 401);
  const { data: allowed } = await admin.from("allowlist").select("email").ilike("email", email).maybeSingle();
  if (!allowed) return json({ error: "Unauthorized." }, 401);
  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }
  if (body.action === "sync") return json(await syncCalls(admin));
  if (body.action === "recording") return json(await recordingLink(body.call_id));
  return json({ error: "Unknown action." }, 400);
});
