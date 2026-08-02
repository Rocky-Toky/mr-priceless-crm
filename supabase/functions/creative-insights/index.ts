// Edge Function: creative-insights
// Pulls live performance stats (impressions, clicks, spend, results, cost
// per result) for a single ad creative from the Meta Marketing API, using
// the same Business Manager System User token as generate-client-reports,
// and caches the result on the client_ad_creatives row.
//
// Body: { creative_id }. Caller must be a signed-in, allowlisted user.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const META_API_VERSION = "v21.0";
const LEAD_ACTION_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const META_TOKEN = Deno.env.get("META_SYSTEM_USER_TOKEN")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user?.email) return json({ error: "Unauthorized." }, 401);
  const { data: allowed } = await admin.from("allowlist").select("email").eq("email", user.email).maybeSingle();
  if (!allowed) return json({ error: "Unauthorized." }, 401);

  let body: { creative_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  if (!body.creative_id) return json({ error: "creative_id is required." }, 400);

  const { data: creative, error: creativeErr } = await admin.from("client_ad_creatives").select("*").eq("id", body.creative_id).single();
  if (creativeErr || !creative) return json({ error: "Ad creative not found." }, 404);
  if (!creative.meta_ad_id) return json({ error: "This ad creative has no Facebook Ad ID set." }, 400);

  try {
    const fields = "impressions,clicks,spend,ctr,cpc,actions,cost_per_action_type";
    const url = `https://graph.facebook.com/${META_API_VERSION}/${creative.meta_ad_id}/insights?fields=${fields}&date_preset=maximum&access_token=${META_TOKEN}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    const insights = data?.data?.[0] || {};

    const actions = (insights.actions || []) as { action_type: string; value: string }[];
    const costs = (insights.cost_per_action_type || []) as { action_type: string; value: string }[];
    const leadAction = actions.find((a) => LEAD_ACTION_TYPES.includes(a.action_type));
    const results = leadAction ? Math.round(Number(leadAction.value)) : null;
    const leadCost = leadAction ? costs.find((c) => c.action_type === leadAction.action_type) : null;
    const spend = Number(insights.spend || 0);
    const costPerResult = leadCost ? Number(leadCost.value) : (results ? spend / results : null);

    const patch = {
      impressions: Math.round(Number(insights.impressions || 0)),
      clicks: Math.round(Number(insights.clicks || 0)),
      spend,
      results,
      cost_per_result: costPerResult,
      insights_updated_at: new Date().toISOString(),
    };
    await admin.from("client_ad_creatives").update(patch).eq("id", body.creative_id);
    return json({ ok: true, ...patch });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
