// Edge Function: jarvis
// Jarvis is the CRM's assistant. He answers questions about the business
// from a live snapshot of the CRM (clients, their latest reports, ad
// creatives and what they cost per lead, the deals pipeline), writes ad copy
// from what's actually performing, and remembers things over time in
// jarvis_memory (shared by the team). Each person's conversation is kept in
// jarvis_messages.
//
// Body (signed-in, allowlisted user):
//   { action: "chat", message }   -> { reply }
//   { action: "history" }         -> { messages }
//   { action: "clear" }           -> clears your conversation
// Needs the ANTHROPIC_API_KEY secret on the Supabase project.

import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";
import { corsHeaders } from "../_shared/cors.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

const MODEL = "claude-opus-5-5";
const HISTORY_TURNS = 24;

const SYSTEM = `You are Jarvis, the assistant built into the Mr Priceless CRM.

Mr Priceless is a New Zealand marketing agency for tradies (builders, electricians, plumbers, HVAC, roofers, landscapers and similar). Paid marketing is the core: Meta ads and Google ads, plus a sales team that calls every lead within 3 minutes and books quotes straight into the client's calendar, and monthly consulting workshops. Clients are covered by a 10 Quote Guarantee: they pay nothing until 10 quotes are delivered, then month to month with no lock-in. A "quote" means a lead reached a site visit, "to be quoted" or quote stage.

You help the team (mainly Rocky and Max) with:
- Analysis of the CRM: which clients are doing well or at risk, cost per lead and cost per quote, returns, the pipeline, lost deals, what to focus on.
- Ad copy for new Meta ads, built on what the top-performing creatives have in common. Give several options (hooks, primary text, headlines) and say which past winner each draws on.
- Sales and client messaging: follow-ups, scripts, emails.

How to work:
- Use the CRM snapshot below for facts and numbers, and say where a number comes from. If the data isn't there, say so plainly rather than guessing.
- Be direct and practical, in plain New Zealand English. Short paragraphs and bullet points; no fluff, no corporate speak.
- When you learn something worth keeping - a preference from the team, a fact about a client, or a lesson about what works in ads or sales - save it with the remember tool. Don't save things already in memory or one-off chatter.
- Things in "What you've learned" were saved earlier; use them.`;

const REMEMBER_TOOL = {
  name: "remember",
  description: "Save something worth knowing next time: a team preference, a fact about a client, or a learning about what works in ads, copy or sales. One clear sentence.",
  strict: true,
  input_schema: {
    type: "object",
    properties: {
      content: { type: "string", description: "The thing to remember, as one clear sentence." },
      kind: { type: "string", enum: ["preference", "learning", "note"], description: "preference = how the team likes things done; learning = what works or doesn't; note = a fact." },
    },
    required: ["content", "kind"],
    additionalProperties: false,
  },
};

const money = (v: unknown) => (v == null || v === "" || isNaN(Number(v))) ? "-" : "$" + Math.round(Number(v)).toLocaleString("en-NZ");

// A plain-text snapshot of the CRM for Jarvis to read.
async function crmSnapshot(admin: any) {
  const [clients, reports, creatives, deals, memory] = await Promise.all([
    admin.from("clients").select("id, name, stage, monthly_ad_spend, quote_target, quotes_sent, ad_start_date, churn_risk, services, notes").neq("stage", "archived").limit(200),
    admin.from("client_reports").select("client_id, period_start, period_end, metrics").order("period_end", { ascending: true }).limit(2000),
    admin.from("client_ad_creatives").select("client_id, name, result, delivery_status, fatigue_status, spend, results, cost_per_result, impressions, clicks, notes").order("spend", { ascending: false }).limit(150),
    admin.from("deals").select("title, contact_name, stage, value, contract_type, assignee, notes, updated_at").order("updated_at", { ascending: false }).limit(150),
    admin.from("jarvis_memory").select("content, kind, created_at").order("created_at", { ascending: true }).limit(300),
  ]);
  const byId = new Map((clients.data || []).map((c: any) => [c.id, c.name]));
  const lines: string[] = [];

  lines.push("## Clients");
  for (const c of clients.data || []) {
    lines.push(`- ${c.name} | stage ${c.stage} | ad spend/mo ${money(c.monthly_ad_spend)} | quotes ${c.quotes_sent ?? 0}/${c.quote_target ?? 10} | ads started ${c.ad_start_date || "-"}${c.churn_risk ? ` | churn risk ${c.churn_risk}` : ""}${c.services ? ` | services: ${String(c.services).slice(0, 120)}` : ""}`);
  }

  lines.push("\n## Latest report per client (month to date, and totals to date)");
  const latest = new Map<string, any>();
  for (const r of reports.data || []) if (r.metrics?.kind === "mtd") latest.set(r.client_id, r);
  for (const [id, r] of latest) {
    const m = r.metrics || {};
    const cpq = Number(m.adSpendMonth) && Number(m.quoteReady) ? Number(m.adSpendMonth) / Number(m.quoteReady) : null;
    lines.push(`- ${byId.get(id) || "Client"} (${r.period_start} to ${r.period_end}): revenue ${money(m.revenueMonth)}, jobs ${m.jobsMonth ?? "-"}, ad spend ${money(m.adSpendMonth)}, enquiries ${m.enquiries ?? "-"}, quotes ${m.quoteReady ?? "-"}, quoted ${m.quoted ?? "-"}, open quotes ${m.openQuotesCount ?? "-"}, cost per quote ${money(cpq)} | to date: revenue ${money(m.revenueToDate)}, invested ${money(m.investedToDate)}, return ${m.roiToDate ? Number(m.roiToDate).toFixed(1) + "x" : "-"}`);
  }

  lines.push("\n## Ad creatives (by spend; result = the team's tag: winner = top performer, testing = average, killed = low performer)");
  for (const a of creatives.data || []) {
    lines.push(`- ${byId.get(a.client_id) || "Client"} | "${a.name}" | ${a.result}${a.fatigue_status ? `, ${a.fatigue_status}` : ""} | ${a.delivery_status || "-"} | spend ${money(a.spend)}, leads ${a.results ?? "-"}, CPL ${money(a.cost_per_result)}${a.notes ? ` | notes: ${String(a.notes).slice(0, 160)}` : ""}`);
  }

  lines.push("\n## Deals pipeline (most recently updated first)");
  for (const d of deals.data || []) {
    lines.push(`- ${d.title} | ${d.stage} | ${d.contract_type === "retainer" || !d.contract_type ? money(d.value) + "/mo" : d.contract_type} | ${d.assignee || "-"}${d.notes ? ` | ${String(d.notes).replace(/\s+/g, " ").slice(0, 140)}` : ""}`);
  }

  const mem = (memory.data || []).map((m: any) => `- [${m.kind}] ${m.content}`);
  return { snapshot: lines.join("\n"), memory: mem.length ? mem.join("\n") : "(nothing yet)" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: "Server misconfigured." }, 500);
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

  try {
    if (body.action === "history") {
      const { data } = await admin.from("jarvis_messages").select("role, content, created_at").eq("user_email", email).order("created_at", { ascending: true }).limit(200);
      return json({ messages: data || [] });
    }
    if (body.action === "clear") {
      await admin.from("jarvis_messages").delete().eq("user_email", email);
      return json({ ok: true });
    }
    if (body.action !== "chat") return json({ error: "Unknown action." }, 400);

    const message = String(body.message || "").trim().slice(0, 8000);
    if (!message) return json({ error: "Say something to Jarvis." }, 400);
    const KEY = Deno.env.get("ANTHROPIC_API_KEY");
    if (!KEY) return json({ error: "needs_key" }, 503);

    const { data: past } = await admin.from("jarvis_messages").select("role, content").eq("user_email", email).order("created_at", { ascending: false }).limit(HISTORY_TURNS);
    const history: any[] = (past || []).reverse().map((m: any) => ({ role: m.role, content: m.content }));
    // The API needs the conversation to start with the user.
    while (history.length && history[0].role !== "user") history.shift();

    const { snapshot, memory } = await crmSnapshot(admin);
    const today = new Date().toLocaleDateString("en-NZ", { timeZone: "Pacific/Auckland", weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const name = email.split("@")[0];
    const messages: any[] = [...history, { role: "user", content: `(${today} · from ${name})\n\n${message}` }];

    const client = new Anthropic({ apiKey: KEY });
    let reply = "";
    let saved = 0;
    // Up to a few rounds, in case Jarvis saves something to memory first.
    for (let round = 0; round < 4; round++) {
      const response: any = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium" },
        system: [
          { type: "text", text: SYSTEM },
          { type: "text", text: `# CRM snapshot\n${snapshot}\n\n# What you've learned\n${memory}`, cache_control: { type: "ephemeral" } },
        ],
        tools: [REMEMBER_TOOL],
        messages,
      } as any);

      if (response.stop_reason === "refusal") { reply = "Sorry, I can't help with that one."; break; }
      const text = (response.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n").trim();
      const uses = (response.content || []).filter((b: any) => b.type === "tool_use");
      if (text) reply = reply ? `${reply}\n\n${text}` : text;
      if (response.stop_reason !== "tool_use" || !uses.length) break;

      messages.push({ role: "assistant", content: response.content });
      const results: any[] = [];
      for (const u of uses) {
        let ok = false;
        if (u.name === "remember" && u.input && typeof u.input.content === "string" && u.input.content.trim()) {
          const kind = ["preference", "learning", "note"].includes(u.input.kind) ? u.input.kind : "note";
          const { error } = await admin.from("jarvis_memory").insert({ content: u.input.content.trim().slice(0, 1000), kind, created_by: email });
          ok = !error; if (ok) saved++;
        }
        results.push({ type: "tool_result", tool_use_id: u.id, content: ok ? "Saved." : "Couldn't save that.", ...(ok ? {} : { is_error: true }) });
      }
      messages.push({ role: "user", content: results });
    }
    if (!reply) reply = saved ? "Got it - I'll remember that." : "I didn't catch that - can you ask another way?";

    await admin.from("jarvis_messages").insert([
      { user_email: email, role: "user", content: message },
      { user_email: email, role: "assistant", content: reply },
    ]);
    return json({ reply, remembered: saved });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "The Anthropic API key isn't valid." }, 502);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "Jarvis is busy - try again in a moment." }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: `Jarvis hit an error (${e.status}). Try again.` }, 502);
    return json({ error: (e as Error).message || "Something went wrong." }, 500);
  }
});
