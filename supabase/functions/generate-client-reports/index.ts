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

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

const META_API_VERSION = "v21.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const META_TOKEN = Deno.env.get("META_SYSTEM_USER_TOKEN")!;
  const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
  const REPORT_FROM_EMAIL = Deno.env.get("REPORT_FROM_EMAIL")!;
  const REPORT_CRON_SECRET = Deno.env.get("REPORT_CRON_SECRET");

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const isCron = Boolean(REPORT_CRON_SECRET) && req.headers.get("x-cron-secret") === REPORT_CRON_SECRET;
  let body: { client_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body is fine for the cron call */ }

  if (!isCron) {
    // Manual trigger: require a real signed-in, allowlisted user.
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(SUPABASE_URL, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user?.email) return json({ error: "Unauthorized." }, 401);
    const { data: allowed } = await admin.from("allowlist").select("email").eq("email", user.email).maybeSingle();
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
      await sendReportEmail(client, periodStart, periodEnd, insights, RESEND_API_KEY, REPORT_FROM_EMAIL);
      await admin.from("client_reports").insert({
        client_id: client.id,
        period_start: dateStr(periodStart),
        period_end: dateStr(periodEnd),
        metrics: insights,
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

async function fetchMetaInsights(adAccountId: string, since: Date, until: Date, token: string) {
  const fields = "spend,impressions,reach,clicks,ctr,cpc,cpm,actions,cost_per_action_type";
  const timeRange = encodeURIComponent(JSON.stringify({ since: dateStr(since), until: dateStr(until) }));
  const url = `https://graph.facebook.com/${META_API_VERSION}/${adAccountId}/insights?fields=${fields}&time_range=${timeRange}&access_token=${token}`;
  const resp = await fetch(url);
  const data = await resp.json();
  if (!resp.ok) throw new Error(`Meta API error: ${data?.error?.message || JSON.stringify(data)}`);
  return data?.data?.[0] || { spend: "0", impressions: "0", reach: "0", clicks: "0", ctr: "0", cpc: "0", cpm: "0", actions: [], cost_per_action_type: [] };
}

async function sendReportEmail(client: any, periodStart: Date, periodEnd: Date, insights: any, apiKey: string, fromEmail: string) {
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
      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tr><td style="padding:8px 12px;background:#faf9f5;font-weight:bold;">Spend</td><td style="padding:8px 12px;background:#faf9f5;text-align:right;">${fmtMoney(insights.spend)}</td></tr>
        <tr><td style="padding:8px 12px;">Impressions</td><td style="padding:8px 12px;text-align:right;">${fmtNum(insights.impressions)}</td></tr>
        <tr><td style="padding:8px 12px;background:#faf9f5;">Reach</td><td style="padding:8px 12px;background:#faf9f5;text-align:right;">${fmtNum(insights.reach)}</td></tr>
        <tr><td style="padding:8px 12px;">Clicks</td><td style="padding:8px 12px;text-align:right;">${fmtNum(insights.clicks)}</td></tr>
        <tr><td style="padding:8px 12px;background:#faf9f5;">CTR</td><td style="padding:8px 12px;background:#faf9f5;text-align:right;">${Number(insights.ctr || 0).toFixed(2)}%</td></tr>
        <tr><td style="padding:8px 12px;">CPC</td><td style="padding:8px 12px;text-align:right;">${fmtMoney(insights.cpc)}</td></tr>
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
