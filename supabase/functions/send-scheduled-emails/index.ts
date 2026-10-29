// Edge Function: send-scheduled-emails
// Sends the emails the CRM has queued in scheduled_emails (receipts / tax
// invoices with their PDF attached) through Resend, once their send time
// comes round.
//
//   Scheduled (sql/062 pg_cron, every 5 minutes): header x-cron-secret
//     matches app_secrets.email_cron_secret. Sends everything that's due.
//   Signed-in allowlisted user, body { action }:
//     status            -> { configured, from }
//     send_now { id }   -> sends that one email straight away
//
// Secrets (GitHub repo secrets, copied across by the deploy workflow):
//   RESEND_API_KEY  from resend.com
//   EMAIL_FROM      e.g. "Mr Priceless <accounts@mrpriceless.com>" (a verified domain)
//   EMAIL_REPLY_TO  optional - where client replies go

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "";
const EMAIL_REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") || "";
const configured = () => Boolean(RESEND_API_KEY && EMAIL_FROM);

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));

async function sendOne(admin: any, row: any) {
  const payload: any = {
    from: EMAIL_FROM,
    to: row.to_email.split(/[,;]\s*/).filter(Boolean),
    subject: row.subject,
    text: row.body,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:#15130f;">${escapeHtml(row.body).replace(/\n/g, "<br>")}</div>`,
  };
  if (row.cc_email) payload.cc = row.cc_email.split(/[,;]\s*/).filter(Boolean);
  if (EMAIL_REPLY_TO) payload.reply_to = EMAIL_REPLY_TO;
  if (row.attachment_b64) payload.attachments = [{ filename: row.attachment_name || "attachment.pdf", content: row.attachment_b64 }];

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = out?.message || out?.error || `Resend returned ${res.status}`;
    await admin.from("scheduled_emails").update({ status: "failed", error: String(msg) }).eq("id", row.id);
    return { id: row.id, ok: false, error: String(msg) };
  }
  const sentAt = new Date().toISOString();
  await admin.from("scheduled_emails").update({ status: "sent", sent_at: sentAt, error: null }).eq("id", row.id);
  // Stamp the receipt itself as sent, so the CRM shows it.
  if (row.client_id && row.record_id) {
    const { data: c } = await admin.from("clients").select("onboarding_progress").eq("id", row.client_id).maybeSingle();
    const p = c?.onboarding_progress || {};
    if (Array.isArray(p.invoices)) {
      const invoices = p.invoices.map((r: any) => r.id === row.record_id ? { ...r, sent_at: sentAt, emailed_to: row.to_email } : r);
      await admin.from("clients").update({ onboarding_progress: { ...p, invoices } }).eq("id", row.client_id);
    }
  }
  return { id: row.id, ok: true };
}

// Takes the row so a second run can't send it twice.
async function claim(admin: any, id: string) {
  const { data } = await admin.from("scheduled_emails").update({ status: "sending" })
    .eq("id", id).in("status", ["scheduled", "failed"]).select("*").maybeSingle();
  return data;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: "Server misconfigured: missing Supabase environment variables." }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // The 5-minute schedule.
  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) {
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "email_cron_secret").maybeSingle();
    if (!secret?.value || secret.value !== cronHeader) return json({ error: "Unauthorized." }, 401);
    if (!configured()) return json({ sent: 0, skipped: "Email sending isn't set up yet (RESEND_API_KEY / EMAIL_FROM)." });
    const { data: due } = await admin.from("scheduled_emails").select("id")
      .eq("status", "scheduled").lte("send_at", new Date().toISOString()).order("send_at").limit(25);
    const results = [];
    for (const { id } of due || []) {
      const row = await claim(admin, id);
      if (row) results.push(await sendOne(admin, row));
    }
    return json({ sent: results.filter((r) => r.ok).length, results });
  }

  // Signed-in, allowlisted users.
  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const email = userData?.user?.email;
  if (!email) return json({ error: "Unauthorized." }, 401);
  // Lead Follow Up only logins (allowlist.access = "leads") can't use this.
  const { data: allowed } = await admin.from("allowlist").select("email, access").eq("email", email).maybeSingle();
  if (!allowed || allowed.access === "leads") return json({ error: "Unauthorized." }, 401);

  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }

  if (body.action === "status") return json({ configured: configured(), from: EMAIL_FROM });
  if (body.action === "send_now") {
    if (!configured()) return json({ error: "Email sending isn't set up yet - add the RESEND_API_KEY and EMAIL_FROM secrets." }, 400);
    if (!body.id) return json({ error: "id is required." }, 400);
    const row = await claim(admin, body.id);
    if (!row) return json({ error: "That email has already been sent or cancelled." }, 409);
    const r = await sendOne(admin, row);
    return r.ok ? json({ ok: true }) : json({ error: r.error }, 502);
  }
  return json({ error: "Unknown action." }, 400);
});
