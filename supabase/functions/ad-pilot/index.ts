// Edge Function: ad-pilot (stage 1, Rocky 28 Nov 2026)
// Claude looks after every client's Meta ads through Meta's official Marketing
// API (the same META_SYSTEM_USER_TOKEN sync-client-ads uses).
//
//   Scheduled (sql/131 pg_cron, mornings NZ): header x-cron-secret matches
//     app_secrets.adpilot_cron_secret -> { action: "review" } reviews every
//     client with a Meta ad account not reviewed in the last 20 hours, as many
//     as fit in one run (the next run picks up the rest).
//   Signed-in full-access team member:
//     { action: "access" }               can our Meta connection change ads?
//     { action: "review", client_id }    review one client now
//     { action: "apply", id }            approve a suggestion: make it on Meta
//
// Each review: read the account (campaigns, ad sets + budgets, ads, 7 / 30-day
// numbers) and the quotes / jobs those ads made in the client's app -> Claude
// suggests changes (structured output) -> every suggestion passes the hard
// limits in logic.ts -> saved in ad_actions. With the client's auto switched
// on, low-risk ones are made straight away. Claude's lessons go in ad_playbook.
// Logs carry counts only.

import { createClient } from "npm:@supabase/supabase-js@2";
import { makeClaude } from "../creative-agent/claude.ts";
import { check, REVIEW_SCHEMA, summarise, SYSTEM, monthPace, type Settings, type Suggestion } from "./logic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const GRAPH = "https://graph.facebook.com/v21.0";
const RUN_BUDGET_MS = 120e3;

function plainMetaError(e: any, status: number) {
  const msg = String(e?.message || `Meta returned ${status}`);
  const code = Number(e?.code);
  if (code === 190) return "The Meta token has expired or been changed - make a new one.";
  if (code === 200 || code === 10 || /ads_management|permission/i.test(msg)) return "Our Meta connection isn't allowed to change ads yet - it needs the ads_management permission (see Ad pilot setup).";
  if (code === 100 && /budget/i.test(msg)) return `Meta wouldn't take that budget: ${msg.slice(0, 160)}`;
  return msg.slice(0, 200);
}
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
async function graphPost(path: string, params: Record<string, string>, token: string) {
  const res = await fetch(`${GRAPH}/${path}`, { method: "POST", body: new URLSearchParams({ ...params, access_token: token }) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body?.error) throw new Error(plainMetaError(body?.error, res.status));
  return body;
}
const actOf = (id: string) => (String(id).startsWith("act_") ? String(id) : `act_${String(id).replace(/\D/g, "")}`);
const statusFilter = (v: string[]) => JSON.stringify([{ field: "effective_status", operator: "IN", value: v }]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const URL_ = Deno.env.get("SUPABASE_URL")!, SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
  const META = Deno.env.get("META_SYSTEM_USER_TOKEN") || "";
  const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }

  // Who's calling: the morning cron, or a full-access team member.
  let who = "Automatic";
  const cronHeader = req.headers.get("x-cron-secret") || "";
  let isCron = false;
  if (cronHeader) {
    const { data: s } = await admin.from("app_secrets").select("value").eq("name", "adpilot_cron_secret").maybeSingle();
    isCron = !!s?.value && s.value === cronHeader;
    if (!isCron) return json({ error: "Unauthorized." }, 401);
  } else {
    const authed = createClient(URL_, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
    const { data: u } = await authed.auth.getUser();
    const email = u?.user?.email;
    if (!email) return json({ error: "Unauthorized." }, 401);
    const { data: allow } = await admin.from("allowlist").select("email, access").eq("email", email).maybeSingle();
    if (!allow || allow.access === "leads") return json({ error: "Unauthorized." }, 401);
    const { data: emp } = await admin.from("employees").select("name").ilike("email", email).maybeSingle();
    who = emp?.name || email.split("@")[0];
  }
  if (!META) return json({ error: "The Meta token (META_SYSTEM_USER_TOKEN) isn't set up." }, 400);

  const action = body.action || "review";
  try {
    if (action === "access") return json(await checkAccess(admin, META));
    if (action === "apply") return json(await applyAction(admin, META, String(body.id || ""), who));
    if (action === "review") {
      const apiKey = Deno.env.get("ANTHROPIC_API_KEY") || "";
      if (!apiKey) return json({ error: "The Claude API key (ANTHROPIC_API_KEY) isn't set up." }, 400);
      const claude = makeClaude(apiKey);
      const model = Deno.env.get("CLAUDE_MODEL_ADS") || "claude-opus-5-5";
      const status = await checkAccess(admin, META).catch(() => ({ can_manage: false }));
      if (!isCron) {
        if (!body.client_id) return json({ error: "client_id is required." }, 400);
        const r = await reviewClient(admin, META, claude, model, String(body.client_id), status.can_manage);
        return json(r);
      }
      // Cron: everyone with an ad account not reviewed in 20 hours, while time lasts.
      const started = Date.now();
      const { data: clients } = await admin.from("clients").select("id, stage, is_test, meta_ad_account_id")
        .not("meta_ad_account_id", "is", null).neq("meta_ad_account_id", "");
      const { data: recent } = await admin.from("ad_reviews").select("client_id").gte("created_at", new Date(Date.now() - 20 * 3600e3).toISOString());
      const done = new Set((recent || []).map((r: any) => r.client_id));
      const todo = (clients || []).filter((c: any) => !c.is_test && !["archived", "churned"].includes(c.stage || "") && !done.has(c.id));
      let reviewed = 0, suggested = 0, auto = 0, failed = 0;
      for (const c of todo) {
        if (Date.now() - started > RUN_BUDGET_MS) break;
        const r = await reviewClient(admin, META, claude, model, c.id, status.can_manage);
        if (r.error) failed++; else { reviewed++; suggested += r.suggested || 0; auto += r.auto || 0; }
      }
      await admin.from("ad_pilot_status").update({ last_run_at: new Date().toISOString(), last_error: failed ? `${failed} client review(s) failed` : null }).eq("id", 1);
      return json({ ok: true, reviewed, suggested, auto, failed, left: Math.max(0, todo.length - reviewed - failed) });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

// Can our Meta connection change ads, or only read them?
async function checkAccess(admin: any, token: string) {
  let perms: string[] = [], err: string | null = null;
  try {
    const r = await graph("me/permissions", {}, token);
    perms = (r?.data || []).filter((p: any) => p.status === "granted").map((p: any) => String(p.permission));
  } catch (e) { err = e instanceof Error ? e.message : String(e); }
  const can_manage = perms.includes("ads_management");
  await admin.from("ad_pilot_status").update({ meta_perms: perms, meta_can_manage: can_manage, checked_at: new Date().toISOString(), last_error: err }).eq("id", 1);
  return { ok: !err, can_manage, perms, error: err };
}

// One client's review.
async function reviewClient(admin: any, token: string, claude: any, model: string, clientId: string, canManage: boolean) {
  const { data: c } = await admin.from("clients").select("id, name, industry, meta_ad_account_id, ad_start_date").eq("id", clientId).maybeSingle();
  if (!c?.meta_ad_account_id) return { error: "This client has no Meta ad account ID." };
  const act = actOf(c.meta_ad_account_id);
  const { data: st } = await admin.from("ad_pilot_settings").select("*").eq("client_id", clientId).maybeSingle();
  const settings: Settings = st || {};
  try {
    const [campaigns, adsets, ads, ins7, ins30, month] = await Promise.all([
      graphAll(`${act}/campaigns`, { fields: "id,name,effective_status,daily_budget,lifetime_budget,objective", filtering: statusFilter(["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES"]), limit: "200" }, token),
      graphAll(`${act}/adsets`, { fields: "id,name,campaign_id,effective_status,daily_budget,lifetime_budget", filtering: statusFilter(["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "IN_PROCESS", "WITH_ISSUES"]), limit: "200" }, token),
      graphAll(`${act}/ads`, { fields: "id,name,adset_id,campaign_id,effective_status", filtering: statusFilter(["ACTIVE", "PAUSED", "ADSET_PAUSED", "CAMPAIGN_PAUSED", "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW", "DISAPPROVED"]), limit: "300" }, token),
      graphAll(`${act}/insights`, { level: "ad", date_preset: "last_7d", fields: "ad_id,spend,impressions,clicks,actions", limit: "500" }, token),
      graphAll(`${act}/insights`, { level: "ad", date_preset: "last_30d", fields: "ad_id,spend,impressions,clicks,actions", limit: "500" }, token),
      graphAll(`${act}/insights`, { level: "account", date_preset: "this_month", fields: "spend", limit: "5" }, token),
    ]);
    // Quotes / jobs those ads made in the client's app (30 days).
    const { data: leads } = await admin.from("client_leads").select("ad_info, client_stage, quote_amount, job_value")
      .eq("client_id", clientId).gte("created_at", new Date(Date.now() - 30 * 864e5).toISOString()).limit(2000);
    const crm: Record<string, { leads: number; quotes: number; won: number }> = {};
    for (const l of leads || []) {
      const id = String(l?.ad_info?.ad_id || "");
      if (!id) continue;
      const x = (crm[id] ||= { leads: 0, quotes: 0, won: 0 });
      x.leads++;
      if (["quote_sent", "won"].includes(l.client_stage) || l.quote_amount) x.quotes++;
      if (l.client_stage === "won" || l.job_value) x.won++;
    }
    const sum = summarise({ campaigns, adsets, ads, ins7, ins30, crm });
    const spentMonth = Number(month?.[0]?.spend || 0);
    const pace = monthPace(spentMonth, settings.monthly_budget);
    const [{ data: lessons }, { data: past }] = await Promise.all([
      admin.from("ad_playbook").select("lesson, client_id, source").eq("active", true).or(`client_id.is.null,client_id.eq.${clientId}`).order("created_at", { ascending: false }).limit(40),
      admin.from("ad_actions").select("created_at, kind, target_name, new_value, status, auto, note, reason").eq("client_id", clientId).neq("status", "expired").order("created_at", { ascending: false }).limit(20),
    ]);
    const input = {
      client: { name: c.name, trade: c.industry || null, ads_started: c.ad_start_date || null, account_id: act },
      limits: { biggest_budget_move_pct: Math.min(50, Math.max(5, Number(settings.max_change_pct) || 20)), max_daily_budget: settings.max_daily_budget ?? null },
      goals: { target_cost_per_lead: settings.target_cpl ?? null, monthly_budget: settings.monthly_budget ?? null, spent_this_month: Math.round(spentMonth), month_pace: pace },
      team_notes: settings.notes || null,
      playbook: (lessons || []).map((l: any) => (l.client_id ? "[this client] " : "") + l.lesson),
      recent_decisions: (past || []).map((p: any) => ({ when: String(p.created_at).slice(0, 10), what: `${p.kind} ${p.target_name || ""}${p.new_value ? " -> $" + p.new_value : ""}`, result: p.auto ? "done automatically" : p.status, team_note: p.note || undefined })),
      account: sum,
    };
    const r = await claude({
      model, effort: "medium", maxTokens: 8000, schema: REVIEW_SCHEMA,
      system: [{ text: SYSTEM, cache: true }],
      messages: [{ role: "user", content: `Today's review. Data (JSON):\n${JSON.stringify(input)}` }],
    });
    const out = r.data || {};
    const { data: review } = await admin.from("ad_reviews").insert({
      client_id: clientId, summary: String(out.summary || "").slice(0, 1200), health: ["good", "watch", "bad"].includes(out.health) ? out.health : "watch",
      stats: { ...sum.totals, live_ads: sum.live_ads, spent_this_month: Math.round(spentMonth), month_pace: pace, adsets: sum.adsets, ads: sum.ads.slice(0, 80) },
      model: r.model, cost_usd: r.cost_usd,
    }).select("id").single();
    // Fresh numbers replace yesterday's open suggestions.
    await admin.from("ad_actions").update({ status: "expired" }).eq("client_id", clientId).eq("status", "suggested");
    let suggested = 0, auto = 0;
    for (const s of (out.suggestions || []) as Suggestion[]) {
      const ok = check(s, sum, settings, act);
      if (!ok) continue;
      const { data: row } = await admin.from("ad_actions").insert({
        client_id: clientId, kind: ok.kind, target_type: ok.target_type, target_id: ok.target_id, target_name: ok.target_name,
        current_value: ok.current_value, new_value: ok.new_value, reason: String(ok.reason || "").slice(0, 600), impact: String(ok.impact || "").slice(0, 300),
        risk: ok.autoOk ? "low" : "high", review_id: review?.id || null,
      }).select("id").single();
      suggested++;
      if (row && ok.autoOk && settings.auto_on && canManage && ok.kind !== "flag") {
        const res = await applyAction(admin, token, row.id, "Automatic", true);
        if (res.ok) auto++;
      }
    }
    for (const lesson of ((out.lessons || []) as string[]).slice(0, 2)) {
      const text = String(lesson || "").trim().slice(0, 300);
      if (text.length < 12) continue;
      const { data: same } = await admin.from("ad_playbook").select("id").eq("lesson", text).maybeSingle();
      if (!same) await admin.from("ad_playbook").insert({ lesson: text, client_id: clientId, source: "claude" });
    }
    return { ok: true, suggested, auto, review_id: review?.id };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("ad_reviews").insert({ client_id: clientId, error: msg.slice(0, 400), health: "watch" });
    return { error: msg };
  }
}

// Make an approved suggestion on Meta.
async function applyAction(admin: any, token: string, id: string, who: string, auto = false) {
  const { data: a } = await admin.from("ad_actions").select("*").eq("id", id).maybeSingle();
  if (!a) return { error: "That suggestion has gone." };
  if (!["suggested", "failed"].includes(a.status)) return { error: "That one has already been dealt with." };
  if (a.kind === "flag") {
    await admin.from("ad_actions").update({ status: "applied", decided_by: who, decided_at: new Date().toISOString(), applied_at: new Date().toISOString() }).eq("id", id);
    return { ok: true };
  }
  await admin.from("ad_actions").update({ status: "applying", decided_by: who, decided_at: new Date().toISOString(), auto }).eq("id", id);
  try {
    let result: any;
    if (a.kind === "pause" || a.kind === "resume") result = await graphPost(String(a.target_id), { status: a.kind === "pause" ? "PAUSED" : "ACTIVE" }, token);
    else if (a.kind === "budget") {
      const cents = Math.round(Number(a.new_value) * 100);
      if (!(cents >= 100)) throw new Error("That budget doesn't look right.");
      result = await graphPost(String(a.target_id), { daily_budget: String(cents) }, token);
    } else throw new Error("Unknown change.");
    await admin.from("ad_actions").update({ status: "applied", applied_at: new Date().toISOString(), error: null, result }).eq("id", id);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await admin.from("ad_actions").update({ status: "failed", error: msg.slice(0, 300) }).eq("id", id);
    return { error: msg };
  }
}
