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
async function ghl(path: string, token: string, init: RequestInit = {}, version = GHL_VERSION) {
  const res = await fetch(GHL + path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GhlError(res.status === 401 ? "GHL rejected the key" : String(Array.isArray(body?.message) ? body.message.join(", ") : body?.message || `GHL returned ${res.status}`), res.status);
  return body;
}

const createdAt = (o: any) => new Date(o.createdAt || o.dateAdded || 0).getTime();

// Every opportunity in the location (for the backlog sitting in Rep to
// contact / Stuck, whatever its age).
async function allOpportunities(locationId: string, token: string) {
  const out: any[] = [];
  let query = `location_id=${encodeURIComponent(locationId)}&limit=100`;
  for (let page = 0; page < 60; page++) {
    const body = await ghl(`/opportunities/search?${query}`, token);
    const batch = body?.opportunities || [];
    out.push(...batch);
    if (!batch.length || batch.length < 100) break;
    const meta = body?.meta || {};
    if (meta.startAfterId && meta.startAfter != null) query = `location_id=${encodeURIComponent(locationId)}&limit=100&startAfterId=${encodeURIComponent(meta.startAfterId)}&startAfter=${encodeURIComponent(meta.startAfter)}`;
    else if (meta.nextPage) query = `location_id=${encodeURIComponent(locationId)}&limit=100&page=${encodeURIComponent(meta.nextPage)}`;
    else break;
  }
  return out;
}
// The stages Carmen works from: anyone sitting here gets a call.
const QUEUE_STAGE = /rep\s*to\s*contact|\bstuck\b/i;
const OPEN_FOLLOW = new Set(["new", "no_answer", "call_back"]);

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
// What a form submission holds besides the answers: who they are, and the
// tracking GHL and Facebook add. Matched loosely on the key.
const SUBMISSION_NOISE = /^(event_?data|fields_?ori|signature|form_?id|location_?id|contact_?id|id|type|product_?type|source|last_?attribution|attribution|facebook_?(lead_?id|form_?id|page|ad)|lead_?id|ad_?(set)?_?(id|name)|campaign|timezone|time_?zone|ip|user_?agent|session|captcha|recaptcha|page|url|referrer|medium|utm_|fbclid|gclid|full_?name|first_?name|last_?name|name|email|e_?mail|phone|phone_?number|mobile|terms|consent|privacy|submission|created|date_?added|is_?organic|platform|__)/i;
const ADDRESS_KEYS: Record<string, string> = { address: "street", address1: "street", street_address: "street", full_address: "street", street: "street", city: "city", suburb: "suburb", town: "city", postal_code: "postal", post_code: "postal", postcode: "postal", zip: "postal", zip_code: "postal", state: "state", region: "state", province: "state" };
const LOCATION_QUESTION = /(what|which)_(area|suburb|town|city|region)|suburb|where_(is|are|abouts)|whereabouts|location|located|property_in|address|postcode|post_code/;
// Facebook sends multiple-choice answers as slugs ("next_3_months").
const tidyAnswer = (a: string) => { const t = a.replace(/_+/g, " ").replace(/\s+/g, " ").trim(); return t === t.toLowerCase() ? t.charAt(0).toUpperCase() + t.slice(1) : t; };
const humanise = (k: string) => k.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase());
const keyOf = (k: string) => k.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

// Which ad they came from, out of GHL's attribution blobs (contact and
// submission). Key names vary, so match loosely.
function adInfoFrom(...blobs: any[]) {
  const out: Record<string, string> = {};
  const take = (k: string, v: any) => { const t = clean(valueText(v), 160); if (t && !out[k]) out[k] = t; };
  for (const b of blobs) {
    if (!b || typeof b !== "object") continue;
    for (const [k, v] of Object.entries(b)) {
      const lk = k.toLowerCase().replace(/[^a-z]/g, "");
      if (v && typeof v === "object") continue;
      if (/^(adid|fbadid|metaadid)$/.test(lk)) take("ad_id", v);
      else if (/^(adname|ad)$/.test(lk)) take("ad", v);
      else if (/^(adsetname|adset|adgroupname|adgroup)$/.test(lk)) take("adset", v);
      else if (/^(adsetid|adgroupid)$/.test(lk)) take("adset_id", v);
      else if (/^(campaignname|campaign|utmcampaign)$/.test(lk)) take("campaign", v);
      else if (/^(campaignid|utmcampaignid)$/.test(lk)) take("campaign_id", v);
      else if (/^(utmcontent)$/.test(lk)) take("content", v);
    }
  }
  return out;
}

// Every question/answer pair in a submission, whatever shape it's in:
// Facebook's field_data list ({ name, values }), a custom field list
// ({ id, value }), or plain key: value.
function submissionPairs(raw: any, names: Map<string, string>, out: { key: string; q: string; a: string }[] = [], depth = 0) {
  if (raw == null || depth > 4) return out;
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const key = String(item.name ?? item.key ?? item.fieldKey ?? item.field ?? item.id ?? item.question ?? item.label ?? "");
        const label = String(item.question ?? item.label ?? names.get(item.id) ?? names.get(key) ?? "");
        const value = item.values ?? item.value ?? item.answer ?? item.fieldValue;
        if (key || label) { const a = clean(valueText(value), 600); if (a) out.push({ key, q: label || humanise(key), a }); }
        else submissionPairs(item, names, out, depth + 1);
      }
    }
    return out;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) {
      if (/^(field_?data|fields|answers|custom_?fields|facebook_?lead_?submission_?details|lead_?details|data)$/i.test(k)) { submissionPairs(v, names, out, depth + 1); continue; }
      if (v && typeof v === "object" && !Array.isArray(v)) continue; // tracking blobs (eventData, attribution...)
      const a = clean(valueText(v), 600);
      if (a) out.push({ key: k, q: names.get(k) || humanise(k), a });
    }
  }
  return out;
}

// Address and form answers. Answers come from the contact's custom fields
// and from their most recent form submission (our clients' leads mostly come
// in through Facebook lead forms or GHL forms, which keep the answers on the
// submission).
async function contactDetails(id: string, token: string, fieldNames: () => Promise<Map<string, string>>, locationId: string) {
  const body = await ghl(`/contacts/${encodeURIComponent(id)}`, token);
  const c = body?.contact || body || {};
  const names = await fieldNames();
  const answers: { q: string; a: string }[] = (c.customFields || c.customField || [])
    .map((f: any) => ({ q: clean(names.get(f.id) || f.name || f.fieldKey || "", 120), a: clean(valueText(f.value ?? f.fieldValue), 600) }))
    .filter((x: any) => x.q && x.a);
  const place: Record<string, string> = { street: clean(c.address1, 200), city: clean(c.city, 80), suburb: "", postal: clean(c.postalCode, 20), state: clean(c.state, 60) };
  let formName = "", adInfo: Record<string, string> = adInfoFrom(c.attributionSource, c.lastAttributionSource);
  try {
    const subs = await ghl(`/forms/submissions?locationId=${encodeURIComponent(locationId)}&q=${encodeURIComponent(c.email || id)}&limit=10`, token);
    const mine = (subs?.submissions || []).filter((x: any) => !x.contactId || x.contactId === id)
      .sort((x: any, y: any) => String(y.createdAt || "").localeCompare(String(x.createdAt || "")))[0];
    const others = mine?.others || {};
    formName = clean(others.facebookFormName || mine?.name || "", 120);
    adInfo = { ...adInfoFrom(others.attributionSource, others.lastAttributionSource, others.facebookLeadSubmissionDetails), ...adInfo };
    for (const { key, q, a } of submissionPairs(others, names)) {
      const k = keyOf(key);
      if (ADDRESS_KEYS[k]) { if (!place[ADDRESS_KEYS[k]]) place[ADDRESS_KEYS[k]] = a; continue; }
      if (SUBMISSION_NOISE.test(k) || /^facebook_?form_?name$/.test(k)) continue;
      const label = clean(q, 120);
      // "What area is the property in?" and the like: that's where they are.
      if (LOCATION_QUESTION.test(k) && !place.suburb) place.suburb = a;
      if (label && !answers.some((x) => x.q.toLowerCase() === label.toLowerCase())) answers.push({ q: label, a: tidyAnswer(a) });
    }
  } catch { /* no Forms access on this key: custom fields only */ }
  const town = place.suburb || place.city;
  const city = clean([town, place.suburb && place.city !== place.suburb ? place.city : "", place.state].filter(Boolean).join(", "), 120);
  const address = clean([place.street, town, place.postal].filter(Boolean).join(", "), 240);
  if (formName) adInfo.form = formName;
  return { contact: c, answers, address, city, formName, adInfo };
}

// Leads read before form submissions were looked at get one more read.
// Leads read before Facebook form answers were understood get read again.
// Leads read before we looked for which ad they came from get read again -
// but not twice within half an hour, so every lead gets its turn.
const DETAILS_FROM_SUBMISSIONS = "2026-10-26T08:30:00Z";
const needsDetails = (r: any) => !r.details_at || (r.details_at < DETAILS_FROM_SUBMISSIONS && Date.now() - new Date(r.details_at).getTime() > 30 * 60e3);

async function syncClient(admin: any, conn: any, client: any, deadline: number) {
  const loc = conn.location_id, token = conn.token;
  const allOpps = await allOpportunities(loc, token);
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
  let stages: any = null;
  try {
    const pipes = (await ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(loc)}`, token))?.pipelines || [];
    for (const p of pipes) for (const s of p.stages || []) stageName.set(s.id, s.name || "");
    const { data: map } = await admin.from("lead_stage_map").select("*").eq("client_id", client.id).maybeSingle();
    stages = stageCheck(pipes, map);
  } catch { /* names are a nice-to-have */ }
  const inQueueStage = (o: any) => QUEUE_STAGE.test(stageName.get(o.pipelineStageId) || "");
  const closed = (o: any) => /^(won|lost|abandoned)$/i.test(String(o.status || ""));
  // New in the last few days, or sitting in Rep to contact / Stuck at any age.
  const windowStart = Date.now() - WINDOW_MS;
  const opps = allOpps.filter((o: any) => !closed(o) && (createdAt(o) >= windowStart || inQueueStage(o)));

  const { data: recent } = await admin.from("client_leads").select("id, external_lead_id, ghl_contact_id, phone, email, details_at, answers, address, city, follow_status, status")
    .eq("client_id", client.id).limit(20000);

  // Keep the queue in step with their pipeline: refresh each open lead's
  // stage, drop leads the client has already moved on from Rep to contact /
  // Stuck themselves, and bring older untouched leads back if they're
  // sitting in those stages. Leads Carmen has finished stay finished.
  const rowByExt = new Map((recent || []).map((r: any) => [r.external_lead_id, r]));
  for (const o of allOpps) {
    const r: any = rowByExt.get("ghl:" + o.id);
    if (!r) continue;
    const stage = stageName.get(o.pipelineStageId) || "";
    const patch: any = {};
    if (OPEN_FOLLOW.has(r.follow_status) && stage && stage !== r.status) patch.status = clean(stage, 100);
    if (OPEN_FOLLOW.has(r.follow_status) && QUEUE_STAGE.test(r.status || "") && (closed(o) || (stage && !QUEUE_STAGE.test(stage)))) { patch.follow_status = "in_ghl"; patch.next_attempt_at = null; }
    if ((r.follow_status === "old" || r.follow_status === "in_ghl") && !closed(o) && inQueueStage(o)) { patch.follow_status = "new"; patch.status = clean(stage, 100); }
    if (Object.keys(patch).length) { await admin.from("client_leads").update(patch).eq("id", r.id); Object.assign(r, patch); }
  }
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
      if (needsDetails(existing) && x.cid && reads < MAX_DETAIL_READS && Date.now() < deadline) {
        reads++;
        try {
          const d = await contactDetails(x.cid, token, fieldNames, loc);
          await admin.from("client_leads").update({ ghl_contact_id: x.cid, address: d.address || existing.address || null, city: d.city || existing.city || null, answers: d.answers, details_at: new Date().toISOString(), ad_info: d.adInfo || {}, ...(d.formName ? { form_name: d.formName } : {}) }).eq("id", existing.id);
        } catch { /* try again next run */ }
      }
      continue;
    }
    let c = x.c, d: any = null;
    if (x.cid && reads < MAX_DETAIL_READS && Date.now() < deadline) {
      reads++;
      try { d = await contactDetails(x.cid, token, fieldNames, loc); c = { ...c, ...d.contact }; } catch { d = null; }
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
      status: clean(x.status, 100), form_name: clean(d?.formName || x.form || "GoHighLevel", 120),
      address: d?.address || null, city: d?.city || null, answers: d?.answers || [], ad_info: d?.adInfo || {}, details_at: d ? new Date().toISOString() : null,
      lead_created_at: at, follow_status: "new",
    });
  }
  if (rows.length) {
    const { error } = await admin.from("client_leads").insert(rows);
    if (error) throw new Error(error.message);
    added = rows.length;
  }
  return { added, contactsAccess: contacts !== null, lastLead, stages };
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
        ...(r.stages ? { stages: r.stages } : {}),
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
          s.attribution_keys = { first: Object.keys(c.attributionSource || {}), last: Object.keys(c.lastAttributionSource || {}) };
          s.contact = { keys: Object.keys(c).sort(), custom_fields: cf.length, custom_filled: cf.filter((f: any) => valueText(f.value)).length, address1: Boolean(c.address1), city: Boolean(c.city), postal: Boolean(c.postalCode), tags: (c.tags || []).length, attribution: Boolean(c.attributionSource) };
        } catch (e) { s.contact = { error: (e as any)?.status || String(e).slice(0, 60) }; }
        try {
          const notes = (await ghl(`/contacts/${encodeURIComponent(cid)}/notes`, conn.token))?.notes || [];
          s.notes = { count: notes.length, longest: Math.max(0, ...notes.map((x: any) => String(x.body || "").length)) };
        } catch (e) { s.notes = { error: (e as any)?.status || String(e).slice(0, 60) }; }
        try {
          const subs = await ghl(`/forms/submissions?locationId=${encodeURIComponent(conn.location_id)}&q=${encodeURIComponent(cid)}&limit=5`, conn.token);
          const first = (subs?.submissions || [])[0], o = first?.others || {};
          const shape = (v: any) => Array.isArray(v) ? { array: v.length, item_keys: v[0] && typeof v[0] === "object" ? Object.keys(v[0]) : typeof v[0] } : v && typeof v === "object" ? { object_keys: Object.keys(v).slice(0, 20) } : typeof v;
          const names = new Map<string, string>();
          s.form_submissions = { count: (subs?.submissions || []).length, fb_details: shape(o.facebookLeadSubmissionDetails), custom_fields: shape(o.customFields),
            questions: submissionPairs(o, names).map((p) => keyOf(p.key)).filter((k) => !SUBMISSION_NOISE.test(k)).map((k) => k.slice(0, 50)) };
        } catch (e) { s.form_submissions = { error: (e as any)?.status || String(e).slice(0, 60) }; }
      }
      samples.push(s);
    }
    out.push({ client: n, samples });
  }
  return out;
}

// ───────── Call outcomes back into GoHighLevel ─────────
// What each of Carmen's outcomes does in the client's GHL:
//   site_visit / consult_call  -> move to that stage, and book it in their calendar
//   not_interested / disqualified / wrong_number -> move to Disqualified
//   call_back (call back later) -> move to Stuck
//   unreachable (5 calls, no answer) -> move to No answer
// The stage and calendar come from lead_stage_map when set for that client,
// otherwise the best match by name. Every move also leaves a note on the contact.
const CAL_VERSION = "2021-04-15";
const OUTCOME_STAGE: Record<string, "site_visit" | "consult" | "disqualified" | "no_answer" | "stuck"> = {
  site_visit: "site_visit", consult_call: "consult", not_interested: "disqualified", disqualified: "disqualified", wrong_number: "disqualified", unreachable: "no_answer", call_back: "stuck",
};
const STAGE_MATCH: Record<string, RegExp[]> = {
  site_visit: [/site\s*visit.*(booked|arranged|scheduled|confirmed)/i, /(booked|arranged|scheduled).*site\s*visit/i, /site\s*visit/i, /quote\s*(visit|booked|appointment)/i, /measure|appointment\s*booked/i],
  consult: [/consult.*(booked|scheduled|confirmed)/i, /consult/i, /(phone|discovery|zoom|video)\s*call/i, /call\s*booked/i],
  disqualified: [/disqual/i, /not\s*a\s*fit|unqualified|junk|spam/i],
  no_answer: [/no\s*answer/i, /unreach|no\s*response|unresponsive|not\s*answering|no\s*contact/i, /stuck/i],
  stuck: [/\bstuck\b/i, /call\s*back/i, /follow[\s-]*up/i],
};
const CAL_MATCH: Record<string, RegExp[]> = {
  site_visit: [/site|visit|quote|measure|onsite|on-site|inspection/i],
  consult: [/consult|call|phone|discovery|zoom|video/i],
};
// Does this client's GoHighLevel have every stage the calling flow uses?
// found = the stage each one goes to (their pick under Stages, else the best
// name match, first pipeline first); missing = ones with nowhere to go.
const FLOW_KINDS = ["rep_to_contact", "site_visit", "consult", "disqualified", "stuck", "no_answer"];
function stageCheck(pipes: any[], map: any) {
  const all = pipes.flatMap((p: any) => (p.stages || []).map((st: any) => ({ id: st.id, name: st.name || "" })));
  const main = (pipes[0]?.stages || []).map((st: any) => ({ id: st.id, name: st.name || "" }));
  const found: Record<string, string> = {}, missing: string[] = [];
  for (const k of FLOW_KINDS) {
    const picked = map?.[k + "_stage"] && all.find((st: any) => st.id === map[k + "_stage"]);
    const hit = k === "rep_to_contact" ? all.find((st: any) => /rep\s*to\s*contact/i.test(st.name))
      : picked || bestStage(main, k) || bestStage(all, k);
    if (hit) found[k] = hit.name; else missing.push(k);
  }
  return { found, missing, pipelines: pipes.length, checked_at: new Date().toISOString() };
}
function bestStage(stages: any[], kind: string) {
  for (const re of STAGE_MATCH[kind] || []) { const hit = stages.find((st: any) => re.test(st.name || "") && !/to\s*be\s*booked|not\s*booked/i.test(st.name || "")); if (hit) return hit; }
  return null;
}
function bestCalendar(cals: any[], kind: string) {
  for (const re of CAL_MATCH[kind] || []) { const hit = cals.find((c: any) => re.test(c.name || "")); if (hit) return hit; }
  return cals.length === 1 ? cals[0] : null;
}

// The pipelines and calendars of a client's GHL, with what we'd match to
// each outcome - for the Results page's "Stages" picker.
async function clientSetup(admin: any, clientId: string) {
  const { data: conn } = await admin.from("client_ghl").select("location_id, token").eq("client_id", clientId).maybeSingle();
  if (!conn) return { error: "This client isn't connected to GoHighLevel yet." };
  const pipes = (await ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(conn.location_id)}`, conn.token))?.pipelines || [];
  let calendars: any[] = [], calendarError = null;
  try { calendars = (await ghl(`/calendars/?locationId=${encodeURIComponent(conn.location_id)}`, conn.token, {}, CAL_VERSION))?.calendars || []; }
  catch (e) { calendarError = (e as any)?.status === 401 || (e as any)?.status === 403 ? "The key can't see calendars - tick View Calendars and Edit Calendar Events on it." : String((e as any)?.message || e); }
  const { data: map } = await admin.from("lead_stage_map").select("*").eq("client_id", clientId).maybeSingle();
  const allStages = pipes.flatMap((p: any) => (p.stages || []).map((st: any) => ({ id: st.id, name: st.name, pipeline: p.name, pipeline_id: p.id })));
  const main = pipes[0]?.stages || [];
  const suggest: any = {};
  for (const k of ["site_visit", "consult", "disqualified", "no_answer", "stuck"]) suggest[k + "_stage"] = bestStage(main, k)?.id || bestStage(allStages, k)?.id || null;
  for (const k of ["site_visit", "consult"]) suggest[k + "_calendar"] = bestCalendar(calendars, k)?.id || null;
  return { stages: allStages, calendars: calendars.map((c: any) => ({ id: c.id, name: c.name })), calendar_error: calendarError, map: map || {}, suggest };
}

async function applyOutcome(admin: any, leadId: string, outcome: string, when: string | null, note: string, by: string) {
  const kind = OUTCOME_STAGE[outcome];
  if (!kind) return { skipped: true };
  const { data: lead } = await admin.from("client_leads").select("id, client_id, name, external_lead_id, ghl_contact_id").eq("id", leadId).maybeSingle();
  if (!lead) return { error: "Lead not found." };
  const isGhl = String(lead.external_lead_id || "").startsWith("ghl");
  if (!isGhl && !lead.ghl_contact_id) return { skipped: true, reason: "This lead didn't come from GoHighLevel." };
  const { data: conn } = await admin.from("client_ghl").select("location_id, token").eq("client_id", lead.client_id).maybeSingle();
  if (!conn) return { error: "This client isn't connected to GoHighLevel." };
  const { data: map } = await admin.from("lead_stage_map").select("*").eq("client_id", lead.client_id).maybeSingle();
  const result: any = { at: new Date().toISOString(), outcome, errors: [] as string[] };
  const loc = conn.location_id, token = conn.token;
  const oppId = String(lead.external_lead_id).startsWith("ghl:") ? String(lead.external_lead_id).slice(4) : null;
  let contactId = lead.ghl_contact_id || (String(lead.external_lead_id).startsWith("ghlc:") ? String(lead.external_lead_id).slice(5) : null);

  // Which stage: the client's pick, else the best match in the lead's own pipeline.
  try {
    const pipes = (await ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(loc)}`, token))?.pipelines || [];
    let opp: any = null;
    if (oppId) { opp = (await ghl(`/opportunities/${encodeURIComponent(oppId)}`, token))?.opportunity || null; contactId = contactId || opp?.contactId; }
    const pipe = pipes.find((p: any) => p.id === opp?.pipelineId) || pipes[0];
    const picked = map?.[kind + "_stage"];
    const all = pipes.flatMap((p: any) => (p.stages || []).map((st: any) => ({ ...st, pipeline_id: p.id })));
    const stage = (picked && all.find((st: any) => st.id === picked)) || bestStage((pipe?.stages || []).map((st: any) => ({ ...st, pipeline_id: pipe.id })), kind);
    const KIND_NAME: Record<string, string> = { site_visit: "Site visit booked", consult: "Consultation call booked", disqualified: "Disqualified", no_answer: "No answer", stuck: "Stuck" };
    if (!stage) result.errors.push(`Couldn't find a "${KIND_NAME[kind]}" stage in their pipeline - pick one under Stages on the Results page.`);
    else if (opp) {
      await ghl(`/opportunities/${encodeURIComponent(opp.id)}`, token, { method: "PUT", body: JSON.stringify({ pipelineId: stage.pipeline_id, pipelineStageId: stage.id, status: "open" }) });
      result.stage = stage.name; result.moved = true;
    } else if (contactId) {
      const made = await ghl(`/opportunities/`, token, { method: "POST", body: JSON.stringify({ locationId: loc, pipelineId: stage.pipeline_id, pipelineStageId: stage.id, contactId, name: lead.name || "New lead", status: "open" }) });
      result.stage = stage.name; result.moved = true; result.created_opportunity = made?.opportunity?.id || true;
    }
  } catch (e) { result.errors.push("Couldn't move the stage: " + String((e as any)?.message || e).slice(0, 160)); }

  // Bookings go in their calendar too.
  if ((kind === "site_visit" || kind === "consult") && when && contactId) {
    try {
      const cals = (await ghl(`/calendars/?locationId=${encodeURIComponent(loc)}`, token, {}, CAL_VERSION))?.calendars || [];
      const picked = map?.[kind + "_calendar"];
      const cal = (picked && cals.find((c: any) => c.id === picked)) || bestCalendar(cals, kind);
      if (!cal) result.errors.push(`No calendar found for a ${kind === "consult" ? "consultation call" : "site visit"} - pick one under Stages on the Results page.`);
      else {
        const mins = Number(cal.slotDuration) && /hour/i.test(String(cal.slotDurationUnit || "")) ? Number(cal.slotDuration) * 60 : Number(cal.slotDuration) || (kind === "consult" ? 30 : 60);
        const start = new Date(when), end = new Date(start.getTime() + mins * 60e3);
        const appt = await ghl(`/calendars/events/appointments`, token, { method: "POST", body: JSON.stringify({
          calendarId: cal.id, locationId: loc, contactId, startTime: start.toISOString(), endTime: end.toISOString(),
          title: `${kind === "consult" ? "Consultation call" : "Site visit"} - ${lead.name || "new lead"}`, appointmentStatus: "confirmed", ignoreFreeSlotValidation: true, toNotify: true,
        }) }, CAL_VERSION);
        result.appointment = appt?.id || appt?.appointment?.id || true; result.calendar = cal.name;
      }
    } catch (e) { result.errors.push("Couldn't book it in their calendar: " + String((e as any)?.message || e).slice(0, 160)); }
  }

  // Leave Carmen's notes on the contact so the client sees them.
  if (contactId) {
    const label: Record<string, string> = { site_visit: "Site visit booked", consult_call: "Consultation call booked", not_interested: "Not interested", disqualified: "Not a fit", wrong_number: "Wrong number", unreachable: "No answer after 5 calls", call_back: "Call back" };
    const whenText = when ? ` for ${new Date(when).toLocaleString("en-NZ", { timeZone: "Pacific/Auckland", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}` : "";
    try { await ghl(`/contacts/${encodeURIComponent(contactId)}/notes`, token, { method: "POST", body: JSON.stringify({ body: `${label[outcome] || outcome}${whenText} - called by ${by} (Mr Priceless).${note ? "\n\n" + note : ""}` }) }); result.note = true; }
    catch { /* a note is a nice-to-have */ }
  }
  if (!result.errors.length) delete result.errors;
  await admin.from("client_leads").update({ ghl_sync: result }).eq("id", lead.id);
  return result;
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
  if (body.action === "outcome"){
    if (!body.lead_id || !body.outcome) return json({ error: "lead_id and outcome are needed." }, 400);
    const who = String(email).split("@")[0].split(/[._0-9]/)[0];
    return json(await applyOutcome(admin, body.lead_id, body.outcome, body.when || null, String(body.note || "").slice(0, 2000), who.charAt(0).toUpperCase() + who.slice(1)));
  }
  if (body.action === "setup"){
    if (!body.client_id) return json({ error: "client_id is needed." }, 400);
    try { return json(await clientSetup(admin, body.client_id)); } catch (e) { return json({ error: String((e as any)?.message || e) }); }
  }
  return json({ error: "Unknown action." }, 400);
});
