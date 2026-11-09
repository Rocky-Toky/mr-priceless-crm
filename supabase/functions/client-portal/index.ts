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
// Client logins live in client_portal_users, never in the allowlist, so every
// other function (and every table, sql/112) refuses them.
//
// Secrets: RESEND_API_KEY / EMAIL_FROM / EMAIL_REPLY_TO (same as the email sender).

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const PORTAL_URL = "https://rocky-toky.github.io/mr-priceless-crm/portal/";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "";
const EMAIL_REPLY_TO = Deno.env.get("EMAIL_REPLY_TO") || "";

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
    `We've set up your Mr Priceless client portal for ${business}. It's where you'll see every lead the moment it comes in, with what they put on the form, so you can call the best ones first - straight from your phone.`,
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
    <p>We've set up your <b>Mr Priceless client portal</b> for ${escapeHtml(business)}. It's where you'll see every lead the moment it comes in, with what they put on the form, so you can call the best ones first - straight from your phone.</p>
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: "Server misconfigured." }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  // Team only (not Lead Follow Up only logins, never client logins).
  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const caller = userData?.user;
  if (!caller?.email || !caller.email_confirmed_at) return json({ error: "Unauthorized." }, 401);
  const { data: allowed } = await admin.from("allowlist").select("email, access").ilike("email", caller.email).maybeSingle();
  if (!allowed || (allowed.access || "full") !== "full") return json({ error: "Unauthorized." }, 401);

  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }

  try {
    if (body.action === "invite") {
      const email = cleanEmail(body.email), name = String(body.name || "").trim().slice(0, 120);
      if (!isEmail(email)) return json({ error: "That isn't an email address." }, 400);
      const { data: client } = await admin.from("clients").select("id, name").eq("id", body.client_id).maybeSingle();
      if (!client) return json({ error: "Couldn't find that client." }, 400);
      // A team login can't also be a client login.
      const { data: team } = await admin.from("allowlist").select("email").ilike("email", email).maybeSingle();
      if (team) return json({ error: "That email is a Mr Priceless team login, so it can't be a client login. Use the client's own email." }, 400);

      const { data: existing } = await admin.from("client_portal_users").select("id").eq("email", email).eq("client_id", client.id).maybeSingle();
      if (!existing) {
        const { error } = await admin.from("client_portal_users").insert({ email, client_id: client.id, name: name || null, created_by: caller.email });
        if (error) return json({ error: error.message }, 500);
      } else if (name) {
        await admin.from("client_portal_users").update({ name }).eq("id", existing.id);
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
      }
      return json({ ok: true });
    }
  } catch (e) {
    return json({ error: String((e as any)?.message || e) }, 500);
  }
  return json({ error: "Unknown action." }, 400);
});
