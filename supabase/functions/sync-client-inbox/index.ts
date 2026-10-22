// Edge Function: sync-client-inbox
// Looks through each teammate's connected Gmail for emails from a client and
// saves them to client_emails, so the CRM can show what's waiting on a reply.
// A reply sent from Gmail in the same thread ticks the email off by itself.
// An email still waiting after 2 hours gets one reminder email (via Resend,
// if it's set up), never overnight.
//
//   Scheduled (sql/074 pg_cron, every 5 minutes): header x-cron-secret
//     matches app_secrets.inbox_cron_secret. Checks every inbox.
//   Signed-in allowlisted user, body { action: "sync" }: checks every inbox
//     now (the CRM's "Check now" button, and straight after connecting).
//
// Secrets: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (already set for Google
// sign-in). Optional: RESEND_API_KEY + EMAIL_FROM for the 2-hour reminder.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID") || "";
const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "";
const CRM_URL = "https://rocky-toky.github.io/mr-priceless-crm/";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const REMIND_AFTER_MS = 2 * 3600e3;

// Shared mailbox providers - a client on one of these is matched by their
// exact address. Anyone else is matched by their whole domain, so their
// office manager or bookkeeper counts too.
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "outlook.co.nz", "hotmail.com", "hotmail.co.nz", "hotmail.com.au",
  "live.com", "live.com.au", "live.co.nz", "msn.com", "yahoo.com", "yahoo.co.nz", "yahoo.com.au", "icloud.com",
  "me.com", "mac.com", "aol.com", "protonmail.com", "proton.me", "gmx.com", "mail.com", "zoho.com",
  "xtra.co.nz", "slingshot.co.nz", "orcon.net.nz", "vodafone.co.nz", "spark.co.nz", "actrix.co.nz", "clear.net.nz",
  "bigpond.com", "bigpond.net.au", "optusnet.com.au", "iinet.net.au", "tpg.com.au", "internode.on.net",
]);
const OWN_DOMAINS = new Set(["mrpriceless.com", "mrpriceless.co.nz"]);

const cleanEmail = (s: string) => String(s || "").trim().toLowerCase();
const domainOf = (e: string) => e.split("@")[1] || "";
function parseFrom(v: string) {
  const m = String(v || "").match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim(), email: cleanEmail(m[2]) } : { name: "", email: cleanEmail(v) };
}
const header = (msg: any, name: string) =>
  (msg?.payload?.headers || []).find((h: any) => String(h.name).toLowerCase() === name.toLowerCase())?.value || "";

// Who counts as a client: their main email and report email, on every client
// we're still working with.
async function clientMatchers(admin: any) {
  const { data } = await admin.from("clients").select("id, name, email, report_email, stage");
  const byEmail = new Map<string, any>(), byDomain = new Map<string, any>();
  for (const c of data || []) {
    if (["churned", "archived"].includes(String(c.stage || ""))) continue;
    for (const raw of [c.email, c.report_email]) {
      for (const part of String(raw || "").split(/[,;\s]+/)) {
        const e = cleanEmail(part);
        if (!e.includes("@")) continue;
        const d = domainOf(e);
        if (OWN_DOMAINS.has(d)) continue;
        byEmail.set(e, c);
        if (!PERSONAL_DOMAINS.has(d)) byDomain.set(d, c);
      }
    }
  }
  return { byEmail, byDomain };
}

async function accessToken(refresh: string) {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: refresh, grant_type: "refresh_token" }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return { error: d.error === "invalid_grant" ? "needs_connect" : (d.error_description || d.error || `Google returned ${r.status}`) };
  return { token: d.access_token as string, scope: String(d.scope || "") };
}

async function gmail(token: string, path: string) {
  const r = await fetch(GMAIL + path, { headers: { Authorization: `Bearer ${token}` } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d?.error?.message || `Gmail returned ${r.status}`), { status: r.status });
  return d;
}

async function syncInbox(admin: any, row: any, match: any) {
  const conn = (patch: any) => admin.from("inbox_connections").upsert({ user_id: row.user_id, ...patch });
  const t = await accessToken(row.refresh_token);
  if (t.error) { await conn({ status: t.error === "needs_connect" ? "needs_connect" : "error", error: t.error }); return { user: row.user_id, error: t.error }; }
  if (!String(t.scope || "").includes("gmail")) { await conn({ status: "needs_connect", error: "Gmail access not given yet" }); return { user: row.user_id, error: "no gmail scope" }; }
  const token = t.token!;
  let added = 0, replied = 0;
  try {
    const profile = await gmail(token, "/profile");
    const inbox = cleanEmail(profile.emailAddress);

    // New emails from clients in the last 2 days, in batches of senders.
    const senders = [...[...match.byEmail.keys()].map((e: string) => `from:${e}`), ...[...match.byDomain.keys()].map((d: string) => `from:@${d}`)];
    const ids = new Set<string>();
    for (let i = 0; i < senders.length; i += 25) {
      const q = `newer_than:2d -in:sent -in:chats -in:spam -in:trash {${senders.slice(i, i + 25).join(" ")}}`;
      const list = await gmail(token, `/messages?maxResults=100&q=${encodeURIComponent(q)}`);
      (list.messages || []).forEach((m: any) => ids.add(m.id));
    }
    if (ids.size) {
      const { data: have } = await admin.from("client_emails").select("gmail_id").eq("user_id", row.user_id).in("gmail_id", [...ids]);
      const known = new Set((have || []).map((h: any) => h.gmail_id));
      for (const id of ids) {
        if (known.has(id)) continue;
        const msg = await gmail(token, `/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Message-ID`);
        const from = parseFrom(header(msg, "From"));
        const client = match.byEmail.get(from.email) || match.byDomain.get(domainOf(from.email));
        if (!client) continue;
        const { error } = await admin.from("client_emails").insert({
          user_id: row.user_id, inbox_email: inbox, gmail_id: id, thread_id: msg.threadId,
          message_id: header(msg, "Message-ID") || null, client_id: client.id, client_name: client.name,
          from_email: from.email, from_name: from.name, subject: header(msg, "Subject").slice(0, 300),
          snippet: String(msg.snippet || "").slice(0, 400), received_at: new Date(Number(msg.internalDate) || Date.now()).toISOString(),
        });
        if (!error) added++; // a duplicate (cc'd to both of us) is skipped by the unique Message-ID
      }
    }

    // Anything still waiting: has someone replied in that thread since?
    const { data: open } = await admin.from("client_emails").select("id, thread_id, received_at").eq("user_id", row.user_id).eq("status", "new").limit(100);
    for (const e of open || []) {
      if (!e.thread_id) continue;
      const th = await gmail(token, `/threads/${e.thread_id}?format=minimal`).catch(() => null);
      const after = new Date(e.received_at).getTime();
      const reply = (th?.messages || []).find((m: any) => (m.labelIds || []).includes("SENT") && Number(m.internalDate) > after);
      if (reply) {
        await admin.from("client_emails").update({ status: "replied", replied_at: new Date(Number(reply.internalDate)).toISOString() }).eq("id", e.id);
        replied++;
      }
    }
    await conn({ email: inbox, status: "ok", error: null, last_sync_at: new Date().toISOString() });
    return { user: row.user_id, added, replied };
  } catch (err: any) {
    const needs = err?.status === 401 || err?.status === 403;
    await conn({ status: needs ? "needs_connect" : "error", error: String(err?.message || err).slice(0, 300) });
    return { user: row.user_id, error: String(err?.message || err) };
  }
}

// One nudge per email that's waited 2 hours, sent to whichever inbox it came
// into. Held back between 8pm and 7am NZ time.
async function remind(admin: any) {
  if (!RESEND_API_KEY || !EMAIL_FROM) return 0;
  const hour = Number(new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  if (hour < 7 || hour >= 20) return 0;
  const { data } = await admin.from("client_emails").select("*").eq("status", "new").is("reminded_at", null)
    .lt("received_at", new Date(Date.now() - REMIND_AFTER_MS).toISOString()).limit(20);
  let sent = 0;
  for (const e of data || []) {
    if (!e.inbox_email) continue;
    const hrs = Math.floor((Date.now() - new Date(e.received_at).getTime()) / 3600e3);
    const text = `${e.client_name || e.from_email} emailed ${hrs} hours ago and is still waiting on a reply.\n\n` +
      `From: ${e.from_name ? e.from_name + " <" + e.from_email + ">" : e.from_email}\nSubject: ${e.subject || "(no subject)"}\n\n${e.snippet}\n\n` +
      `Open it in Gmail: https://mail.google.com/mail/u/${encodeURIComponent(e.inbox_email)}/#all/${e.thread_id}\nClient inbox: ${CRM_URL}`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: EMAIL_FROM, to: [e.inbox_email], subject: `Reply needed: ${e.client_name || e.from_email} - ${e.subject || "(no subject)"}`.slice(0, 200), text }),
    });
    await admin.from("client_emails").update({ reminded_at: new Date().toISOString() }).eq("id", e.id);
    if (r.ok) sent++;
  }
  return sent;
}

async function syncAll(admin: any) {
  const { data: tokens } = await admin.from("google_tokens").select("user_id, refresh_token");
  const match = await clientMatchers(admin);
  const results = [];
  for (const row of tokens || []) results.push(await syncInbox(admin, row, match));
  const reminders = await remind(admin);
  return { results, reminders };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: "Server misconfigured." }, 500);
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return json({ error: "Google isn't set up on the server (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)." }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) {
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "inbox_cron_secret").maybeSingle();
    if (!secret?.value || secret.value !== cronHeader) return json({ error: "Unauthorized." }, 401);
    const out = await syncAll(admin);
    // Only counts in the log - never who emailed or what they said.
    return json({ inboxes: out.results.length, added: out.results.reduce((t: number, r: any) => t + (r.added || 0), 0), reminders: out.reminders });
  }

  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const email = userData?.user?.email;
  if (!email) return json({ error: "Unauthorized." }, 401);
  const { data: allowed } = await admin.from("allowlist").select("email").ilike("email", email).maybeSingle();
  if (!allowed) return json({ error: "Unauthorized." }, 401);

  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }
  if (body.action === "sync") {
    const out = await syncAll(admin);
    const mine = out.results.find((r: any) => r.user === userData.user?.id);
    return json({ ok: true, mine: mine ? { added: mine.added || 0, error: mine.error || null } : { error: "not connected" } });
  }
  return json({ error: "Unknown action." }, 400);
});
