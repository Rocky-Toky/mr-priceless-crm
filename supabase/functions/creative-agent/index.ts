// Edge Function: creative-agent
// The worker behind Ad production (sql/101). It works the creative_steps
// queue: Claude drafts a job's ad angles, then (after a person ticks the
// angles to run) the copy for each concept. All AI work happens here, never
// in the browser; the API key stays in the function's secrets.
//
//   Scheduled (sql/101 pg_cron, every minute when there's work): header
//     x-cron-secret matches app_secrets.creative_cron_secret. Works the queue.
//   Signed-in team member (not Lead Follow Up only logins):
//     { action: "kick" }                                   start on the queue now
//     { action: "choose_angles", job_id, angle_ids, note } the angle check
//     { action: "review", version_id, decision, note?, redo? }  approve / reject / discard
//     { action: "retry", job_id }                          failed or paused job
//
// Secrets: ANTHROPIC_API_KEY. Optional: CLAUDE_MODEL_STRATEGY (angles),
// CLAUDE_MODEL_DEFAULT (copy), CREATIVE_JOB_COST_CEILING_USD (default 10).

import { createClient } from "npm:@supabase/supabase-js@2";
import { makeClaude } from "./claude.ts";
import { chooseAngles, type Deps, retryJob, reviewVersion, StepError, tick } from "./pipeline.ts";
import { supabaseStore } from "./store.ts";

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

function deps(admin: any): Deps {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  const ceiling = Number(Deno.env.get("CREATIVE_JOB_COST_CEILING_USD"));
  return {
    store: supabaseStore(admin),
    claude: key ? makeClaude(key) : () => Promise.reject(new StepError("The Claude API key isn't set up yet. Add it as the ANTHROPIC_API_KEY repo secret, then press Retry.", false)),
    config: {
      strategyModel: Deno.env.get("CLAUDE_MODEL_STRATEGY") || "claude-opus-5-5",
      defaultModel: Deno.env.get("CLAUDE_MODEL_DEFAULT") || "claude-opus-5-5",
      ceilingUsd: Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 10,
    },
  };
}

// Work the queue after replying, so the page isn't held up.
function inBackground(p: Promise<unknown>) {
  const safe = p.catch((e) => console.error("creative-agent:", String((e as any)?.message || e)));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) EdgeRuntime.waitUntil(safe);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: "Server misconfigured." }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
  const d = deps(admin);

  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) {
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "creative_cron_secret").maybeSingle();
    if (!secret?.value || secret.value !== cronHeader) return json({ error: "Unauthorized." }, 401);
    return json(await tick(d, { budgetMs: 30_000 }));
  }

  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const email = userData?.user?.email;
  if (!email || !userData?.user?.email_confirmed_at) return json({ error: "Unauthorized." }, 401);
  // Lead Follow Up only logins (allowlist.access = "leads") can't use this.
  const { data: allowed } = await admin.from("allowlist").select("email, access").ilike("email", email).maybeSingle();
  if (!allowed || allowed.access === "leads") return json({ error: "Unauthorized." }, 401);

  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }
  try {
    if (body.action === "kick") {
      inBackground(tick(d, { budgetMs: 30_000 }));
      return json({ ok: true });
    }
    if (body.action === "choose_angles") {
      await chooseAngles(d, String(body.job_id || ""), Array.isArray(body.angle_ids) ? body.angle_ids.map(String) : [], body.note ? String(body.note) : null);
      inBackground(tick(d, { budgetMs: 30_000 }));
      return json({ ok: true });
    }
    if (body.action === "review") {
      await reviewVersion(d, { versionId: String(body.version_id || ""), decision: String(body.decision || ""), note: body.note ? String(body.note) : null, redo: body.redo ? String(body.redo) : null, reviewer: email });
      return json({ ok: true });
    }
    if (body.action === "retry") {
      await retryJob(d, String(body.job_id || ""));
      inBackground(tick(d, { budgetMs: 30_000 }));
      return json({ ok: true });
    }
    return json({ error: "Unknown action." }, 400);
  } catch (e) {
    if (e instanceof StepError) return json({ error: e.message }, 400);
    console.error("creative-agent:", String((e as any)?.message || e));
    return json({ error: "Something went wrong. Try again in a minute." }, 500);
  }
});
