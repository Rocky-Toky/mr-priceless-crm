// Edge Function: sync-client-ads
// Pulls a client's whole Meta ad account (using the same Business Manager
// System User token as creative-insights and generate-client-reports):
// every campaign, every ad set and every ad that isn't archived or deleted,
// so new campaigns, ad sets and ads are picked up on every run. Then:
//   - finds-or-creates a client_campaigns row per campaign (by name)
//   - finds-or-creates a client_ad_creatives row per ad (by meta_ad_id),
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

const CAMPAIGN_STATUSES = ["ACTIVE", "PAUSED", "IN_PROCESS", "WITH_ISSUES"];
const ADSET_STATUSES = ["ACTIVE", "PAUSED", "CAMPAIGN_PAUSED", "IN_PROCESS", "WITH_ISSUES"];
const GRAPH = "https://graph.facebook.com/v21.0";

function graphUrl(path: string, params: Record<string, string>, token: string) {
  const q = new URLSearchParams({ ...params, access_token: token });
  return `${GRAPH}/${path}?${q.toString()}`;
}
const statusFilter = (values: string[]) => JSON.stringify([{ field: "effective_status", operator: "IN", value: values }]);

// Every row from a Graph API list, following paging.next. Big accounts used
// to stop at the first error; this retries a failing page once with a smaller
// page size (Meta's "please reduce the amount of data" error) before giving up.
async function graphAll(url: string, maxPages = 60): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = url;
  for (let page = 0; next && page < maxPages; page++) {
    let resp = await fetch(next);
    let body = await resp.json();
    if (!resp.ok && /limit=\d+/.test(next)) {
      next = next.replace(/limit=\d+/, "limit=50");
      resp = await fetch(next);
      body = await resp.json();
    }
    if (!resp.ok) throw new Error(body?.error?.message || "Meta API error");
    out.push(...(body?.data ?? []));
    next = body?.paging?.next ?? null;
  }
  return out;
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

// Syncs one client's whole Meta ad account, in separate steps so one
// failure can't stop new creatives coming through:
//   1. every campaign  -> client_campaigns (new ones added even before they have ads)
//   2. every ad set    -> learning-phase status, and which campaign each sits in
//   3. every ad        -> client_ad_creatives (new ones added, existing refreshed)
//   4. lifetime stats  -> one account-level insights call, joined on ad id; if
//      it fails the ads are still saved and their old stats are left alone.
// Shared by the manual single-client path and the scheduled all-clients path.
async function syncOneClient(admin: any, metaToken: string, clientId: string, rawMetaAdAccountId: string) {
  const act = String(rawMetaAdAccountId).trim().startsWith("act_") ? String(rawMetaAdAccountId).trim() : `act_${String(rawMetaAdAccountId).trim()}`;

  // 1. Campaigns
  const campaigns = await graphAll(graphUrl(`${act}/campaigns`, { fields: "id,name,effective_status", filtering: statusFilter(CAMPAIGN_STATUSES), limit: "200" }, metaToken));
  const campaignNameById = new Map<string, string>(campaigns.map((c: any) => [String(c.id), c.name]));

  // 2. Ad sets (learning-phase info needs extra access on some accounts - fall back without it)
  let adsets: any[] = [];
  try {
    adsets = await graphAll(graphUrl(`${act}/adsets`, { fields: "id,name,campaign_id,effective_status,learning_stage_info", filtering: statusFilter(ADSET_STATUSES), limit: "200" }, metaToken));
  } catch {
    adsets = await graphAll(graphUrl(`${act}/adsets`, { fields: "id,name,campaign_id,effective_status", filtering: statusFilter(ADSET_STATUSES), limit: "200" }, metaToken));
  }
  const adsetById = new Map<string, any>(adsets.map((a: any) => [String(a.id), a]));

  // 3. Ads - light fields only, so every page comes back
  const ads = await graphAll(graphUrl(`${act}/ads`, {
    fields: "id,name,effective_status,campaign_id,adset_id,creative{image_url,thumbnail_url}",
    filtering: statusFilter(RELEVANT_STATUSES), limit: "200",
    // Ads built from a Page post only have thumbnail_url, which Meta defaults
    // to ~64px - ask for a full-size one so the library image isn't blurry.
    thumbnail_width: "1080", thumbnail_height: "1080",
  }, metaToken));

  // 4. Lifetime stats for every ad at once
  const statsByAd = new Map<string, any>();
  let statsError: string | null = null;
  try {
    const rows = await graphAll(graphUrl(`${act}/insights`, { level: "ad", date_preset: "maximum", fields: "ad_id,impressions,clicks,spend,actions,cost_per_action_type", limit: "500" }, metaToken));
    for (const r of rows) if (r?.ad_id) statsByAd.set(String(r.ad_id), r);
  } catch (e) {
    statsError = e instanceof Error ? e.message : String(e);
  }

  const [{ data: existingCampaigns }, { data: existingCreatives }] = await Promise.all([
    admin.from("client_campaigns").select("id, client_id, name, platform, status").eq("client_id", clientId),
    admin.from("client_ad_creatives").select("id, client_id, meta_ad_id, name, result, campaign_id, image_url").eq("client_id", clientId),
  ]);
  const campaignByName = new Map<string, any>();
  for (const row of existingCampaigns ?? []) if (row?.name) campaignByName.set(row.name, row);
  const creativeByMetaId = new Map<string, any>();
  for (const row of existingCreatives ?? []) if (row?.meta_ad_id != null) creativeByMetaId.set(String(row.meta_ad_id), row);

  let campaignsCreated = 0, creativesCreated = 0, creativesUpdated = 0;

  // Campaign rows (matched by name, as before), with their live status.
  for (const c of campaigns) {
    if (!c?.name) continue;
    const status = c.effective_status === "ACTIVE" ? "active" : "paused";
    const existing = campaignByName.get(c.name);
    if (!existing) {
      const { data: inserted } = await admin.from("client_campaigns")
        .insert({ client_id: clientId, name: c.name, platform: "Meta", status })
        .select("id").maybeSingle();
      if (inserted?.id) campaignByName.set(c.name, { id: inserted.id, name: c.name, status });
      campaignsCreated += 1;
    } else if (existing.platform === "Meta" && existing.status !== status) {
      await admin.from("client_campaigns").update({ status }).eq("id", existing.id);
    }
  }

  for (const ad of ads) {
    const campaignName = campaignNameById.get(String(ad?.campaign_id)) || null;
    let campaignId: string | null = null;
    if (campaignName) {
      let row = campaignByName.get(campaignName);
      if (!row) {
        const { data: inserted } = await admin.from("client_campaigns")
          .insert({ client_id: clientId, name: campaignName, platform: "Meta", status: ad?.effective_status === "ACTIVE" ? "active" : "paused" })
          .select("id").maybeSingle();
        row = inserted ? { id: inserted.id, name: campaignName } : null;
        if (row) { campaignByName.set(campaignName, row); campaignsCreated += 1; }
      }
      campaignId = row?.id ?? null;
    }

    const adset = adsetById.get(String(ad?.adset_id));
    const patch: Record<string, unknown> = {
      campaign_id: campaignId,
      delivery_status: computeDeliveryStatus({ ...ad, adset }),
    };
    const insights = statsByAd.get(String(ad?.id));
    if (insights) {
      const actions = insights?.actions ?? [];
      const costPerActionType = insights?.cost_per_action_type ?? [];
      const leadAction = actions.find((a: any) =>
        ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"].includes(a?.action_type)
      );
      const results = leadAction ? Math.round(Number(leadAction.value)) : null;
      const leadCost = leadAction ? costPerActionType.find((c: any) => c?.action_type === leadAction?.action_type) : null;
      const spend = Number(insights?.spend || 0);
      Object.assign(patch, {
        impressions: Math.round(Number(insights?.impressions || 0)),
        clicks: Math.round(Number(insights?.clicks || 0)),
        spend,
        results,
        cost_per_result: leadCost ? Number(leadCost.value) : (results ? spend / results : null),
        insights_updated_at: new Date().toISOString(),
      });
    } else if (!statsError) {
      // No delivery yet (e.g. a brand-new ad) - zero stats, but checked just now.
      Object.assign(patch, { impressions: 0, clicks: 0, spend: 0, results: null, cost_per_result: null, insights_updated_at: new Date().toISOString() });
    }

    const creativeImageUrl: string | null = ad?.creative?.image_url || ad?.creative?.thumbnail_url || null;
    const existingCreative = ad?.id != null ? creativeByMetaId.get(String(ad.id)) : undefined;
    if (existingCreative) {
      const updatePatch: Record<string, unknown> = { ...patch };
      // Keep a manually-uploaded image (in our own Supabase bucket); let a
      // Meta-sourced one be replaced, so an old blurry thumbnail gets fixed.
      const isOwnUpload = typeof existingCreative.image_url === "string" &&
        existingCreative.image_url.includes("/storage/v1/object/public/");
      if (creativeImageUrl && !isOwnUpload && creativeImageUrl !== existingCreative.image_url) updatePatch.image_url = creativeImageUrl;
      await admin.from("client_ad_creatives").update(updatePatch).eq("id", existingCreative.id);
      creativesUpdated += 1;
    } else {
      const insertPayload = { client_id: clientId, meta_ad_id: ad?.id, name: ad?.name, result: "testing", image_url: creativeImageUrl, ...patch };
      await admin.from("client_ad_creatives").insert(insertPayload);
      creativesCreated += 1;
      if (ad?.id != null) creativeByMetaId.set(String(ad.id), insertPayload);
    }
  }

  return {
    campaigns_found: campaigns.length,
    adsets_found: adsets.length,
    ads_found: ads.length,
    campaigns_created: campaignsCreated,
    creatives_created: creativesCreated,
    creatives_updated: creativesUpdated,
    stats_error: statsError,
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
      .neq("stage", "archived")
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
