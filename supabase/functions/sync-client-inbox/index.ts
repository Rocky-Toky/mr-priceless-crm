// Edge Function: sync-client-inbox
// Emails from clients, or that name one of our clients (company name or
// website) - not promotions, automated notices, big companies or job
// applications - sent in by a small Google Apps Script that runs every
// minute inside each teammate's own Gmail (the CRM's Client inbox page
// hands it out). Saved to client_emails so the CRM can show what's waiting on
// a reply. A reply sent from Gmail in the same thread ticks it off by itself.
// An email still waiting after 2 hours gets one reminder email (via Resend,
// if it's set up), never overnight.
//
//   Signed-in allowlisted user, body { action: "make_key" }: a new key for
//     their Gmail script (the old one stops working). Returns it once.
//   Gmail script (every minute), header x-inbox-key:
//     { action: "senders" } -> what to search for, who counts as a client, and
//                              the threads still waiting on a reply in this inbox
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

// What the Gmail script searches (it runs every minute and only looks at
// threads that changed): every recent email except Gmail's Promotions, Social
// and Forums tabs. push() then drops what's left that isn't from a real
// person: automated senders, big companies and job applications. Emails from
// clients always count; anyone else's only if it names one of our clients. Once per connection, the script also works through
// what's already in the inbox (BACKFILL_QUERY), a page at a time.
// No Gmail tab is left out: a client's email filed under Promotions or Updates
// still counts, and the server's filter does the sorting.
const INBOX_QUERY = "newer_than:2d -in:sent -in:chats -in:spam -in:trash -in:drafts";
const BACKFILL_QUERY = "newer_than:60d -in:sent -in:chats -in:spam -in:trash -in:drafts {in:inbox newer_than:7d}";
const BACKFILL_DAYS = 60;
// Bump this to have every connected Gmail go through its inbox again (e.g.
// after matching improves, so emails skipped before get another look).
const BACKFILL_VERSION = "2";
const backfillName = (userId: string) => `inbox_backfill:${userId}`;
const AUTOMATED_SENDER = /^(no-?reply|do-?not-?reply|donotreply|noreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|newsletters?|news|marketing|promo(tions)?|updates?|digest|automated|system|calendar-notification|invitations?|drive-shares-[a-z-]*|comments-noreply)([+._-].*)?$/;
// Big companies and platforms: their emails are notices, not people.
const COMPANY_DOMAINS = [
  "facebook.com", "facebookmail.com", "meta.com", "metamail.com", "instagram.com", "whatsapp.com", "fb.com",
  "google.com", "youtube.com", "linkedin.com", "microsoft.com", "office.com", "office365.com", "apple.com", "amazon.com", "amazonaws.com", "aws.com", "tiktok.com", "x.com", "twitter.com", "pinterest.com", "snapchat.com",
  "xero.com", "myob.com", "quickbooks.com", "intuit.com", "stripe.com", "paypal.com", "square.com", "afterpay.com", "wise.com",
  "shopify.com", "wix.com", "squarespace.com", "wordpress.com", "godaddy.com", "namecheap.com", "cloudflare.com", "hostinger.com",
  "canva.com", "slack.com", "zoom.us", "notion.so", "atlassian.com", "atlassian.net", "github.com", "gitlab.com", "figma.com", "adobe.com", "dropbox.com", "docusign.net", "docusign.com",
  "gohighlevel.com", "leadconnectorhq.com", "msgsndr.com", "hubspot.com", "hubspotemail.net", "mailchimp.com", "mcsv.net", "sendgrid.net", "klaviyo.com", "intercom.io", "calendly.com", "typeform.com", "zapier.com", "openai.com", "anthropic.com", "supabase.com", "supabase.io", "resend.com", "twilio.com",
  "seek.co.nz", "seek.com.au", "indeed.com", "trademe.co.nz", "builderscrack.co.nz", "nocowboys.co.nz", "hipages.com.au", "airtasker.com", "upwork.com", "fiverr.com",
  "uber.com", "airbnb.com", "booking.com", "airnewzealand.co.nz", "qantas.com", "jetstar.com",
  "anz.co.nz", "asb.co.nz", "westpac.co.nz", "bnz.co.nz", "kiwibank.co.nz", "commbank.com.au", "nab.com.au",
  "govt.nz", "nzpost.co.nz", "spark.co.nz", "one.nz", "2degrees.nz", "vodafone.co.nz", "mercury.co.nz", "contact.co.nz", "genesisenergy.co.nz",
];
const JOB_APPLICATION = /\b(job application|application for|applying for|applied for|apply for the|my (cv|resume)|curriculum vitae|cover letter|resume attached|cv attached|interested in the (role|position)|position of|the (role|position) (of|you advertised)|vacancy|job (ad|listing|opening)|candidate)\b/i;
const isCompany = (domain: string) => COMPANY_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
// Whether an email from someone who isn't on a client's record still counts:
// it has to name one of our clients (their company name or website) and come
// from a real person, not a newsletter, automated notice, big company or job
// application. Returns the client it's about.
const textOf = (s: unknown) => ` ${String(s ?? "").toLowerCase().replace(/[^a-z0-9.@&']+/g, " ")} `;
function aboutAClient(from: { name: string; email: string }, m: any, match: any) {
  if (!fromAPerson(from, m)) return null;
  return mentions(textOf([from.name, from.email, m.subject, m.snippet].join(" ")), match);
}
function mentions(text: string, match: any) {
  for (const [d, c] of match.domainList) if (text.includes(d)) return c;
  for (const [name, c] of match.names) if (text.includes(` ${name} `)) return c;
  return null;
}
// A sender whose own domain is the client's name ("ascendfinancials.co.nz")
// is the client, even if that address isn't saved on their record.
function ownDomainClient(email: string, match: any) {
  const d = domainOf(email);
  if (!d || PERSONAL_DOMAINS.has(d) || OWN_DOMAINS.has(d) || isCompany(d)) return null;
  const host = d.split(".")[0].replace(/[^a-z0-9]/g, "");
  for (const [compact, c] of match.compacts) if (host.includes(compact)) return c;
  return null;
}
// Words that say what a business does rather than who it is, so "Ascend
// Financials" can also be found as "Ascend".
const TRADE_WORDS = new Set(("and the of co company group nz new zealand au australia ltd limited services service solutions builders building build " +
  "construction constructions concrete roofing roofers plumbing plumbers electrical electric electricians landscaping landscapes " +
  "renovations renovation renos homes home group financial financials finance accounting accountants property properties projects " +
  "contracting contractors painting painters decorators fencing decks decking kitchens bathrooms joinery carpentry flooring tiling " +
  "glass glazing windows doors maintenance trades industries enterprises holdings trust partners studio design designs interiors civil " +
  "earthworks drainage excavation scaffolding cladding insulation heating ventilation cleaning gardens pools spas steel welding engineering").split(" "));
function fromAPerson(from: { email: string }, m: any) {
  const [local, domain] = [from.email.split("@")[0] || "", domainOf(from.email)];
  if (!domain || OWN_DOMAINS.has(domain)) return false;
  if (m.bulk) return false; // newsletters and mailing lists (List-Unsubscribe, Precedence: bulk)
  if (AUTOMATED_SENDER.test(local)) return false;
  if (isCompany(domain)) return false;
  if (JOB_APPLICATION.test(`${m.subject || ""} ${m.snippet || ""}`)) return false;
  return true;
}

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
  const { data } = await admin.from("clients").select("id, name, email, report_email, website, key_contacts, stage");
  const byEmail = new Map<string, any>(), byDomain = new Map<string, any>();
  const names: [string, any][] = [], webDomains = new Map<string, any>(), compacts: [string, any][] = [];
  for (const c of data || []) {
    if (["churned", "archived"].includes(String(c.stage || ""))) continue;
    // Their name as people write it: "A and B Concrete Ltd - Blade" -> "a and b concrete".
    const name = String(c.name || "").replace(/\s+[-–|(].*$/, "").replace(/[,.]?\s+(pty\.?\s+)?(ltd|limited|nz ltd)\.?$/i, "")
      .toLowerCase().replace(/[^a-z0-9.@&']+/g, " ").trim();
    const variants = new Set<string>();
    if (name.length >= 5) { variants.add(name); variants.add(name.replace(/s$/, "")); variants.add(name + "s"); }
    const core = name.split(" ").filter((w) => !TRADE_WORDS.has(w)).join(" ");
    if (core.length >= 5) variants.add(core);
    for (const v of variants) if (v.length >= 5) names.push([v, c]);
    for (const v of [name, core]) { const k = v.replace(/[^a-z0-9]/g, ""); if (k.length >= 6) compacts.push([k, c]); }
    const site = String(c.website || "").toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/)[0];
    if (site.includes(".") && site.length >= 6) webDomains.set(site, c);
    // Every address on their record, wherever it's written ("Sam <sam@x.nz>", key contacts...).
    for (const raw of [c.email, c.report_email, c.key_contacts]) {
      for (const e of String(raw || "").toLowerCase().match(/[a-z0-9._%+'-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []) {
        const d = domainOf(e);
        if (OWN_DOMAINS.has(d)) continue;
        byEmail.set(e, c);
        if (!PERSONAL_DOMAINS.has(d)) byDomain.set(d, c);
      }
    }
  }
  const domainList = [...new Map([...webDomains, ...byDomain]).entries()];
  // Longest first, so "reeve builders" wins over a shorter name inside it.
  names.sort((a, b) => b[0].length - a[0].length);
  return { byEmail, byDomain, names, domainList, compacts };
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
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 1000) : [];
  if (messages.length) {
    const ids = messages.map((m: any) => clip(m.gmail_id, 100)).filter(Boolean);
    const { data: have } = await admin.from("client_emails").select("gmail_id").eq("user_id", userId).in("gmail_id", ids);
    const known = new Set((have || []).map((h: any) => h.gmail_id));
    for (const m of messages) {
      const gmailId = clip(m.gmail_id, 100);
      if (!gmailId || known.has(gmailId)) continue;
      const from = parseFrom(clip(m.from, 300));
      const client = match.byEmail.get(from.email) || match.byDomain.get(domainOf(from.email)) || ownDomainClient(from.email, match) || aboutAClient(from, m, match);
      if (!client) continue;
      const received = new Date(m.received_at);
      const { error } = await admin.from("client_emails").insert({
        user_id: userId, inbox_email: inbox, gmail_id: gmailId, thread_id: clip(m.thread_id, 100) || null,
        message_id: clip(m.message_id, 300) || null, client_id: client.id, client_name: client.name,
        from_email: from.email, from_name: from.name, subject: clip(m.subject, 300), snippet: clip(m.snippet, 400),
        received_at: isNaN(received.getTime()) ? new Date().toISOString() : received.toISOString(),
        // Older emails from the catch-up don't each set off a 2-hour reminder.
        reminded_at: !isNaN(received.getTime()) && Date.now() - received.getTime() > REMIND_AFTER_MS ? new Date().toISOString() : null,
      });
      if (!error) added++; // a duplicate (cc'd to both of us) is skipped by the unique Message-ID
    }
  }
  // Emails saved without a client (by an earlier, wider filter) get another
  // look each time, now that matching knows more.
  const { data: loose } = await admin.from("client_emails").select("id, from_email, from_name, subject, snippet")
    .eq("user_id", userId).is("client_id", null).gte("received_at", new Date(Date.now() - 60 * 86400e3).toISOString()).limit(500);
  for (const e of loose || []) {
    const em = cleanEmail(e.from_email);
    const c = match.byEmail.get(em) || match.byDomain.get(domainOf(em)) || ownDomainClient(em, match) || mentions(textOf([e.from_name, em, e.subject, e.snippet].join(" ")), match);
    if (c) await admin.from("client_emails").update({ client_id: c.id, client_name: c.name }).eq("id", e.id);
  }
  // Threads someone has replied in since the client's email came in.
  for (const r of Array.isArray(body.replies) ? body.replies.slice(0, 300) : []) {
    const at = new Date(r.replied_at);
    if (!r.thread_id || isNaN(at.getTime())) continue;
    const { data } = await admin.from("client_emails").update({ status: "replied", replied_at: at.toISOString() })
      .eq("user_id", userId).eq("thread_id", clip(r.thread_id, 100)).eq("status", "new").lt("received_at", at.toISOString()).select("id");
    replied += (data || []).length;
  }
  // How this inbox's script is doing, for the workflow's check_inbox run (counts only).
  const statsName = `inbox_stats:${userId}`;
  const { data: prev } = await admin.from("app_secrets").select("value").eq("name", statsName).maybeSingle();
  let st: any = {};
  try { st = JSON.parse(prev?.value || "{}"); } catch { st = {}; }
  const page = "backfill_done" in body;
  const today = new Date().toISOString().slice(0, 10);
  if (st.day !== today) Object.assign(st, { day: today, pushes: 0, emails_seen: 0, saved: 0 });
  Object.assign(st, { at: new Date().toISOString(), pushes: (st.pushes || 0) + 1, emails_seen: (st.emails_seen || 0) + messages.length, saved: (st.saved || 0) + added,
    catch_up_pages: (st.catch_up_pages || 0) + (page ? 1 : 0), last_catch_up_page_at: page ? new Date().toISOString() : st.last_catch_up_page_at || null });
  await admin.from("app_secrets").upsert({ name: statsName, value: JSON.stringify(st) });
  if (body.backfill_done) await admin.from("app_secrets").upsert({ name: backfillName(userId), value: `${BACKFILL_VERSION}:${new Date().toISOString()}` });
  await admin.from("inbox_connections").upsert({ user_id: userId, email: inbox || undefined, status: "ok", error: null, last_sync_at: new Date().toISOString() });
  return { added, replied };
}

// One nudge per email that's waited 2 hours, sent to whichever inbox it came
// into. Held back between 8pm and 7am NZ time.
async function remind(admin: any) {
  if (!RESEND_API_KEY || !EMAIL_FROM) return 0;
  const hour = Number(new Intl.DateTimeFormat("en-NZ", { timeZone: "Pacific/Auckland", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  if (hour < 7 || hour >= 20) return 0;
  const { data } = await admin.from("client_emails").select("*").eq("status", "new").is("reminded_at", null).not("client_id", "is", null)
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
      const { data: done } = await admin.from("app_secrets").select("value").eq("name", backfillName(userId)).maybeSingle();
      const caughtUp = String(done?.value || "").startsWith(`${BACKFILL_VERSION}:`);
      return json({
        query: INBOX_QUERY, max: 100, days: 2, sender_scope: "newer_than:2d",
        backfill: !caughtUp, backfill_query: BACKFILL_QUERY, backfill_days: BACKFILL_DAYS,
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
  // Lead Follow Up only logins (allowlist.access = "leads") can't use this.
  const { data: allowed } = await admin.from("allowlist").select("email, access").ilike("email", user.email).maybeSingle();
  if (!allowed || allowed.access === "leads") return json({ error: "Unauthorized." }, 401);

  if (body.action === "make_key") {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const key = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    await admin.from("app_secrets").upsert({ name: keyName(user.id), value: await sha256(key) });
    await admin.from("app_secrets").delete().eq("name", backfillName(user.id)); // a fresh script catches up on the inbox again
    const { data: conn } = await admin.from("inbox_connections").select("user_id").eq("user_id", user.id).maybeSingle();
    // The Gmail address fills in from the script's first check - it's often not the CRM login.
    if (!conn) await admin.from("inbox_connections").insert({ user_id: user.id, email: null, status: "waiting" });
    else await admin.from("inbox_connections").update({ status: "waiting", error: null }).eq("user_id", user.id);
    return json({ key });
  }
  return json({ error: "Unknown action." }, 400);
});
