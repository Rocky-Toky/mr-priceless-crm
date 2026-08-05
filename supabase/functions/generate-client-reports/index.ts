// Edge Function: generate-client-reports
// Two ways to trigger it:
//  1. Scheduled (see sql/011_reporting_meta_integration.sql cron job): no body,
//     header x-cron-secret matches REPORT_CRON_SECRET. Sends every client whose
//     report_frequency is due (weekly = every 7 days, monthly = every 30 days).
//  2. Manual "Send Now" from the CRM: body { client_id }, caller is a signed-in
//     allowlisted user. Sends that one client's report immediately regardless
//     of whether it's due yet - handy for testing or an ad-hoc report.
//
// Pulls performance data straight from the Meta Marketing API using a
// Business Manager System User access token (META_SYSTEM_USER_TOKEN) - that
// token is agency-wide and doesn't expire the way a personal login does,
// which is what makes unattended scheduled sending possible. Emails are sent
// through Resend (RESEND_API_KEY / REPORT_FROM_EMAIL).
//
// Each email opens with a plain-English narrative (leads, cost per lead,
// trend vs the last period, and a creative-fatigue signal based on ad
// frequency / CTR) built from this period's numbers plus whatever the
// previous client_reports row for that client recorded.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const META_API_VERSION = "v21.0";
const LEAD_ACTION_TYPES = ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
  const META_TOKEN = Deno.env.get("META_SYSTEM_USER_TOKEN");
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
  const REPORT_FROM_EMAIL = Deno.env.get("REPORT_FROM_EMAIL");
  const REPORT_CRON_SECRET = Deno.env.get("REPORT_CRON_SECRET");

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !SUPABASE_ANON_KEY) {
    return json({ error: "Server misconfigured: missing Supabase environment variables." }, 500);
  }
  if (!META_TOKEN) {
    return json({ error: "META_SYSTEM_USER_TOKEN secret is not set on this project yet." }, 500);
  }
  if (!RESEND_API_KEY || !REPORT_FROM_EMAIL) {
    return json({ error: "RESEND_API_KEY / REPORT_FROM_EMAIL secrets are not set on this project yet." }, 500);
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const isCron = Boolean(REPORT_CRON_SECRET) && req.headers.get("x-cron-secret") === REPORT_CRON_SECRET;
  let body: { client_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body is fine for the cron call */ }

  if (!isCron) {
    // Manual trigger: require a real signed-in, allowlisted user.
    const authHeader = req.headers.get("Authorization") ?? "";
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData } = await userClient.auth.getUser();
    const email = userData?.user?.email;
    if (!email) return json({ error: "Unauthorized." }, 401);
    const { data: allowed } = await admin.from("allowlist").select("email").eq("email", email).maybeSingle();
    if (!allowed) return json({ error: "Unauthorized." }, 401);
    if (!body.client_id) return json({ error: "client_id is required for a manual send." }, 400);
  }

  let clients: any[] = [];
  if (body.client_id) {
    const { data, error } = await admin.from("clients").select("*").eq("id", body.client_id).single();
    if (error || !data) return json({ error: "Client not found." }, 404);
    clients = [data];
  } else {
    const { data, error } = await admin.from("clients").select("*")
      .not("meta_ad_account_id", "is", null)
      .not("report_email", "is", null)
      .neq("report_frequency", "off");
    if (error) return json({ error: error.message }, 500);
    clients = (data || []).filter((c) => isDue(c));
  }

  const results: Record<string, unknown>[] = [];

  for (const client of clients) {
    if (!client.meta_ad_account_id || !client.report_email) {
      results.push({ client_id: client.id, status: "skipped", reason: "missing ad account or email" });
      continue;
    }
    const days = client.report_frequency === "weekly" ? 7 : 30;
    const periodEnd = new Date();
    const periodStart = new Date(periodEnd.getTime() - days * 24 * 60 * 60 * 1000);

    try {
      const insights = await fetchMetaInsights(client.meta_ad_account_id, periodStart, periodEnd, META_TOKEN);

      const { data: prevReport } = await admin
        .from("client_reports")
        .select("metrics")
        .eq("client_id", client.id)
        .eq("status", "sent")
        .lt("period_end", dateStr(periodStart))
        .order("period_end", { ascending: false })
        .limit(1)
        .maybeSingle();
      const prevInsights = prevReport?.metrics ?? null;

      const narrative = buildNarrative(insights, prevInsights, days);

      await sendReportEmail(client, periodStart, periodEnd, insights, narrative, RESEND_API_KEY, REPORT_FROM_EMAIL);
      await admin.from("client_reports").insert({
        client_id: client.id,
        period_start: dateStr(periodStart),
        period_end: dateStr(periodEnd),
        metrics: { ...insights, narrative },
        status: "sent",
      });
      await admin.from("clients").update({ last_report_sent_at: new Date().toISOString() }).eq("id", client.id);
      results.push({ client_id: client.id, status: "sent" });
    } catch (e) {
      const message = String(e instanceof Error ? e.message : e);
      await admin.from("client_reports").insert({
        client_id: client.id,
        period_start: dateStr(periodStart),
        period_end: dateStr(periodEnd),
        metrics: {},
        status: "failed",
        error: message,
      });
      results.push({ client_id: client.id, status: "failed", error: message });
    }
  }

  return json({ processed: results.length, results });
});

function isDue(client: any): boolean {
  if (!client.last_report_sent_at) return true;
  const days = client.report_frequency === "weekly" ? 7 : 30;
  const dueAt = new Date(client.last_report_sent_at).getTime() + days * 24 * 60 * 60 * 1000;
  return Date.now() >= dueAt;
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function findLeadAction(actions: any[] | undefined) {
  return (actions || []).find((a) => LEAD_ACTION_TYPES.includes(a?.action_type));
}

// Builds a short, plain-English summary of the period: leads + cost per
// lead, how that compares to the previous period, and a creative-fatigue
// signal (high ad frequency, or a big CTR drop vs last period).
function buildNarrative(insights: any, prevInsights: any, days: number): string {
  const periodLabel = days === 7 ? "this week" : "this month";
  const spend = Number(insights?.spend || 0);
  const leadAction = findLeadAction(insights?.actions);
  const leads = leadAction ? Math.round(Number(leadAction.value)) : 0;
  const cpl = leads > 0 ? spend / leads : null;
  const frequency = Number(insights?.frequency || 0);
  const ctr = Number(insights?.ctr || 0);
  const fmtMoney = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

  const lines: string[] = [];

  if (leads > 0) {
    lines.push(
      `You generated ${leads} lead${leads === 1 ? "" : "s"} ${periodLabel} from ${fmtMoney(spend)} in ad spend` +
      (cpl != null ? `, working out to ${fmtMoney(cpl)} per lead.` : ".")
    );
  } else if (spend > 0) {
    lines.push(`${fmtMoney(spend)} was spent ${periodLabel} but no leads came through in that window - worth flagging if that doesn't line up with what you're seeing on your end.`);
  } else {
    lines.push(`No ad spend was recorded ${periodLabel}.`);
  }

  if (prevInsights) {
    const prevLeadAction = findLeadAction(prevInsights?.actions);
    const prevLeads = prevLeadAction ? Math.round(Number(prevLeadAction.value)) : 0;
    const prevSpend = Number(prevInsights?.spend || 0);
    const prevCpl = prevLeads > 0 ? prevSpend / prevLeads : null;
    if (cpl != null && prevCpl != null && prevCpl > 0) {
      const change = ((cpl - prevCpl) / prevCpl) * 100;
      if (Math.abs(change) >= 10) {
        lines.push(`Cost per lead is ${change > 0 ? "up" : "down"} ${Math.abs(Math.round(change))}% versus last period${change > 0 ? " - worth keeping an eye on" : " - nice improvement"}.`);
      } else {
        lines.push("Cost per lead is holding steady versus last period.");
      }
    }
  }

  if (frequency >= 3.5) {
    lines.push(`Ad frequency is at ${frequency.toFixed(1)} - people are seeing the same creative a lot, which usually means it's starting to fatigue. Worth rotating in something fresh soon.`);
  } else if (prevInsights) {
    const prevCtr = Number(prevInsights?.ctr || 0);
    if (prevCtr > 0 && ctr > 0 && ctr < prevCtr * 0.75) {
      lines.push("Click-through rate has dropped noticeably versus last period, which can also point to creative fatigue - might be worth testing some new angles.");
    }
  }

  return lines.join(" ");
}

async function fetchMetaInsights(adAccountId: string, since: Date, until: Date, token: string) {
  const fields = "spend,impressions,reach,clicks,ctr,cpc,cpm,frequency,actions,cost_per_action_type";
  const timeRange = encodeURIComponent(JSON.stringify({ since: dateStr(since), until: dateStr(until) }));
  const url = `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}/insights?fields=${fields}&time_range=${timeRange}&access_token=${encodeURIComponent(token)}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Meta API error: ${data?.error?.message || JSON.stringify(data)}`);
  return data?.data?.[0] || { spend: "0", impressions: "0", reach: "0", clicks: "0", ctr: "0", cpc: "0", cpm: "0", frequency: "0", actions: [], cost_per_action_type: [] };
}

async function sendReportEmail(client: any, periodStart: Date, periodEnd: Date, insights: any, narrative: string, apiKey: string, fromEmail: string) {
  const fmtMoney = (n: string | number) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  const fmtNum = (n: string | number) => Number(n || 0).toLocaleString();
  const actions = (insights.actions || []) as { action_type: string; value: string }[];
  const costs = (insights.cost_per_action_type || []) as { action_type: string; value: string }[];
  const resultsRows = actions.map((a) => {
    const cost = costs.find((c) => c.action_type === a.action_type);
    return `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee;">${escapeHtml(prettyActionType(a.action_type))}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${fmtNum(a.value)}</td>
      <td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;">${cost ? fmtMoney(cost.value) : "-"}</td></tr>`;
  }).join("");

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#15130f;">
      <h2 style="color:#b8912c;">${escapeHtml(client.name)} - Ad Performance Report</h2>
      <p style="color:#6f6a5e;">${dateStr(periodStart)} to ${dateStr(periodEnd)}</p>
      ${narrative ? `<p style="background:#faf6ea;border:1px solid #e8c468;border-radius:8px;padding:14px 16px;line-height:1.6;">${escapeHtml(narrative)}</p>` : ""}
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><td style="padding:8px 12px;background:#faf9f5;font-weight:bold;">Spend</td><td style="padding:8px 12px;background:#faf9f5;text-align:right;">${fmtMoney(insights.spend)}</td></tr>
        <tr><td style="padding:8px 12px;">Impressions</td><td style="padding:8px 12px;text-align:right;">${fmtNum(insights.impressions)}</td></tr>
        <tr><td style="padding:8px 12px;background:#faf9f5;">Reach</td><td style="padding:8px 12px;background:#faf9f5;text-align:right;">${fmtNum(insights.reach)}</td></tr>
        <tr><td style="padding:8px 12px;">Frequency</td><td style="padding:8px 12px;text-align:right;">${Number(insights.frequency || 0).toFixed(2)}</td></tr>
        <tr><td style="padding:8px 12px;background:#faf9f5;">Clicks</td><td style="padding:8px 12px;background:#faf9f5;text-align:right;">${fmtNum(insights.clicks)}</td></tr>
        <tr><td style="padding:8px 12px;">CTR</td><td style="padding:8px 12px;text-align:right;">${Number(insights.ctr || 0).toFixed(2)}%</td></tr>
        <tr><td style="padding:8px 12px;background:#faf9f5;">CPC</td><td style="padding:8px 12px;background:#faf9f5;text-align:right;">${fmtMoney(insights.cpc)}</td></tr>
      </table>
      ${actions.length ? `
      <h3>Results</h3>
      <table style="width:100%;border-collapse:collapse;">
        <tr><th style="text-align:left;padding:6px 12px;border-bottom:2px solid #b8912c;">Type</th><th style="text-align:right;padding:6px 12px;border-bottom:2px solid #b8912c;">Count</th><th style="text-align:right;padding:6px 12px;border-bottom:2px solid #b8912c;">Cost Each</th></tr>
        ${resultsRows}
      </table>` : ""}
      <p style="color:#6f6a5e;font-size:12px;margin-top:30px;">Sent automatically by Mr Priceless.</p>
    </div>
  `;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: fromEmail,
      to: client.report_email,
      subject: `${client.name} - Ad Performance Report (${dateStr(periodStart)} to ${dateStr(periodEnd)})`,
      html,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Resend error: ${data?.message || JSON.stringify(data)}`);
}

function prettyActionType(type: string): string {
  return type.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
