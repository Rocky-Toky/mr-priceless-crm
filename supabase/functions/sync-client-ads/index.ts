// Edge Function: sync-client-ads
// Pulls every active/paused ad for a client's whole Meta ad account in one
// go (using the same Business Manager System User token as creative-insights
// and generate-client-reports), instead of requiring each ad's Facebook Ad
// ID to be entered and refreshed one at a time. For each ad found:
//   - finds-or-creates a matching client_campaigns row by campaign name
//   - finds-or-creates a matching client_ad_creatives row by meta_ad_id,
//     and writes the live spend/impressions/clicks/results onto it
//
// Body: { client_id }. Caller must be a signed-in, allowlisted user.

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

  let body: { client_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }
  if (!body.client_id) return json({ error: "client_id is required." }, 400);

  const { data: client, error: clientErr } = await admin.from("clients").select("*").eq("id", body.client_id).single();
  if (clientErr || !client) return json({ error: "Client not found." }, 404);
  if (!client.meta_ad_account_id) return json({ error: "This client has no Meta Ad Account ID set." }, 400);

  try {
    const ads = await fetchAllAds(client.meta_ad_account_id, META_TOKEN);

    const { data: existingCampaigns } = await admin.from("client_campaigns").select("*").eq("client_id", body.client_id);
    const { data: existingCreatives } = await admin.from("client_ad_creatives").select("*").eq("client_id", body.client_id);
    const campaignByName = new Map((existingCampaigns || []).map((c: any) => [c.name, c]));
    const creativeByMetaId = new Map((existingCreatives || []).filter((a: any) => a.meta_ad_id).map((a: any) => [a.meta_ad_id, a]));

    let campaignsCreated = 0, creativesCreated = 0, creativesUpdated = 0;

    for (const ad of ads) {
      let campaignId: string | null = null;
      const campName = ad.campaign?.name;
      if (campName) {
        let camp = campaignByName.get(campName);
        if (!camp) {
          const { data: newCamp, error: campErr } = await admin.from("client_campaigns").insert({
            client_id: body.client_id,
            name: campName,
            platform: "Meta",
            status: ad.effective_status === "ACTIVE" ? "active" : "paused",
          }).select().single();
          if (campErr) throw new Error(campErr.message);
          camp = newCamp;
          campaignByName.set(campName, camp);
          campaignsCreated++;
        }
        campaignId = camp.id;
      }

      const insights = ad.insights?.data?.[0] || {};
      const actions = (insights.actions || []) as { action_type: string; value: string }[];
      const costs = (insights.cost_per_action_type || []) as { action_type: string; value: string }[];
      const leadAction = actions.find((a) => LEAD_ACTION_TYPES.includes(a.action_type));
      const results = leadAction ? Math.round(Number(leadAction.value)) : null;
      const leadCost = leadAction ? costs.find((c) => c.action_type === leadAction.action_type) : null;
      const spend = Number(insights.spend || 0);
      const costPerResult = leadCost ? Number(leadCost.value) : (results ? spend / results : null);

      const patch = {
        campaign_id: campaignId,
        impressions: Math.round(Number(insights.impressions || 0)),
        clicks: Math.round(Number(insights.clicks || 0)),
        spend,
        results,
        cost_per_result: costPerResult,
        insights_updated_at: new Date().toISOString(),
      };

      const existing = creativeByMetaId.get(ad.id);
      if (existing) {
        await admin.from("client_ad_creatives").update(patch).eq("id", existing.id);
        creativesUpdated++;
      } else {
        await admin.from("client_ad_creatives").insert({
          client_id: body.client_id,
          meta_ad_id: ad.id,
          name: ad.name,
          result: "testing",
          ...patch,
        });
        creativesCreated++;
      }
    }

    return json({
      ok: true,
      ads_found: ads.length,
      campaigns_created: campaignsCreated,
      creatives_created: creativesCreated,
      creatives_updated: creativesUpdated,
    });
  } catch (e) {
    return json({ error: String(e instanceof Error ? e.message : e) }, 500);
  }
});

async function fetchAllAds(adAccountId: string, token: string) {
  const fields = "id,name,effective_status,campaign{id,name},insights.date_preset(maximum){impressions,clicks,spend,actions,cost_per_action_type}";
  const filtering = JSON.stringify([{ field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED"] }]);
  let url: string | null =
    `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}/ads?fields=${encodeURIComponent(fields)}&filtering=${encodeURIComponent(filtering)}&limit=100&access_token=${token}`;

  const ads: any[] = [];
  let pages = 0;
  while (url && pages < 10) {
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok) throw new Error(data?.error?.message || JSON.stringify(data));
    ads.push(...(data.data || []));
    url = data.paging?.next || null;
    pages++;
  }
  return ads;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
