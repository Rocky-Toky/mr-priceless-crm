// Edge Function: sync-client-inbox
// Emails from clients, sent in by a small Google Apps Script that runs every
// 5 minutes inside each teammate's own Gmail (the CRM's Client inbox page
// hands it out). Saved to client_emails so the CRM can show what's waiting on
// a reply. A reply sent from Gmail in the same thread ticks it off by itself.
// An email still waiting after 2 hours gets one reminder email (via Resend,
// if it's set up), never overnight.
//
//   Signed-in allowlisted user, body { action: "make_key" }: a new key for
//     their Gmail script (the old one stops working). Returns it once.
//   Gmail script, header x-inbox-key:
//     { action: "senders" } -> who counts as a client, and the threads still
//                              waiting on a reply in this inbox
//     { action: "push", inbox, messages, replies } -> saves them
//   Scheduled (sql/075 pg_cron, every 5 minutes): header x-cron-secret
//     matches app_secrets.inbox_cron_secret. Sends the 2-hour reminders.
//
// Keys are stored hashed in app_secrets (no browser access). Optional
// secrets: RESEND_API_KEY + EMAIL_FROM for the reminder.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret, x-inbox-key",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "";
const CRM_URL = "https://rocky-toky.github.io/mr-priceless-crm/";
const REMIND_AFTER_MS = 2 * 3600e3;
const keyName = (userId: string) => `inbox_key:${userId}`;

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
async function sha256(s: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);

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

// Which teammate a Gmail script key belongs to.
async function userForKey(admin: any, key: string) {
  if (!key || key.length < 20) return null;
  const hash = await sha256(key);
  const { data } = await admin.from("app_secrets").select("name").like("name", "inbox_key:%").eq("value", hash).maybeSingle();
  return data ? String(data.name).slice("inbox_key:".length) : null;
}

async function push(admin: any, userId: string, body: any) {
  const inbox = cleanEmail(body.inbox);
  const match = await clientMatchers(admin);
  let added = 0, replied = 0;
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 200) : [];
  if (messages.length) {
    const ids = messages.map((m: any) => clip(m.gmail_id, 100)).filter(Boolean);
    const { data: have } = await admin.from("client_emails").select("gmail_id").eq("user_id", userId).in("gmail_id", ids);
    const known = new Set((have || []).map((h: any) => h.gmail_id));
    for (const m of messages) {
      const gmailId = clip(m.gmail_id, 100);
      if (!gmailId || known.has(gmailId)) continue;
      const from = parseFrom(clip(m.from, 300));
      const client = match.byEmail.get(from.email) || match.byDomain.get(domainOf(from.email));
      if (!client) continue;
      const received = new Date(m.received_at);
      const { error } = await admin.from("client_emails").insert({
        user_id: userId, inbox_email: inbox, gmail_id: gmailId, thread_id: clip(m.thread_id, 100) || null,
        message_id: clip(m.message_id, 300) || null, client_id: client.id, client_name: client.name,
        from_email: from.email, from_name: from.name, subject: clip(m.subject, 300), snippet: clip(m.snippet, 400),
        received_at: isNaN(received.getTime()) ? new Date().toISOString() : received.toISOString(),
      });
      if (!error) added++; // a duplicate (cc'd to both of us) is skipped by the unique Message-ID
    }
  }
  // Threads someone has replied in since the client's email came in.
  for (const r of Array.isArray(body.replies) ? body.replies.slice(0, 300) : []) {
    const at = new Date(r.replied_at);
    if (!r.thread_id || isNaN(at.getTime())) continue;
    const { data } = await admin.from("client_emails").update({ status: "replied", replied_at: at.toISOString() })
      .eq("user_id", userId).eq("thread_id", clip(r.thread_id, 100)).eq("status", "new").lt("received_at", at.toISOString()).select("id");
    replied += (data || []).length;
  }
  await admin.from("inbox_connections").upsert({ user_id: userId, email: inbox || undefined, status: "ok", error: null, last_sync_at: new Date().toISOString() });
  return { added, replied };
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: "Server misconfigured." }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });
  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }

  // The 5-minute schedule: reminders.
  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) {
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "inbox_cron_secret").maybeSingle();
    if (!secret?.value || secret.value !== cronHeader) return json({ error: "Unauthorized." }, 401);
    return json({ reminders: await remind(admin) });
  }

  // A teammate's Gmail script.
  const inboxKey = req.headers.get("x-inbox-key");
  if (inboxKey) {
    const userId = await userForKey(admin, inboxKey);
    if (!userId) return json({ error: "That key isn't valid any more - copy a fresh script from the CRM's Client inbox page." }, 401);
    if (body.action === "senders") {
      const match = await clientMatchers(admin);
      const { data: open } = await admin.from("client_emails").select("thread_id").eq("user_id", userId).eq("status", "new").not("thread_id", "is", null).limit(200);
      return json({
        senders: [...match.byEmail.keys(), ...match.byDomain.keys()],
        open_threads: [...new Set((open || []).map((o: any) => o.thread_id))],
      });
    }
    if (body.action === "push") return json({ ok: true, ...(await push(admin, userId, body)) });
    return json({ error: "Unknown action." }, 400);
  }

  // Signed-in, allowlisted users.
  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const user = userData?.user;
  if (!user?.email) return json({ error: "Unauthorized." }, 401);
  const { data: allowed } = await admin.from("allowlist").select("email").ilike("email", user.email).maybeSingle();
  if (!allowed) return json({ error: "Unauthorized." }, 401);

  if (body.action === "make_key") {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await admin.from("app_secrets").upsert({ name: keyName(user.id), value: await sha256(key) });
    const { data: conn } = await admin.from("inbox_connections").select("user_id").eq("user_id", user.id).maybeSingle();
    // The Gmail address fills in from the script's first check - it's often not the CRM login.
    if (!conn) await admin.from("inbox_connections").insert({ user_id: user.id, email: null, status: "waiting" });
    else await admin.from("inbox_connections").update({ status: "waiting", error: null }).eq("user_id", user.id);
    return json({ key });
  }
  return json({ error: "Unknown action." }, 400);
});
