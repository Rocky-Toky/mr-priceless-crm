// Edge Function: sync-ghl-leads
// Brings every new lead from each client's GoHighLevel into client_leads, so
// the Lead Follow Up queue has it within minutes and our caller can ring
// them - with where they are and what they picked on the form. Uses the same
// per-client GHL key as ghl-report-data (client_ghl, service role only).
//
//   Scheduled (sql/078 pg_cron, every 5 minutes): header x-cron-secret
//     matches app_secrets.leads_cron_secret.
//   Signed-in allowlisted user, body { action: "sync" }: the same, now.
//
// Where leads come from, for each client, looking back 3 days:
//   - every opportunity created (the usual Meta -> GHL route), and
//   - every new contact that's a lead but never got an opportunity (needs
//     the key to have Contacts access; without it, only opportunities).
// Each new lead's contact is then read for their address and form answers
// (custom fields, named from the location's field list). A lead is skipped
// if it's already in (same opportunity or contact), or the same phone or
// email came in for that client in the last 14 days. lead_sync_status
// records how each client's last sync went. Logs carry counts only.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const GHL = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-07-28";
const WINDOW_MS = 3 * 86400e3;
const MAX_DETAIL_READS = 15; // contact look-ups per client per run; anything left gets its details on the next run
const RUN_BUDGET_MS = 100e3;  // stop starting new work well before the function's time limit
const PARALLEL = 4;           // clients synced at once

class GhlError extends Error { constructor(msg: string, public status: number) { super(msg); } }
async function ghl(path: string, token: string, init: RequestInit = {}) {
  const res = await fetch(GHL + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Version: GHL_VERSION, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GhlError(res.status === 401 ? "GHL rejected the key" : String(Array.isArray(body?.message) ? body.message.join(", ") : body?.message || `GHL returned ${res.status}`), res.status);
  return body;
}

const createdAt = (o: any) => new Date(o.createdAt || o.dateAdded || 0).getTime();

// Opportunities created in the window. GHL lists newest first, so this stops
// at the first page that's entirely older; if it ever lists oldest first it
// still works, just reads more pages.
async function recentOpportunities(locationId: string, token: string) {
  const since = Date.now() - WINDOW_MS;
  const out: any[] = [];
  let query = `location_id=${encodeURIComponent(locationId)}&limit=100`;
  for (let page = 0; page < 50; page++) {
    const body = await ghl(`/opportunities/search?${query}`, token);
    const batch = body?.opportunities || [];
    out.push(...batch.filter((o: any) => createdAt(o) >= since));
    if (!batch.length || batch.length < 100 || batch.every((o: any) => createdAt(o) < since)) break;
    const meta = body?.meta || {};
    if (meta.startAfterId && meta.startAfter != null) query = `location_id=${encodeURIComponent(locationId)}&limit=100&startAfterId=${encodeURIComponent(meta.startAfterId)}&startAfter=${encodeURIComponent(meta.startAfter)}`;
    else if (meta.nextPage) query = `location_id=${encodeURIComponent(locationId)}&limit=100&page=${encodeURIComponent(meta.nextPage)}`;
    else break;
  }
  return out;
}

// The newest contacts (newest first), for leads that never got an opportunity.
// Returns null when the key can't read contacts.
async function recentContacts(locationId: string, token: string) {
  try {
    const body = await ghl(`/contacts/search`, token, {
      method: "POST",
      body: JSON.stringify({ locationId, page: 1, pageLimit: 100, sort: [{ field: "dateAdded", direction: "desc" }] }),
    });
    const since = Date.now() - WINDOW_MS;
    return (body?.contacts || []).filter((c: any) => createdAt(c) >= since);
  } catch (e) {
    if (e instanceof GhlError && (e.status === 401 || e.status === 403)) return null;
    throw e;
  }
}

const digits = (s: string) => String(s || "").replace(/\D/g, "").slice(-9); // last 9 digits: ignores +64 / 0 prefixes
const clean = (s: unknown, n = 200) => String(s ?? "").trim().slice(0, n);
const nameOf = (c: any, o: any = {}) => clean(c.name || c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ") || o.name);
// A contact counts as a lead (rather than a supplier or an old customer
// someone typed in) when GHL calls it one or it came from a form or ad.
const looksLikeLead = (c: any) => String(c.type || "").toLowerCase() === "lead" || /facebook|meta|instagram|form|survey|lead|website|google|funnel|\bads?\b/i.test(String(c.source || "") + " " + (c.tags || []).join(" "));

function valueText(v: any): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(", ");
  if (typeof v === "object") return valueText(v.value ?? v.name ?? v.url ?? Object.values(v).join(" "));
  return String(v).trim();
}

// Address and form answers from the contact itself.
async function contactDetails(id: string, token: string, fieldNames: () => Promise<Map<string, string>>) {
  const body = await ghl(`/contacts/${encodeURIComponent(id)}`, token);
  const c = body?.contact || body || {};
  const names = await fieldNames();
  const answers = (c.customFields || c.customField || [])
    .map((f: any) => ({ q: clean(names.get(f.id) || f.name || f.fieldKey || "", 120), a: clean(valueText(f.value ?? f.fieldValue), 600) }))
    .filter((x: any) => x.q && x.a);
  const street = clean(c.address1, 200);
  const city = clean([c.city, c.state].filter(Boolean).join(", "), 120);
  const address = clean([street, c.city, c.postalCode].filter(Boolean).join(", "), 240);
  return { contact: c, answers, address, city };
}

async function syncClient(admin: any, conn: any, client: any, deadline: number) {
  const loc = conn.location_id, token = conn.token;
  const opps = await recentOpportunities(loc, token);
  const contacts = await recentContacts(loc, token);
  let names: Map<string, string> | null = null;
  const fieldNames = async () => {
    if (names) return names;
    names = new Map();
    try {
      const body = await ghl(`/locations/${encodeURIComponent(loc)}/customFields`, token);
      for (const f of body?.customFields || []) names.set(f.id, f.name || f.fieldKey || "");
    } catch { /* answers just show the field's own key */ }
    return names;
  };
  const stageName = new Map<string, string>();
  if (opps.length) {
    try {
      const pipes = await ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(loc)}`, token);
      for (const p of pipes?.pipelines || []) for (const s of p.stages || []) stageName.set(s.id, s.name || "");
    } catch { /* names are a nice-to-have */ }
  }

  const since = new Date(Date.now() - 14 * 86400e3).toISOString();
  const { data: recent } = await admin.from("client_leads").select("id, external_lead_id, ghl_contact_id, phone, email, details_at")
    .eq("client_id", client.id).gte("created_at", since).limit(3000);
  const byExt = new Map((recent || []).map((r: any) => [r.external_lead_id, r]));
  const byContact = new Map((recent || []).filter((r: any) => r.ghl_contact_id).map((r: any) => [r.ghl_contact_id, r]));
  const phones = new Set((recent || []).map((r: any) => digits(r.phone)).filter((p: string) => p.length >= 8));
  const emails = new Set((recent || []).map((r: any) => String(r.email || "").toLowerCase()).filter(Boolean));

  // One candidate per person: their opportunity if they have one, else the contact.
  const candidates: any[] = [];
  const seenContacts = new Set<string>();
  for (const o of opps) {
    const c = o.contact || {};
    const cid = o.contactId || c.id || "";
    if (cid) seenContacts.add(cid);
    candidates.push({ ext: "ghl:" + o.id, cid, c, status: stageName.get(o.pipelineStageId) || o.status, form: o.source || c.source, at: o.createdAt || o.dateAdded, oppName: o.name });
  }
  for (const c of contacts || []) {
    if (seenContacts.has(c.id) || !looksLikeLead(c)) continue;
    candidates.push({ ext: "ghlc:" + c.id, cid: c.id, c, status: "", form: c.source, at: c.dateAdded || c.createdAt });
  }

  let added = 0, reads = 0, lastLead: string | null = null;
  const rows: any[] = [], addedNow = new Set<string>();
  for (const x of candidates) {
    if (x.cid && addedNow.has(x.cid)) continue;
    const existing = byExt.get(x.ext) || (x.cid && byContact.get(x.cid));
    // Already in: just fill in its details if it hasn't got them yet.
    if (existing) {
      if (!existing.details_at && x.cid && reads < MAX_DETAIL_READS && Date.now() < deadline) {
        reads++;
        try {
          const d = await contactDetails(x.cid, token, fieldNames);
          await admin.from("client_leads").update({ ghl_contact_id: x.cid, address: d.address || null, city: d.city || null, answers: d.answers, details_at: new Date().toISOString() }).eq("id", existing.id);
        } catch { /* try again next run */ }
      }
      continue;
    }
    let c = x.c, d: any = null;
    if (x.cid && reads < MAX_DETAIL_READS && Date.now() < deadline) {
      reads++;
      try { d = await contactDetails(x.cid, token, fieldNames); c = { ...c, ...d.contact }; } catch { d = null; }
    }
    const phone = clean(c.phone, 40), email = clean(c.email, 200).toLowerCase();
    if ((digits(phone).length >= 8 && phones.has(digits(phone))) || (email && emails.has(email))) continue;
    if (!phone && !email) continue; // nothing to call
    if (digits(phone).length >= 8) phones.add(digits(phone));
    if (email) emails.add(email);
    if (x.cid) addedNow.add(x.cid);
    const at = new Date(x.at || Date.now()).toISOString();
    if (!lastLead || at > lastLead) lastLead = at;
    rows.push({
      client_id: client.id, external_lead_id: x.ext, source: "ghl", ghl_contact_id: x.cid || null,
      name: nameOf(c, { name: x.oppName }), phone, email,
      status: clean(x.status, 100), form_name: clean(x.form || "GoHighLevel", 120),
      address: d?.address || null, city: d?.city || null, answers: d?.answers || [], details_at: d ? new Date().toISOString() : null,
      lead_created_at: at, follow_status: "new",
    });
  }
  if (rows.length) {
    const { error } = await admin.from("client_leads").insert(rows);
    if (error) throw new Error(error.message);
    added = rows.length;
  }
  return { added, contactsAccess: contacts !== null, lastLead };
}

async function syncAll(admin: any) {
  const deadline = Date.now() + RUN_BUDGET_MS;
  const [{ data: conns }, { data: clients }, { data: statuses }] = await Promise.all([
    admin.from("client_ghl").select("client_id, location_id, token"),
    admin.from("clients").select("id, name, stage"),
    admin.from("lead_sync_status").select("client_id, last_ok_at, leads_added, last_lead_at"),
  ]);
  const byId = new Map((clients || []).map((c: any) => [c.id, c]));
  const prevOf = new Map((statuses || []).map((r: any) => [r.client_id, r]));
  const todo = (conns || []).filter((cn: any) => {
    const c: any = byId.get(cn.client_id);
    return c && !["churned", "archived"].includes(String(c.stage || ""));
  });
  // Every connected client shows as connected straight away, even before its
  // first full check finishes.
  const started = new Date().toISOString();
  const fresh = todo.filter((cn: any) => !prevOf.has(cn.client_id)).map((cn: any) => ({ client_id: cn.client_id, last_sync_at: started }));
  if (fresh.length) await admin.from("lead_sync_status").upsert(fresh);
  // Whoever waited longest goes first, so one slow client can't keep the rest waiting run after run.
  todo.sort((x: any, y: any) => String((prevOf.get(x.client_id) as any)?.last_ok_at || "").localeCompare(String((prevOf.get(y.client_id) as any)?.last_ok_at || "")));

  let added = 0, failed = 0, checked = 0, noContacts = 0, skipped = 0;
  const one = async (conn: any) => {
    const client: any = byId.get(conn.client_id), prev: any = prevOf.get(conn.client_id);
    const now = new Date().toISOString();
    try {
      const r = await syncClient(admin, conn, client, deadline);
      checked++; added += r.added;
      if (!r.contactsAccess) noContacts++;
      await admin.from("lead_sync_status").upsert({
        client_id: client.id, last_sync_at: now, last_ok_at: new Date().toISOString(), error: null, contacts_access: r.contactsAccess,
        leads_added: (prev?.leads_added || 0) + r.added, last_lead_at: r.lastLead && (!prev?.last_lead_at || r.lastLead > prev.last_lead_at) ? r.lastLead : prev?.last_lead_at || null,
      });
    } catch (e) {
      checked++; failed++;
      const msg = String((e as any)?.message || e).slice(0, 200);
      console.warn("sync-ghl-leads: a client failed:", msg.slice(0, 120));
      await admin.from("lead_sync_status").upsert({ client_id: client.id, last_sync_at: now, error: msg });
    }
  };
  for (let i = 0; i < todo.length; i += PARALLEL) {
    if (Date.now() > deadline) { skipped = todo.length - i; break; } // the rest go first next run
    await Promise.all(todo.slice(i, i + PARALLEL).map(one));
  }
  return { connected: todo.length, checked, added, failed, skipped, no_contacts_access: noContacts };
}

// Where a client's lead details live in GHL, by shape only - counts and
// yes/no, never names or answers - for the workflow's sync check.
async function inspect(admin: any) {
  const { data: conns } = await admin.from("client_ghl").select("client_id, location_id, token");
  const out: any[] = [];
  let n = 0;
  for (const conn of conns || []) {
    n++;
    const { data: leads } = await admin.from("client_leads").select("external_lead_id, ghl_contact_id, details_at")
      .eq("client_id", conn.client_id).like("external_lead_id", "ghl%").order("created_at", { ascending: false }).limit(2);
    const samples: any[] = [];
    for (const l of leads || []) {
      const s: any = { details_at: Boolean(l.details_at) };
      const oppId = String(l.external_lead_id).startsWith("ghl:") ? String(l.external_lead_id).slice(4) : null;
      let cid = l.ghl_contact_id;
      if (oppId) {
        try {
          const o = (await ghl(`/opportunities/${encodeURIComponent(oppId)}`, conn.token))?.opportunity || {};
          cid = cid || o.contactId;
          const cf = o.customFields || [];
          s.opp = { keys: Object.keys(o).sort(), custom_fields: cf.length, custom_filled: cf.filter((f: any) => valueText(f.fieldValue ?? f.value ?? f.fieldValueString ?? f.fieldValueArray)).length, has_notes: Boolean(o.notes) };
        } catch (e) { s.opp = { error: (e as any)?.status || String(e).slice(0, 60) }; }
      }
      if (cid) {
        try {
          const c = (await ghl(`/contacts/${encodeURIComponent(cid)}`, conn.token))?.contact || {};
          const cf = c.customFields || [];
          s.contact = { keys: Object.keys(c).sort(), custom_fields: cf.length, custom_filled: cf.filter((f: any) => valueText(f.value)).length, address1: Boolean(c.address1), city: Boolean(c.city), postal: Boolean(c.postalCode), tags: (c.tags || []).length, attribution: Boolean(c.attributionSource) };
        } catch (e) { s.contact = { error: (e as any)?.status || String(e).slice(0, 60) }; }
        try {
          const notes = (await ghl(`/contacts/${encodeURIComponent(cid)}/notes`, conn.token))?.notes || [];
          s.notes = { count: notes.length, longest: Math.max(0, ...notes.map((x: any) => String(x.body || "").length)) };
        } catch (e) { s.notes = { error: (e as any)?.status || String(e).slice(0, 60) }; }
        try {
          const subs = await ghl(`/forms/submissions?locationId=${encodeURIComponent(conn.location_id)}&q=${encodeURIComponent(cid)}&limit=5`, conn.token);
          s.form_submissions = { count: (subs?.submissions || []).length };
        } catch (e) { s.form_submissions = { error: (e as any)?.status || String(e).slice(0, 60) }; }
      }
      samples.push(s);
    }
    out.push({ client: n, samples });
  }
  return out;
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
    let cb: any = {};
    try { cb = (await req.json()) ?? {}; } catch { cb = {}; }
    if (cb.action === "inspect") return json(await inspect(admin));
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
