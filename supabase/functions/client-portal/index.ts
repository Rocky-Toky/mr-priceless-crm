// Edge Function: client-portal
// Gives a client a login to their portal (portal/ on the live site) and takes
// it away again. Only the team (allowlist access "full") can use it; client
// logins themselves never reach anything here.
//
//   { action: "invite", client_id, email, name? }
//       Adds them to client_portal_users, makes their account (already
//       confirmed, with a throwaway password nobody sees) and emails them a
//       link to choose their password. If the email can't be sent, the link
//       comes back as { link } so the team can text it to them.
//   { action: "remove", id }
//       Takes that login off, and deletes the account if it was their only one.
//
// From a client login (calendar.ts, sql/117):
//   { action: "calendar_status" }               -> which buttons to offer, what's connected
//   { action: "calendar_connect", provider }    -> { url } to send them to Google / Microsoft
//   { action: "calendar_disconnect" }
//   { action: "calendar_day", from, to }        -> { events } in their calendar (up to 8 days)
//   { action: "calendar_add", lead_id }         -> puts the lead's site visit / call in their calendar
// GET /client-portal/oauth/{google|microsoft}: where the sign-in comes back to.
//
// From pg_cron / the database (header x-cron-secret = app_secrets
// portal_cron_secret, sql/113), { action: "deliver" }: sends the waiting
// portal_notifications. Each goes as a phone notification to every device
// that login turned alerts on for; if none got it and the kind allows
// (fallback), a text (Twilio, if set up, to the login's mobile), else an
// email. Makes the VAPID keys for phone alerts the first time (app_secrets
// push_vapid; the public half is handed to the portal by portal_me).
//
// Client logins live in client_portal_users, never in the allowlist, so every
// other function (and every table, sql/112) refuses them.
//
// Secrets: RESEND_API_KEY / EMAIL_FROM / EMAIL_REPLY_TO (same as the email
// sender); optional TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM for texts.

import { createClient } from "npm:@supabase/supabase-js@2";
import { makeVapidKeys, sendPush, type VapidKeys } from "./push.ts";
import { accessToken, authUrl, creds, dayEvents, exchangeCode, putEvent, type Conn, type Provider } from "./calendar.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const PORTAL_URL = "https://rocky-toky.github.io/mr-priceless-crm/portal/";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "";
const EMAIL_REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") || "";
const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
const TWILIO_FROM = Deno.env.get("TWILIO_FROM") || "";

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const cleanEmail = (s: unknown) => String(s || "").trim().toLowerCase();
const isEmail = (s: string) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(s);

async function findUser(admin: any, email: string) {
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw error;
    const hit = (data?.users || []).find((u: any) => (u.email || "").toLowerCase() === email);
    if (hit) return hit;
    if ((data?.users || []).length < 1000) return null;
  }
  return null;
}

async function sendWelcome(to: string, name: string, business: string, link: string) {
  if (!RESEND_API_KEY || !EMAIL_FROM) return "Email sending isn't set up";
  const first = (name || "").trim().split(/\s+/)[0] || "there";
  const text = [
    `Hi ${first},`,
    "",
    `We've set up your Mr Priceless client portal for ${business}. It's where you'll see your most qualified leads the moment they come in, with what they put on the form, so you can call the best ones first - straight from your phone.`,
    "",
    "Choose your password here (the link works once, for an hour):",
    link,
    "",
    `After that, sign in any time at ${PORTAL_URL}`,
    "Tip: on your phone, open it and tap Share > Add to Home Screen so it sits with your apps.",
    "",
    "Cheers,",
    "Mr Priceless",
  ].join("\n");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#15130f;max-width:520px">
    <p>Hi ${escapeHtml(first)},</p>
    <p>We've set up your <b>Mr Priceless client portal</b> for ${escapeHtml(business)}. It's where you'll see your most qualified leads the moment they come in, with what they put on the form, so you can call the best ones first - straight from your phone.</p>
    <p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:#d4a017;color:#111;padding:14px 22px;border-radius:10px;font-weight:bold;text-decoration:none;display:inline-block">Choose your password</a></p>
    <p style="font-size:13px;color:#555">The button works once, for an hour. After that, sign in any time at <a href="${PORTAL_URL}">${PORTAL_URL}</a>.<br>Tip: on your phone, open it and tap Share &gt; Add to Home Screen so it sits with your apps.</p>
    <p>Cheers,<br>Mr Priceless</p></div>`;
  const payload: any = { from: EMAIL_FROM, to: [to], subject: `Your Mr Priceless client portal`, text, html };
  if (EMAIL_REPLY_TO) payload.reply_to = EMAIL_REPLY_TO;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) return null;
  const out = await res.json().catch(() => ({}));
  return String(out?.message || out?.error || `Resend returned ${res.status}`);
}

/* ───────── Alerts (sql/113 portal_notifications) ───────── */
async function vapidKeys(admin: any): Promise<VapidKeys> {
  const read = async () => {
    const { data } = await admin.from("app_secrets").select("value").eq("name", "push_vapid").maybeSingle();
    return data?.value ? JSON.parse(data.value) as VapidKeys : null;
  };
  const have = await read();
  if (have) return have;
  const keys = await makeVapidKeys();
  // Two runs at once: whichever saved first wins, and both use that.
  await admin.from("app_secrets").upsert({ name: "push_vapid", value: JSON.stringify(keys) }, { onConflict: "name", ignoreDuplicates: true });
  return (await read()) || keys;
}
const vapidSubject = () => {
  const m = (EMAIL_REPLY_TO || EMAIL_FROM).match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return m ? `mailto:${m[0]}` : PORTAL_URL;
};
// 021 123 4567 -> +64211234567; AU mobiles (04...) -> +61.
function e164(phone: string): string | null {
  let d = String(phone || "").replace(/[^\d+]/g, "");
  if (!d) return null;
  if (d.startsWith("+")) return d.length >= 9 ? d : null;
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (d.startsWith("64") || d.startsWith("61")) return "+" + d;
  if (d.startsWith("04")) return "+61" + d.slice(1);
  if (d.startsWith("0")) return "+64" + d.slice(1);
  return null;
}
async function sendText(to: string, body: string): Promise<string | null> {
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return "Texts aren't set up";
  const form = new URLSearchParams({ To: to, Body: body.slice(0, 600) });
  form.set(TWILIO_FROM.startsWith("MG") ? "MessagingServiceSid" : "From", TWILIO_FROM);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  if (res.ok) { await res.body?.cancel(); return null; }
  const out = await res.json().catch(() => ({}));
  return String(out?.message || `Twilio returned ${res.status}`);
}
const STALE_MS: Record<string, number> = { new_lead: 6 * 3600e3, call_due: 3600e3, visit_today: 12 * 3600e3 };

async function deliver(admin: any) {
  const keys = await vapidKeys(admin);
  const { data: waiting } = await admin.from("portal_notifications").select("id").eq("status", "pending").order("created_at").limit(200);
  const ids = (waiting || []).map((r: any) => r.id);
  if (!ids.length) return { sent: 0 };
  // Claim them, so two runs at once can't send the same alert twice.
  const { data: rows } = await admin.from("portal_notifications").update({ status: "sending" }).in("id", ids).eq("status", "pending").select("*");
  const tally: Record<string, number> = {};
  const count = (k: string) => { tally[k] = (tally[k] || 0) + 1; };
  let emailed = false;
  for (const n of rows || []) {
    const finish = async (status: string, channel: string | null, error: string | null = null) => {
      await admin.from("portal_notifications").update({ status, channel, error, sent_at: new Date().toISOString() }).eq("id", n.id);
      count(status);
    };
    try {
      if (Date.now() - new Date(n.created_at).getTime() > (STALE_MS[n.kind] ?? 48 * 3600e3)) { await finish("expired", null); continue; }
      const { data: subs } = await admin.from("portal_push_subs").select("id, endpoint, p256dh, auth, failures").ilike("email", n.email);
      let ok = 0;
      const message = {
        title: n.title, body: n.body, url: n.url || PORTAL_URL, tag: `${n.kind}:${n.lead_id || n.id}`, kind: n.kind,
        lead: n.lead_id, token: n.kind === "checkin" ? n.payload?.token || null : null,
      };
      for (const sub of subs || []) {
        try {
          const r = await sendPush(sub, message, keys, vapidSubject(), n.kind === "checkin" ? 12 * 3600 : 6 * 3600);
          if (r.ok) { ok++; await admin.from("portal_push_subs").update({ last_ok_at: new Date().toISOString(), failures: 0 }).eq("id", sub.id); }
          else if (r.gone || (sub.failures || 0) >= 9) await admin.from("portal_push_subs").delete().eq("id", sub.id);
          else await admin.from("portal_push_subs").update({ failures: (sub.failures || 0) + 1 }).eq("id", sub.id);
        } catch (_e) { /* one bad device doesn't stop the rest */ }
      }
      if (ok) { await finish("sent", "push"); continue; }
      const fb = String(n.fallback || "");
      if (fb.includes("sms") && TWILIO_SID) {
        const { data: users } = await admin.from("client_portal_users").select("phone").ilike("email", n.email).not("phone", "is", null).limit(1);
        const to = e164(users?.[0]?.phone || "");
        if (to) {
          const err = await sendText(to, n.payload?.sms || `${n.title} - ${n.body} ${n.url || ""}`);
          if (!err) { await finish("texted", "sms"); continue; }
          if (!fb.includes("email")) { await finish("failed", "sms", err); continue; }
        }
      }
      if (fb.includes("email")) {
        await admin.from("scheduled_emails").insert({
          kind: "portal_alert", record_id: n.id, to_email: n.email,
          subject: n.payload?.email_subject || n.title,
          body: n.payload?.email_body || `${n.body}\n\n${n.url || PORTAL_URL}\n\nMr Priceless`,
          send_at: new Date().toISOString(), created_by: "portal",
        });
        emailed = true;
        await finish("emailed", "email");
        continue;
      }
      await finish("no_device", null);
    } catch (e) {
      await finish("failed", null, String((e as any)?.message || e).slice(0, 300));
    }
  }
  // Send the fallback emails now instead of on the next 5-minute run.
  if (emailed) {
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "email_cron_secret").maybeSingle();
    const url = Deno.env.get("SUPABASE_URL"), anon = Deno.env.get("SUPABASE_ANON_KEY");
    if (secret?.value && url) {
      await fetch(`${url}/functions/v1/send-scheduled-emails`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${anon}`, "x-cron-secret": secret.value },
        body: "{}",
      }).then((r) => r.body?.cancel()).catch(() => {});
    }
  }
  return tally;
}

/* ───────── Client calendars (calendar.ts, sql/117) ───────── */
const PROVIDER_NAME: Record<Provider, string> = { google: "Google Calendar", microsoft: "Outlook" };
async function connFor(admin: any, email: string): Promise<Conn | null> {
  const { data } = await admin.from("portal_calendars").select("*").eq("email", email).maybeSingle();
  return data || null;
}
const saver = (admin: any, email: string) => (patch: Record<string, unknown>) => admin.from("portal_calendars").update(patch).eq("email", email);

// The sign-in came back from Google / Microsoft.
async function oauthReturn(admin: any, url: URL): Promise<Response> {
  const back = (q: string) => new Response(null, { status: 302, headers: { Location: `${PORTAL_URL}?${q}` } });
  const provider = (url.pathname.endsWith("/google") ? "google" : url.pathname.endsWith("/microsoft") ? "microsoft" : "") as Provider | "";
  const state = url.searchParams.get("state") || "", code = url.searchParams.get("code") || "";
  if (!provider || !state) return back("calendar=error");
  const { data: st } = await admin.from("portal_calendar_states").select("*").eq("state", state).maybeSingle();
  await admin.from("portal_calendar_states").delete().eq("state", state);
  if (!st || st.provider !== provider || Date.now() - new Date(st.created_at).getTime() > 15 * 60e3) return back("calendar=expired");
  if (!code) return back("calendar=cancelled");
  try {
    const t = await exchangeCode(provider, code);
    const old = await connFor(admin, st.email);
    await admin.from("portal_calendars").upsert({
      email: st.email, provider, account_email: t.account_email || null,
      // Google only sends a refresh token the first time; keep the old one if it's the same account.
      refresh_token: t.refresh_token || (old?.provider === provider ? old.refresh_token : null),
      access_token: t.access_token, expires_at: t.expires_at, error: null,
      connected_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }, { onConflict: "email" });
    return back(`calendar=connected&provider=${provider}`);
  } catch (e) {
    console.warn("calendar connect failed", String((e as any)?.message || e).slice(0, 200));
    return back("calendar=error");
  }
}

async function calendarAction(admin: any, email: string, body: any) {
  const conn = await connFor(admin, email);
  if (body.action === "calendar_status") {
    return {
      offer: { google: !!creds("google"), microsoft: !!creds("microsoft") },
      connected: conn ? { provider: conn.provider, name: PROVIDER_NAME[conn.provider], account: conn.account_email || null, error: (conn as any).error || null } : null,
    };
  }
  if (body.action === "calendar_connect") {
    const provider = body.provider as Provider;
    const c = provider === "google" || provider === "microsoft" ? creds(provider) : null;
    if (!c) return { error: "That calendar can't be connected yet." };
    const state = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
    await admin.from("portal_calendar_states").insert({ state, email, provider });
    return { url: authUrl(provider, c.id, state, email) };
  }
  if (body.action === "calendar_disconnect") {
    await admin.from("portal_calendars").delete().eq("email", email);
    return { ok: true };
  }
  if (!conn) return { connected: false };
  const token = await accessToken(conn, saver(admin, email));
  if (body.action === "calendar_day") {
    const from = new Date(body.from), to = new Date(body.to);
    if (isNaN(+from) || isNaN(+to) || +to <= +from || +to - +from > 8 * 86400e3) return { error: "Pick a day or a week." };
    return { events: await dayEvents(conn, token, from.toISOString(), to.toISOString()) };
  }
  if (body.action === "calendar_add") {
    // Only a lead of one of their own clients.
    const { data: l } = await admin.from("client_leads").select("id, client_id, name, phone, email, address, city, form_name, answers, client_stage, client_next_at, booked_for, calendar_event").eq("id", body.lead_id).maybeSingle();
    if (!l) return { error: "Couldn't find that lead." };
    const { data: mine } = await admin.from("client_portal_users").select("id").eq("email", email).eq("client_id", l.client_id).maybeSingle();
    if (!mine) return { error: "Not allowed." };
    const visit = l.client_stage === "site_visit", at = l.client_next_at || (visit ? l.booked_for : null);
    if (!at || !["site_visit", "call_scheduled"].includes(l.client_stage)) return { skipped: true };
    const start = new Date(at), end = new Date(+start + (visit ? 60 : 15) * 60e3);
    const qa = (Array.isArray(l.answers) ? l.answers : []).map((x: any) => `${String(x.q || "").replace(/_/g, " ")}: ${String(x.a || "").replace(/_/g, " ")}`).filter((x: string) => x.length > 2);
    const details = [l.phone ? `Phone: ${l.phone}` : "", l.email ? `Email: ${l.email}` : "", l.form_name ? `Enquiry: ${l.form_name}` : "", ...qa, "", `Open the lead: ${PORTAL_URL}?lead=${l.id}`].filter((x, i, a) => x || (i > 0 && a[i - 1])).join("\n");
    const id = await putEvent(conn, token, {
      id: l.calendar_event?.provider === conn.provider ? l.calendar_event?.id : null,
      title: `${visit ? "Site visit" : "Call"} - ${l.name || "lead"}`,
      start: start.toISOString(), end: end.toISOString(), location: l.address || l.city || "", details,
    });
    await admin.from("client_leads").update({ calendar_event: { provider: conn.provider, id, at: start.toISOString() } }).eq("id", l.id);
    return { ok: true, name: PROVIDER_NAME[conn.provider] };
  }
  return { error: "Unknown action." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: "Server misconfigured." }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // Coming back from "Connect Google Calendar / Outlook".
  const url = new URL(req.url);
  if (req.method === "GET" && /\/oauth\/(google|microsoft)$/.test(url.pathname)) return oauthReturn(admin, url);

  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) {
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "portal_cron_secret").maybeSingle();
    if (!secret?.value || secret.value !== cronHeader) return json({ error: "Unauthorized." }, 401);
    try { return json(await deliver(admin)); } catch (e) { return json({ error: String((e as any)?.message || e) }, 500); }
  }

  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const caller = userData?.user;
  if (!caller?.email || !caller.email_confirmed_at) return json({ error: "Unauthorized." }, 401);
  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }

  // Calendar actions: client portal logins only, each for their own calendar.
  if (String(body.action || "").startsWith("calendar_")) {
    const me = cleanEmail(caller.email);
    const { data: login } = await admin.from("client_portal_users").select("id").eq("email", me).limit(1).maybeSingle();
    const { data: team } = await admin.from("allowlist").select("email").ilike("email", me).maybeSingle();
    if (!login || team) return json({ error: "Unauthorized." }, 401);
    try { return json(await calendarAction(admin, me, body)); }
    catch (e) { return json({ error: String((e as any)?.message || e).slice(0, 200) }); }
  }

  // Everything else: team only (not Lead Follow Up only logins, never client logins).
  const { data: allowed } = await admin.from("allowlist").select("email, access").ilike("email", caller.email).maybeSingle();
  if (!allowed || (allowed.access || "full") !== "full") return json({ error: "Unauthorized." }, 401);

  try {
    if (body.action === "invite") {
      const email = cleanEmail(body.email), name = String(body.name || "").trim().slice(0, 120);
      const phone = String(body.phone || "").replace(/[^\d+]/g, "").slice(0, 20) || null;
      if (!isEmail(email)) return json({ error: "That isn't an email address." }, 400);
      const { data: client } = await admin.from("clients").select("id, name").eq("id", body.client_id).maybeSingle();
      if (!client) return json({ error: "Couldn't find that client." }, 400);
      // A team login can't also be a client login.
      const { data: team } = await admin.from("allowlist").select("email").ilike("email", email).maybeSingle();
      if (team) return json({ error: "That email is a Mr Priceless team login, so it can't be a client login. Use the client's own email." }, 400);

      const { data: existing } = await admin.from("client_portal_users").select("id").eq("email", email).eq("client_id", client.id).maybeSingle();
      if (!existing) {
        const { error } = await admin.from("client_portal_users").insert({ email, client_id: client.id, name: name || null, phone, created_by: caller.email });
        if (error) return json({ error: error.message }, 500);
      } else if (name || phone) {
        await admin.from("client_portal_users").update({ ...(name ? { name } : {}), ...(phone ? { phone } : {}) }).eq("id", existing.id);
      }

      let user = await findUser(admin, email);
      if (!user) {
        const pw = crypto.randomUUID() + crypto.randomUUID();
        const { data, error } = await admin.auth.admin.createUser({ email, password: pw, email_confirm: true });
        if (error) return json({ error: `Couldn't make their account: ${error.message}` }, 500);
        user = data.user;
      } else if (!user.email_confirmed_at) {
        await admin.auth.admin.updateUserById(user.id, { email_confirm: true });
      }

      const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({ type: "recovery", email, options: { redirectTo: PORTAL_URL } });
      const link = linkData?.properties?.action_link;
      if (linkErr || !link) return json({ error: `Their login is made, but the set-password link failed: ${linkErr?.message || "no link"}` }, 500);
      const emailErr = await sendWelcome(email, name, client.name, link);
      // The link only goes back to the team if the email didn't go - so they can text it.
      return json(emailErr ? { ok: true, emailed: false, why: emailErr, link } : { ok: true, emailed: true });
    }

    if (body.action === "remove") {
      const { data: row } = await admin.from("client_portal_users").select("id, email").eq("id", body.id).maybeSingle();
      if (!row) return json({ ok: true });
      await admin.from("client_portal_users").delete().eq("id", row.id);
      const email = cleanEmail(row.email);
      const { count } = await admin.from("client_portal_users").select("id", { count: "exact", head: true }).eq("email", email);
      const { data: team } = await admin.from("allowlist").select("email").ilike("email", email).maybeSingle();
      if (!count && !team) {
        const user = await findUser(admin, email);
        if (user) await admin.auth.admin.deleteUser(user.id);
        await admin.from("portal_push_subs").delete().eq("email", email);
      }
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
  return json({ error: "Unknown action." }, 400);
});
