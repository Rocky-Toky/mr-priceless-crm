import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const META_SYSTEM_USER_TOKEN = Deno.env.get("META_SYSTEM_USER_TOKEN");

  if (!SUPABASE_URL) throw new Error("SUPABASE_URL is required");
  if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");
  if (!SUPABASE_ANON_KEY) throw new Error("SUPABASE_ANON_KEY is required");
  if (!META_SYSTEM_USER_TOKEN) throw new Error("META_SYSTEM_USER_TOKEN is required");

  const authHeader = req.headers.get("Authorization") ?? "";

  // Admin client
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Caller client (forward Authorization header)
  const caller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: {
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    },
  });

  const { data: userData, error: userError } = await caller.auth.getUser();
  const email = userData?.user?.email ?? null;

  if (!email) {
    // If getUser fails or returns no email, treat as unauthorized
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  // Allowlist check
  const { data: allowRows, error: allowError } = await admin
    .from("allowlist")
    .select("email")
    .eq("email", email)
    .limit(1);

  if (allowError || !allowRows || allowRows.length === 0) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  const reqBody = await req.json().catch(() => ({}));
  const creative_id = reqBody?.creative_id;

  if (!creative_id) {
    return jsonResponse({ error: "creative_id is required." }, 400);
  }

  const { data: creatives, error: creativeSelectError } = await admin
    .from("client_ad_creatives")
    .select("id, meta_ad_id, image_url")
    .eq("id", creative_id)
    .limit(1);

  const creative = creatives?.[0] ?? null;

  if (creativeSelectError || !creative) {
    return jsonResponse({ error: "Ad creative not found." }, 404);
  }

  const meta_ad_id = creative.meta_ad_id;
  if (meta_ad_id === null || meta_ad_id === "") {
    return jsonResponse({ error: "This ad creative has no Facebook Ad ID set." }, 400);
  }

  try {
    const fbUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(String(meta_ad_id))}/insights?fields=impressions,clicks,spend,ctr,cpc,actions,cost_per_action_type&date_preset=maximum&access_token=${encodeURIComponent(String(META_SYSTEM_USER_TOKEN))}`;

    const fbRes = await fetch(fbUrl, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const fbJson = await fbRes.json().catch(() => ({}));

    if (!fbRes.ok) {
      const fbMessage =
        fbJson?.error?.message ??
        fbJson?.message ??
        fbJson?.error ??
        "Facebook API error";
      throw new Error(String(fbMessage));
    }

    const insights = fbJson?.data?.[0] ?? {};

    const actions: Array<{ action_type?: string; value?: string | number }> = Array.isArray(insights?.actions)
      ? insights.actions
      : [];

    const leadAction = actions.find((a) =>
      a?.action_type === "lead" ||
      a?.action_type === "onsite_conversion.lead_grouped" ||
      a?.action_type === "offsite_conversion.fb_pixel_lead"
    );

    let results: number | null = null;
    let cost_per_result: number | null = null;

    const spend = Number(insights?.spend || 0);

    if (leadAction?.value !== undefined && leadAction?.value !== null && leadAction?.value !== "") {
      results = Math.round(Number(leadAction.value));

      const cpat = Array.isArray(insights?.cost_per_action_type) ? insights.cost_per_action_type : [];
      const matching = cpat.find((c: any) => c?.action_type === leadAction.action_type);

      if (matching?.value !== undefined && matching?.value !== null && matching?.value !== "") {
        cost_per_result = Number(matching.value);
      } else if (results) {
        cost_per_result = spend / results;
      }
    }

    const impressions = Math.round(Number(insights?.impressions || 0));
    const clicks = Math.round(Number(insights?.clicks || 0));

    // Backfill the creative image from Meta if we don't already have one
    // (never overwrite a manually-uploaded image), and always refresh the
    // live delivery status (active/paused/learning/etc).
    let imageUrl: string | undefined;
    let deliveryStatus: string | null = null;
    try {
      const richUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(String(meta_ad_id))}?fields=effective_status,adset{learning_stage_info},creative{image_url,thumbnail_url}&access_token=${encodeURIComponent(String(META_SYSTEM_USER_TOKEN))}`;
      let adRes = await fetch(richUrl);
      let adJson = await adRes.json().catch(() => ({}));
      if (!adRes.ok) {
        const basicUrl = `https://graph.facebook.com/v21.0/${encodeURIComponent(String(meta_ad_id))}?fields=effective_status,creative{image_url,thumbnail_url}&access_token=${encodeURIComponent(String(META_SYSTEM_USER_TOKEN))}`;
        adRes = await fetch(basicUrl);
        adJson = await adRes.json().catch(() => ({}));
      }
      if (adRes.ok) {
        deliveryStatus = computeDeliveryStatus(adJson);
        if (!creative.image_url) {
          imageUrl = adJson?.creative?.image_url || adJson?.creative?.thumbnail_url || undefined;
        }
      }
    } catch {
      // Non-fatal — keep the stats refresh even if this lookup fails.
    }

    const updatePayload: Record<string, unknown> = {
      impressions,
      clicks,
      spend,
      results,
      cost_per_result,
      delivery_status: deliveryStatus,
      insights_updated_at: new Date().toISOString(),
    };
    if (imageUrl) updatePayload.image_url = imageUrl;

    const { error: updateError } = await admin
      .from("client_ad_creatives")
      .update(updatePayload)
      .eq("id", creative_id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return jsonResponse({
      ok: true,
      impressions,
      clicks,
      spend,
      results,
      cost_per_result,
      image_url: imageUrl ?? creative.image_url ?? null,
      delivery_status: deliveryStatus,
      insights_updated_at: new Date().toISOString(),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: message }, 500);
  }
});
