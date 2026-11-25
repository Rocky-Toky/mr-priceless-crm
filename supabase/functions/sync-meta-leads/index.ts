// Edge Function: sync-meta-leads
// Copies Mr Priceless's own Facebook / Instagram lead-form enquiries (the ones
// in Meta's Leads Center) into inbound_leads, for Sales → Inbound leads.
//
//   Scheduled (sql/116 pg_cron, every 5 minutes, only once a page is picked):
//     header x-cron-secret matches app_secrets.inbound_cron_secret.
//   Signed-in allowlisted user:
//     { action: "pages" }              the Facebook pages the token can see
//     { action: "pick", page_ids }     which page(s) the leads come from
//     { action: "sync" }               copy new leads in now
//
// Uses the META_SYSTEM_USER_TOKEN function secret (the same one sync-client-ads
// uses). For leads it needs the Mr Priceless page assigned to that system user
// and the leads_retrieval, pages_show_list, pages_read_engagement and
// pages_manage_ads permissions. Each run re-reads the last 2 hours; the first
// run catches up on 90 days. Logs carry counts only.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const GRAPH = "https://graph.facebook.com/v21.0";
const FIRST_RUN_MS = 90 * 86400e3;
const OVERLAP_MS = 2 * 3600e3;
const RUN_BUDGET_MS = 100e3;

async function graph(path: string, params: Record<string, string>, token: string) {
  const q = new URLSearchParams({ ...params, access_token: token });
  const res = await fetch(`${GRAPH}/${path}?${q}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) throw new Error(plainMetaError(body?.error, res.status));
  return body;
}
async function graphAll(path: string, params: Record<string, string>, token: string, maxPages = 20) {
  const out: any[] = [];
  let body = await graph(path, params, token);
  for (let i = 0; i < maxPages; i++) {
    out.push(...(Array.isArray(body?.data) ? body.data : []));
    const next = body?.paging?.next;
    if (!next) break;
    const res = await fetch(next);
    body = await res.json().catch(() => ({}));
    if (!res.ok || body?.error) throw new Error(plainMetaError(body?.error, res.status));
  }
  return out;
}
// Meta's errors, in words Rocky can act on.
export function plainMetaError(e: any, status: number) {
  const msg = String(e?.message || `Meta returned ${status}`);
  const code = Number(e?.code);
  if (code === 190) return "The Meta token has expired or been changed - make a new one (see the setup steps).";
  if (/leads_retrieval/i.test(msg) || (code === 200 && /lead/i.test(msg))) return "The Meta token can't read leads yet - it needs the leads_retrieval permission and Leads Access for the CRM (see the setup steps).";
  if (code === 10 || code === 200) return "The Meta token doesn't have permission for this page yet - assign the page to the system user (see the setup steps).";
  return msg.slice(0, 200);
}

// The lead form's answers, tidied: Meta keys like "what_trade_are_you_in?" → "What trade are you in?"
const tidyQ = (k: string) => { const t = String(k || "").replace(/_/g, " ").replace(/\s+/g, " ").trim(); return t ? t[0].toUpperCase() + t.slice(1) : ""; };
export function leadRow(l: any, pageId: string, formName: string) {
  const answers = (Array.isArray(l.field_data) ? l.field_data : []).map((f: any) => ({ key: String(f.name || ""), q: tidyQ(f.name), a: (Array.isArray(f.values) ? f.values : []).join(", ") }));
  const pick = (re: RegExp) => answers.find((x: any) => re.test(x.key))?.a || null;
  const first = pick(/^first_?name$/i), last = pick(/^last_?name$/i);
  return {
    meta_lead_id: String(l.id),
    created_at: l.created_time ? new Date(l.created_time).toISOString() : new Date().toISOString(),
    page_id: pageId,
    form_id: l.form_id ? String(l.form_id) : null,
    form_name: formName || null,
    ad_id: l.ad_id ? String(l.ad_id) : null,
    ad_name: l.ad_name || null,
    campaign_name: l.campaign_name || null,
    name: pick(/^full_?name$|^name$/i) || [first, last].filter(Boolean).join(" ") || null,
    phone: pick(/phone/i),
    email: pick(/e-?mail/i),
    business: pick(/company|business/i),
    answers: answers.filter((x: any) => !/^(full_?name|first_?name|last_?name|name|phone.*|e-?mail)$/i.test(x.key)).map(({ q, a }: any) => ({ q, a })),
    synced_at: new Date().toISOString(),
  };
}

const token = () => Deno.env.get("META_SYSTEM_USER_TOKEN") || "";
async function setStatus(admin: any, patch: Record<string, unknown>) {
  await admin.from("inbound_settings").upsert({ id: 1, ...patch, updated_at: new Date().toISOString() });
}

// The pages this token can see, with their own page tokens (needed to read leads).
async function pageList(t: string) {
  const pages = await graphAll("me/accounts", { fields: "id,name,access_token", limit: "100" }, t, 5);
  return pages.map((p: any) => ({ id: String(p.id), name: String(p.name || p.id), token: String(p.access_token || "") }));
}

export async function listPages(admin: any) {
  const t = token();
  if (!t) return { error: "The Meta token isn't set up on the CRM yet (see the setup steps)." };
  try {
    const pages = (await pageList(t)).map(({ id, name }) => ({ id, name }));
    await setStatus(admin, { pages, last_error: pages.length ? null : "The Meta token can't see any Facebook pages - assign the Mr Priceless page to the system user (see the setup steps)." });
    return { pages };
  } catch (e) {
    const msg = String((e as any)?.message || e);
    await setStatus(admin, { last_error: msg });
    return { error: msg };
  }
}

export async function syncLeads(admin: any) {
  const t = token();
  if (!t) { await setStatus(admin, { last_error: "The Meta token isn't set up on the CRM yet (see the setup steps)." }); return { connected: false }; }
  const started = Date.now();
  const { data: st } = await admin.from("inbound_settings").select("page_ids, cursor_at").eq("id", 1).maybeSingle();
  const picked: string[] = st?.page_ids || [];
  if (!picked.length) return { picked: 0 };
  const sinceMs = st?.cursor_at ? new Date(st.cursor_at).getTime() - OVERLAP_MS : Date.now() - FIRST_RUN_MS;
  const runAt = new Date().toISOString();
  try {
    const pages = (await pageList(t)).filter(p => picked.includes(p.id));
    if (!pages.length) throw new Error("The Meta token can't see the picked Facebook page any more - check the page is still assigned to the system user.");
    let saved = 0, forms = 0, complete = true;
    for (const p of pages) {
      const pt = p.token || t;
      const fl = await graphAll(`${p.id}/leadgen_forms`, { fields: "id,name,status", limit: "100" }, pt, 5);
      for (const f of fl) {
        if (Date.now() - started > RUN_BUDGET_MS) { complete = false; break; }
        forms++;
        const leads = await graphAll(`${f.id}/leads`, {
          fields: "id,created_time,field_data,ad_id,ad_name,campaign_name,form_id",
          filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: Math.floor(sinceMs / 1000) }]),
          limit: "100",
        }, pt);
        if (!leads.length) continue;
        const rows = leads.map((l: any) => leadRow(l, p.id, f.name));
        // New leads only: anything already here keeps the team's status and notes.
        const { data, error } = await admin.from("inbound_leads").upsert(rows, { onConflict: "meta_lead_id", ignoreDuplicates: true }).select("id");
        if (error) throw new Error("Couldn't save the leads: " + error.message);
        saved += (data || []).length;
      }
    }
    await setStatus(admin, { ...(complete ? { cursor_at: runAt } : {}), last_ok_at: runAt, last_error: null });
    console.log(`meta leads: ${saved} new from ${forms} form(s)`);
    return { saved, forms };
  } catch (e) {
    const msg = String((e as any)?.message || e).slice(0, 300);
    await setStatus(admin, { last_error: msg });
    console.log("meta leads sync failed: " + msg);
    return { error: msg };
  }
}

// ───────── Clients' own Pages (taking GoHighLevel out, 25 Nov 2026) ─────────
// For each client with a Meta ad account: which Page(s) their ads run under,
// whether our token can read that Page's lead forms (the Page needs to be
// shared with our system user, with leads access), how many forms, and how
// many leads Meta has had in 30 days. Saved to client_meta_pages (sql/121).
const actId = (raw: string) => { const t = String(raw || "").trim(); return t.startsWith("act_") ? t : `act_${t}`; };
async function clientPages(act: string, t: string): Promise<{ id: string; name: string }[]> {
  const found = new Map<string, string>();
  try {
    const pp = await graphAll(`${act}/promote_pages`, { fields: "id,name", limit: "50" }, t, 2);
    pp.forEach((p: any) => found.set(String(p.id), String(p.name || p.id)));
  } catch (_e) { /* fall back to the ads themselves */ }
  if (!found.size) {
    try {
      const ads = await graphAll(`${act}/ads`, { fields: "creative{effective_object_story_id,object_story_spec}", limit: "50" }, t, 2);
      for (const a of ads) {
        const pid = a?.creative?.object_story_spec?.page_id || String(a?.creative?.effective_object_story_id || "").split("_")[0];
        if (pid && /^\d{5,25}$/.test(String(pid))) found.set(String(pid), found.get(String(pid)) || String(pid));
      }
    } catch (_e) { /* nothing more we can do */ }
  }
  return [...found].map(([id, name]) => ({ id, name }));
}
export async function clientCheck(admin: any) {
  const t = token();
  if (!t) return { error: "The Meta token isn't set up on the CRM yet." };
  const started = Date.now();
  const { data: clients } = await admin.from("clients").select("id, meta_ad_account_id, stage").not("meta_ad_account_id", "is", null).neq("meta_ad_account_id", "");
  let mine: { id: string; name: string; token: string }[] = [];
  try { mine = await pageList(t); } catch (_e) { mine = []; }
  const since = Math.floor((Date.now() - 30 * 86400e3) / 1000);
  let pages = 0, readable = 0, notReadable = 0, noPage = 0, n = 0;
  for (const c of clients || []) {
    if (c.stage === "churned") continue;
    if (Date.now() - started > 240e3) break;
    n++;
    const found = await clientPages(actId(c.meta_ad_account_id), t);
    const rows: any[] = [];
    if (!found.length) {
      noPage++;
      rows.push({ client_id: c.id, page_id: "", page_name: null, can_read: false, forms: null, meta_leads_30d: null, error: "Couldn't find which Facebook Page their ads run under", checked_at: new Date().toISOString() });
    }
    for (const pg of found) {
      pages++;
      const shared = mine.find(m => m.id === pg.id);
      const row: any = { client_id: c.id, page_id: pg.id, page_name: shared?.name || pg.name, can_read: false, forms: null, meta_leads_30d: null, error: null, checked_at: new Date().toISOString() };
      if (!shared) row.error = "Page isn't shared with our Meta system user yet";
      else {
        try {
          const forms = await graphAll(`${pg.id}/leadgen_forms`, { fields: "id,name,status", limit: "100" }, shared.token || t, 3);
          row.forms = forms.length;
          let count = 0;
          for (const f of forms.slice(0, 25)) {
            const leads = await graphAll(`${f.id}/leads`, { fields: "id", limit: "100", filtering: JSON.stringify([{ field: "time_created", operator: "GREATER_THAN", value: since }]) }, shared.token || t, 5);
            count += leads.length;
          }
          row.meta_leads_30d = count; row.can_read = true;
        } catch (e) { row.error = String((e as any)?.message || e).slice(0, 200); }
      }
      row.can_read ? readable++ : notReadable++;
      rows.push(row);
    }
    await admin.from("client_meta_pages").delete().eq("client_id", c.id);
    if (rows.length) await admin.from("client_meta_pages").insert(rows);
  }
  console.log(`client pages: ${n} clients, ${pages} pages, ${readable} readable, ${notReadable} not, ${noPage} with no page`);
  return { clients: n, pages, readable, not_readable: notReadable, no_page: noPage };
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
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "inbound_cron_secret").maybeSingle();
    if (!secret?.value || secret.value !== cronHeader) return json({ error: "Unauthorized." }, 401);
    let cb: any = {};
    try { cb = (await req.json()) ?? {}; } catch { cb = {}; }
    if (cb.action === "client_check") return json(await clientCheck(admin));
    return json(await syncLeads(admin));
  }

  // The team only (full access; Lead Follow Up only logins and client logins are refused).
  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const email = userData?.user?.email;
  if (!email) return json({ error: "Unauthorized." }, 401);
  const { data: allowed } = await admin.from("allowlist").select("email, access").ilike("email", email).maybeSingle();
  if (!allowed || (allowed.access && allowed.access !== "full")) return json({ error: "Unauthorized." }, 401);
  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }
  if (body.action === "pages") return json(await listPages(admin));
  if (body.action === "pick") {
    const ids = (Array.isArray(body.page_ids) ? body.page_ids : []).map((x: unknown) => String(x)).filter((x: string) => /^\d{5,25}$/.test(x)).slice(0, 5);
    await setStatus(admin, { page_ids: ids, cursor_at: null, last_error: null });
    return json(ids.length ? await syncLeads(admin) : { picked: 0 });
  }
  if (body.action === "sync") return json(await syncLeads(admin));
  if (body.action === "client_check") return json(await clientCheck(admin));
  return json({ error: "Unknown action." }, 400);
});
