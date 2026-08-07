// Edge Function: sync-client-ads
// Pulls every active/paused ad for a client's whole Meta ad account in one
// go (using the same Business Manager System User token as creative-insights
// and generate-client-reports), instead of requiring each ad's Facebook Ad
// ID to be entered and refreshed one at a time. For each ad found:
//   - finds-or-creates a matching client_campaigns row by campaign name
//   - finds-or-creates a matching client_ad_creatives row by meta_ad_id,
//     and writes the live spend/impressions/clicks/results onto it
//
// Two ways to trigger it:
//  1. Manual "Sync" button in Creative Library: body { client_id }, caller
//     is a signed-in allowlisted user. Syncs just that one client.
//  2. Scheduled (see sql/044_daily_creative_sync.sql cron job): no body,
//     header x-cron-secret matches CREATIVE_SYNC_CRON_SECRET. Loops through
//     every client that has a Meta Ad Account ID set and syncs each in turn,
//     so creative data flows in automatically once a day without anyone
//     having to click Sync.

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

// Everything worth showing in the library — excludes ARCHIVED/DELETED, which
// are genuinely retired and would just be clutter.
const RELEVANT_STATUSES = [
  "ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "ADSET_PAUSED",
  "PENDING_REVIEW", "DISAPPROVED", "PREAPPROVED",
  "PENDING_BILLING_INFO", "IN_PROCESS", "WITH_ISSUES",
];

const RICH_FIELDS = "id,name,effective_status,campaign{id,name},adset{learning_stage_info},creative{image_url,thumbnail_url},insights.date_preset(maximum){impressions,clicks,spend,actions,cost_per_action_type}";
const BASIC_FIELDS = "id,name,effective_status,campaign{id,name},creative{image_url,thumbnail_url},insights.date_preset(maximum){impressions,clicks,spend,actions,cost_per_action_type}";

function buildAdsUrl(adAccountId: string, fields: string, filtering: string, token: string) {
  return `https://graph.facebook.com/v21.0/${encodeURIComponent(adAccountId)}/ads` +
    `?fields=${encodeURIComponent(fields)}` +
    `&filtering=${encodeURIComponent(filtering)}` +
    `&limit=100` +
    // Ads without a directly-hashed image (e.g. built from a Page post) only
    // have thumbnail_url, not image_url - Meta defaults that thumbnail to a
    // tiny size (~64x64), which is what was showing up blurry once displayed
    // any bigger than a table-row icon. These dimensions are request-level,
    // so they apply wherever thumbnail_url shows up in the field expansion.
    `&thumbnail_width=1080` +
    `&thumbnail_height=1080` +
    `&access_token=${encodeURIComponent(token)}`;
}

// Maps Meta's effective_status (+ adset learning-phase info, when available)
// onto a single delivery_status string the UI can badge/filter on.
function computeDeliveryStatus(ad: any): string | null {
  const es = ad?.effective_status;
  if (!es) return null;
  if (es === "ACTIVE") {
    const learning = ad?.adset?.learning_stage_info?.status;
    if (learning === "LEARNING") return "learning";
    if (learning === "LEARNING_LIMITED") return "learning_limited";
    return "active";
  }
  const map: Record<string, string> = {
    PAUSED: "paused",
    CAMPAIGN_PAUSED: "campaign_paused",
    ADSET_PAUSED: "adset_paused",
    PENDING_REVIEW: "in_review",
    DISAPPROVED: "disapproved",
    PREAPPROVED: "preapproved",
    PENDING_BILLING_INFO: "pending_billing",
    IN_PROCESS: "in_process",
    WITH_ISSUES: "with_issues",
    ARCHIVED: "archived",
    DELETED: "deleted",
  };
  return map[es] || es.toLowerCase();
}

// Syncs one client's whole Meta ad account. Shared by both the manual,
// single-client path and the cron path that loops over every client.
async function syncOneClient(admin: any, metaToken: string, clientId: string, rawMetaAdAccountId: string) {
  const metaAdAccountId = String(rawMetaAdAccountId).startsWith("act_")
    ? String(rawMetaAdAccountId)
    : `act_${rawMetaAdAccountId}`;

  const filtering = JSON.stringify([
    { field: "effective_status", operator: "IN", value: RELEVANT_STATUSES },
  ]);

  const ads: any[] = [];
  let pagesFetched = 0;

  // Try the rich field set (includes adset learning-phase info) first; if
  // the account/token can't access that nested field, fall back to the
  // basic set rather than failing the whole sync.
  let nextUrl: string | null = buildAdsUrl(metaAdAccountId, RICH_FIELDS, filtering, metaToken);
  let resp = await fetch(nextUrl);
  let pageJson = await resp.json();
  if (!resp.ok) {
    nextUrl = buildAdsUrl(metaAdAccountId, BASIC_FIELDS, filtering, metaToken);
    resp = await fetch(nextUrl);
    pageJson = await resp.json();
    if (!resp.ok) throw new Error(pageJson?.error?.message || "Meta API error");
  }
  ads.push(...(pageJson?.data ?? []));
  nextUrl = pageJson?.paging?.next ?? null;
  pagesFetched += 1;

  while (nextUrl && pagesFetched < 10) {
    const pageResp = await fetch(nextUrl);
    const pageData = await pageResp.json();
    if (!pageResp.ok) {
      throw new Error(pageData?.error?.message || "Meta API error");
    }
    ads.push(...(pageData?.data ?? []));
    nextUrl = pageData?.paging?.next ?? null;
    pagesFetched += 1;
  }

  const [{ data: existingCampaigns }, { data: existingCreatives }] = await Promise.all([
    admin.from("client_campaigns").select("id, client_id, name, platform, status").eq("client_id", clientId),
    admin.from("client_ad_creatives").select("id, client_id, meta_ad_id, name, result, campaign_id, image_url").eq("client_id", clientId),
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
        const { data: insertedCampaign } = await admin
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
      delivery_status: computeDeliveryStatus(ad),
      insights_updated_at: new Date().toISOString(),
    };

    const creativeImageUrl: string | null = ad?.creative?.image_url || ad?.creative?.thumbnail_url || null;
    const adId = ad?.id;
    const existingCreative = adId != null ? creativeByMetaId.get(String(adId)) : undefined;

    if (existingCreative) {
      const updatePatch: Record<string, unknown> = { ...patch };
      // Don't clobber a manually-uploaded image (stored in our own Supabase
      // bucket) with Meta's version, but DO let a Meta-sourced image get
      // replaced on later syncs - otherwise a low-res thumbnail_url grabbed
      // before the bigger thumbnail_width/height above was added would
      // stay stuck as blurry forever, since this only used to fire once
      // when image_url was still empty.
      const isOwnUpload = typeof existingCreative.image_url === "string" &&
        existingCreative.image_url.includes("/storage/v1/object/public/");
      if (creativeImageUrl && !isOwnUpload && creativeImageUrl !== existingCreative.image_url) {
        updatePatch.image_url = creativeImageUrl;
      }
      await admin.from("client_ad_creatives").update(updatePatch).eq("id", existingCreative.id);
      creativesUpdated += 1;
    } else {
      const insertPayload = {
        client_id: clientId,
        meta_ad_id: ad?.id,
        name: ad?.name,
        result: "testing",
        image_url: creativeImageUrl,
        ...patch,
      };
      await admin.from("client_ad_creatives").insert(insertPayload);
      creativesCreated += 1;
      if (ad?.id != null) creativeByMetaId.set(String(ad.id), insertPayload);
    }
  }

  return {
    ads_found: ads.length,
    campaigns_created: campaignsCreated,
    creatives_created: creativesCreated,
    creatives_updated: creativesUpdated,
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { status: 200, headers: { ...corsHeaders } });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const META_SYSTEM_USER_TOKEN = Deno.env.get("META_SYSTEM_USER_TOKEN");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const CREATIVE_SYNC_CRON_SECRET = Deno.env.get("CREATIVE_SYNC_CRON_SECRET");

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    return json({ error: "Server misconfigured: missing Supabase environment variables." }, 500);
  }
  if (!META_SYSTEM_USER_TOKEN) {
    return json({ error: "META_SYSTEM_USER_TOKEN secret is not set on this project yet." }, 500);
  }

  const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const isCron = Boolean(CREATIVE_SYNC_CRON_SECRET) && req.headers.get("x-cron-secret") === CREATIVE_SYNC_CRON_SECRET;

  // ───────── Scheduled path: every client with an ad account, no login ─────────
  if (isCron) {
    const { data: clients, error: clientsError } = await supabaseAdmin
      .from("clients")
      .select("id, meta_ad_account_id")
      .not("meta_ad_account_id", "is", null)
      .neq("meta_ad_account_id", "");

    if (clientsError) {
      return json({ error: clientsError.message }, 500);
    }

    const results: Record<string, unknown>[] = [];
    for (const client of clients ?? []) {
      try {
        const summary = await syncOneClient(supabaseAdmin, META_SYSTEM_USER_TOKEN, client.id, client.meta_ad_account_id);
        results.push({ client_id: client.id, ok: true, ...summary });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        results.push({ client_id: client.id, ok: false, error: message });
      }
    }

    return json({ ok: true, clients_synced: results.length, results });
  }

  // ───────── Manual path: one client, signed-in allowlisted user ─────────
  const authHeader = req.headers.get("Authorization") ?? "";
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

  try {
    const summary = await syncOneClient(supabaseAdmin, META_SYSTEM_USER_TOKEN, clientId, rawMetaAdAccountId);
    return json({ ok: true, ...summary });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
