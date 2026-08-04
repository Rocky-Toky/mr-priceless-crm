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

// sync-client-ads
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: { ...corsHeaders } });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const META_SYSTEM_USER_TOKEN = Deno.env.get("META_SYSTEM_USER_TOKEN");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    return json({ error: "Server misconfigured: missing Supabase environment variables." }, 500);
  }
  if (!META_SYSTEM_USER_TOKEN) {
    return json({ error: "META_SYSTEM_USER_TOKEN secret is not set on this project yet." }, 500);
  }

  const authHeader = req.headers.get("Authorization") ?? "";

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  const supabaseAuthed = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });

  const { data: userData, error: userError } = await supabaseAuthed.auth.getUser();
  const email = userData?.user?.email;
  if (userError || !email) {
    return json({ error: "Unauthorized." }, 401);
  }

  const { data: allowRows, error: allowError } = await supabaseAdmin
    .from("allowlist")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (allowError || !allowRows) {
    return json({ error: "Unauthorized." }, 401);
  }

  let body: { client_id?: string } = {};
  try {
    body = (await req.json()) ?? {};
  } catch {
    body = {};
  }

  const clientId = body?.client_id;
  if (!clientId) {
    return json({ error: "client_id is required." }, 400);
  }

  const { data: clientRow, error: clientError } = await supabaseAdmin
    .from("clients")
    .select("id, meta_ad_account_id")
    .eq("id", clientId)
    .maybeSingle();

  if (clientError || !clientRow) {
    return json({ error: "Client not found." }, 404);
  }

  const rawMetaAdAccountId = clientRow?.meta_ad_account_id;
  if (!rawMetaAdAccountId) {
    return json({ error: "This client has no Meta Ad Account ID set." }, 400);
  }
  const metaAdAccountId = String(rawMetaAdAccountId).startsWith("act_")
    ? String(rawMetaAdAccountId)
    : `act_${rawMetaAdAccountId}`;

  try {
    const fields = "id,name,effective_status,campaign{id,name},insights.date_preset(maximum){impressions,clicks,spend,actions,cost_per_action_type}";
    const filtering = JSON.stringify([
      { field: "effective_status", operator: "IN", value: ["ACTIVE", "PAUSED"] },
    ]);

    let nextUrl: string | null =
      `https://graph.facebook.com/v21.0/${encodeURIComponent(metaAdAccountId)}/ads` +
      `?fields=${encodeURIComponent(fields)}` +
      `&filtering=${encodeURIComponent(filtering)}` +
      `&limit=100` +
      `&access_token=${encodeURIComponent(META_SYSTEM_USER_TOKEN)}`;

    const ads: any[] = [];
    let pagesFetched = 0;

    while (nextUrl && pagesFetched < 10) {
      const resp = await fetch(nextUrl);
      const pageJson = await resp.json();
      if (!resp.ok) {
        throw new Error(pageJson?.error?.message || "Meta API error");
      }
      ads.push(...(pageJson?.data ?? []));
      nextUrl = pageJson?.paging?.next ?? null;
      pagesFetched += 1;
    }

    const [{ data: existingCampaigns }, { data: existingCreatives }] = await Promise.all([
      supabaseAdmin.from("client_campaigns").select("id, client_id, name, platform, status").eq("client_id", clientId),
      supabaseAdmin.from("client_ad_creatives").select("id, client_id, meta_ad_id, name, result, campaign_id").eq("client_id", clientId),
    ]);

    const campaignByName = new Map<string, any>();
    for (const row of existingCampaigns ?? []) {
      if (row?.name) campaignByName.set(row.name, row);
    }

    const creativeByMetaId = new Map<string, any>();
    for (const row of existingCreatives ?? []) {
      if (row?.meta_ad_id != null) creativeByMetaId.set(String(row.meta_ad_id), row);
    }

    let campaignsCreated = 0;
    let creativesCreated = 0;
    let creativesUpdated = 0;

    for (const ad of ads) {
      const campaignName = ad?.campaign?.name;
      let campaignId: string | null = null;

      if (campaignName) {
        const existing = campaignByName.get(campaignName);
        if (!existing) {
          const { data: insertedCampaign } = await supabaseAdmin
            .from("client_campaigns")
            .insert({
              client_id: clientId,
              name: campaignName,
              platform: "Meta",
              status: ad?.effective_status === "ACTIVE" ? "active" : "paused",
            })
            .select("id")
            .maybeSingle();

          campaignId = insertedCampaign?.id ?? null;
          if (campaignId) campaignByName.set(campaignName, { id: campaignId, name: campaignName });
          campaignsCreated += 1;
        } else {
          campaignId = existing?.id ?? null;
        }
      }

      const insights = ad?.insights?.data?.[0] ?? {};
      const actions = insights?.actions ?? [];
      const costPerActionType = insights?.cost_per_action_type ?? [];

      const leadAction = actions.find((a: any) =>
        ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"].includes(a?.action_type)
      );
      const results = leadAction ? Math.round(Number(leadAction.value)) : null;
      const leadCost = leadAction ? costPerActionType.find((c: any) => c?.action_type === leadAction?.action_type) : null;
      const spend = Number(insights?.spend || 0);
      const costPerResult = leadCost ? Number(leadCost.value) : (results ? spend / results : null);

      const patch = {
        campaign_id: campaignId,
        impressions: Math.round(Number(insights?.impressions || 0)),
        clicks: Math.round(Number(insights?.clicks || 0)),
        spend,
        results,
        cost_per_result: costPerResult,
        insights_updated_at: new Date().toISOString(),
      };

      const adId = ad?.id;
      const existingCreative = adId != null ? creativeByMetaId.get(String(adId)) : undefined;

      if (existingCreative) {
        await supabaseAdmin.from("client_ad_creatives").update(patch).eq("id", existingCreative.id);
        creativesUpdated += 1;
      } else {
        const insertPayload = {
          client_id: clientId,
          meta_ad_id: ad?.id,
          name: ad?.name,
          result: "testing",
          ...patch,
        };
        await supabaseAdmin.from("client_ad_creatives").insert(insertPayload);
        creativesCreated += 1;
        if (ad?.id != null) creativeByMetaId.set(String(ad.id), insertPayload);
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
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
