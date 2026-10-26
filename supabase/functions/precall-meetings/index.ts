// Edge Function: precall-meetings
// Sales meetings booked from the CRM go on the closer's Google Calendar: a
// 15-minute invite with a Google Meet link (the prospect gets the invite),
// plus a private 30-minute "Buffer" block straight after, so the closer shows
// busy for 45 minutes. The CRM acts as the closer through a Google Workspace
// service account with domain-wide delegation (GOOGLE_SERVICE_ACCOUNT_B64,
// set by the deploy workflow from the GOOGLE_SERVICE_ACCOUNT_JSON repo secret),
// so nobody has to connect their own calendar.
//
//   Signed-in allowlisted user:
//     { action: "book", ... }            saves the meeting, then makes the events
//     { action: "retry_calendar", meeting_id }  tries the calendar again after a failure
//   Deploy workflow (header x-cron-secret = app_secrets.precall_cron_secret):
//     { action: "check_calendar", email }  can the CRM reach that person's calendar?
//
// Test mode (precall_settings.test_mode, on until someone turns it off):
// the prospect is only added to the invite if their email is one of ours
// (@mrpriceless.com) or on the test list. Logs carry no client details.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const TZ = "Pacific/Auckland";
const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const DOMAIN = (Deno.env.get("PRECALL_GOOGLE_DOMAIN") || "mrpriceless.com").toLowerCase();

/* ───────── Google auth (service account, acting as one person) ───────── */
class GoogleError extends Error { constructor(msg: string, public status = 0) { super(msg); } }
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const enc = new TextEncoder();
const tokenCache = new Map<string, { token: string; until: number }>();

async function googleToken(subject: string) {
  const hit = tokenCache.get(subject);
  if (hit && hit.until > Date.now()) return hit.token;
  // The deploy workflow passes the key file on base64-encoded.
  const b64 = Deno.env.get("GOOGLE_SERVICE_ACCOUNT_B64");
  if (!b64) throw new GoogleError("Google isn't set up yet: the GOOGLE_SERVICE_ACCOUNT_JSON secret is missing.");
  let sa: any;
  try { sa = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))); } catch { throw new GoogleError("The GOOGLE_SERVICE_ACCOUNT_JSON secret isn't a valid key file - paste the whole .json file in again."); }
  const now = Math.floor(Date.now() / 1000);
  const unsigned = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))) + "." +
    b64url(enc.encode(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", sub: subject, iat: now, exp: now + 3600 })));
  const der = Uint8Array.from(atob(String(sa.private_key || "").replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(unsigned)));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: unsigned + "." + b64url(sig) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // unauthorized_client: the delegation isn't on (yet - it can take up to a day).
    if (body.error === "unauthorized_client") throw new GoogleError("Google hasn't switched on calendar access for the CRM yet. It can take up to 24 hours after setting it up - try again later.", res.status);
    if (body.error === "invalid_grant") throw new GoogleError(`Google doesn't recognise ${subject} as a calendar in your Workspace.`, res.status);
    throw new GoogleError(`Google sign-in failed (${body.error || res.status}).`, res.status);
  }
  tokenCache.set(subject, { token: body.access_token, until: Date.now() + (Number(body.expires_in) || 3600) * 1000 - 120e3 });
  return body.access_token as string;
}

async function cal(subject: string, path: string, init: RequestInit = {}) {
  const res = await fetch(CAL + path, {
    ...init,
    headers: { Authorization: `Bearer ${await googleToken(subject)}`, Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(body?.error?.message || `Google Calendar returned ${res.status}`, res.status);
  return body;
}

/* ───────── Times (stored in UTC, worked out in NZ time) ───────── */
const nzDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const dayNum = (s: string) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400e3;
function bookingWindow(bookedAt: Date, startsAt: Date) {
  const days = dayNum(nzDay(startsAt)) - dayNum(nzDay(bookedAt));
  return days <= 0 ? "same_day" : days === 1 ? "next_day" : days <= 3 ? "2_3_days" : "4_days";
}

/* ───────── Calendar events for a meeting ───────── */
// Our own event IDs (the meeting's id, hex only), so a retry finds the event
// it already made instead of making a second one.
const eventId = (m: any) => String(m.id).replace(/-/g, "");
const bufferId = (m: any) => eventId(m) + "b";
const fullName = (m: any) => [m.first_name, m.last_name].filter(Boolean).join(" ");

async function testAllows(admin: SupabaseClient, email: string) {
  const { data } = await admin.from("precall_settings").select("test_mode, test_allowlist").eq("id", 1).maybeSingle();
  const testMode = data ? data.test_mode !== false : true;
  if (!testMode) return { testMode, ok: true };
  const e = email.toLowerCase();
  const list = String(data?.test_allowlist || "").toLowerCase().split(/[,\s]+/).filter(Boolean);
  return { testMode, ok: e.endsWith("@" + DOMAIN) || list.includes(e) };
}

async function createOrFind(subject: string, id: string, query: string, event: any) {
  try {
    return await cal(subject, query, { method: "POST", body: JSON.stringify({ id, ...event }) });
  } catch (e) {
    if ((e as GoogleError).status === 409) return await cal(subject, "/" + id + "?conferenceDataVersion=1");
    throw e;
  }
}

async function makeEvents(admin: SupabaseClient, m: any, by: string) {
  const start = new Date(m.starts_at);
  const end = new Date(start.getTime() + m.duration_min * 60e3);
  const bufferEnd = new Date(end.getTime() + m.buffer_min * 60e3);
  const t = m.email ? await testAllows(admin, m.email) : { testMode: false, ok: false };
  const invite = !!m.email && t.ok;
  const attendees = [{ email: m.closer_email, responseStatus: "accepted" }];
  if (invite) attendees.push({ email: m.email } as any);
  const who = m.business_name ? `${fullName(m)} (${m.business_name})` : fullName(m);
  try {
    let ev = await createOrFind(m.closer_email, eventId(m), "?conferenceDataVersion=1&sendUpdates=all", {
      summary: `Mr Priceless x ${m.business_name || fullName(m)}`,
      description: m.description || "",
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end: { dateTime: end.toISOString(), timeZone: TZ },
      attendees,
      conferenceData: { createRequest: { requestId: eventId(m), conferenceSolutionKey: { type: "hangoutsMeet" } } },
    });
    // The Meet link is usually there straight away; if Google's still making it, wait a moment.
    for (let i = 0; i < 3 && !ev.hangoutLink; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      ev = await cal(m.closer_email, "/" + ev.id + "?conferenceDataVersion=1");
    }
    const buf = await createOrFind(m.closer_email, bufferId(m), "?sendUpdates=none", {
      summary: `Buffer – ${who}`,
      visibility: "private",
      transparency: "opaque",
      start: { dateTime: end.toISOString(), timeZone: TZ },
      end: { dateTime: bufferEnd.toISOString(), timeZone: TZ },
      reminders: { useDefault: false, overrides: [] },
    });
    const patch = {
      google_event_id: ev.id, buffer_event_id: buf.id, meet_link: ev.hangoutLink || null,
      calendar_status: "ok", calendar_error: null, calendar_synced_at: new Date().toISOString(),
      invite_to_prospect: invite, test_mode: t.testMode, updated_at: new Date().toISOString(),
    };
    const { data } = await admin.from("meetings").update(patch).eq("id", m.id).select().single();
    await admin.from("meeting_events").insert({
      meeting_id: m.id, kind: "calendar_created", by,
      detail: { invite_to_prospect: invite, test_mode: t.testMode, skipped_reason: m.email && !invite ? "test_mode" : m.email ? null : "no_email" },
    });
    return data;
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 500);
    const { data } = await admin.from("meetings").update({ calendar_status: "error", calendar_error: msg, updated_at: new Date().toISOString() }).eq("id", m.id).select().single();
    await admin.from("meeting_events").insert({ meeting_id: m.id, kind: "calendar_error", by, detail: { error: msg } });
    console.log(`calendar error for meeting ${m.id}: ${msg}`);
    return data;
  }
}

/* ───────── Booking ───────── */
const clean = (v: unknown, max = 200) => (v == null ? "" : String(v).trim().slice(0, max));
async function allowlisted(admin: SupabaseClient, email: string) {
  if (!email) return false;
  const { data } = await admin.from("allowlist").select("email").ilike("email", email).maybeSingle();
  return !!data;
}

async function book(admin: SupabaseClient, b: any, caller: string) {
  const startsAt = new Date(b.starts_at);
  if (isNaN(startsAt.getTime())) return { error: "Pick a meeting date and time." };
  if (startsAt.getTime() < Date.now() - 10 * 60e3) return { error: "That meeting time has already passed." };
  const first = clean(b.first_name, 80);
  if (!first) return { error: "The prospect's first name is needed." };
  const closerEmail = clean(b.closer_email, 200).toLowerCase();
  if (!closerEmail.endsWith("@" + DOMAIN) || !(await allowlisted(admin, closerEmail))) {
    return { error: `The closer needs a CRM login on their @${DOMAIN} email, so the invite can go on their calendar.` };
  }
  const setterEmail = clean(b.setter_email, 200).toLowerCase() || caller;
  const bookedAt = new Date();
  const row = {
    deal_id: b.deal_id || null,
    contact_id: b.contact_id || null,
    first_name: first,
    last_name: clean(b.last_name, 80) || null,
    business_name: clean(b.business_name, 160) || null,
    email: clean(b.email, 200).toLowerCase() || null,
    phone: clean(b.phone, 20) || null,
    closer: clean(b.closer, 40),
    closer_email: closerEmail,
    setter: clean(b.setter, 40) || null,
    setter_email: (await allowlisted(admin, setterEmail)) ? setterEmail : caller,
    starts_at: startsAt.toISOString(),
    description: clean(b.description, 4000) || null,
    booked_at: bookedAt.toISOString(),
    lead_time_hours: Math.round(((startsAt.getTime() - bookedAt.getTime()) / 3600e3) * 10) / 10,
    booking_window: bookingWindow(bookedAt, startsAt),
    created_by: caller,
  };
  const { data: m, error } = await admin.from("meetings").insert(row).select().single();
  if (error || !m) return { error: "Couldn't save the meeting: " + (error?.message || "unknown error") };
  await admin.from("meeting_events").insert({ meeting_id: m.id, kind: "booked", by: caller, detail: { starts_at: m.starts_at, booking_window: m.booking_window } });
  return { meeting: await makeEvents(admin, m, caller) };
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

  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) {
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "precall_cron_secret").maybeSingle();
    if (!secret?.value || secret.value !== cronHeader) return json({ error: "Unauthorized." }, 401);
    if (body.action === "check_calendar") {
      const email = clean(body.email, 200).toLowerCase();
      try {
        const r = await cal(email, `?maxResults=1&singleEvents=true&timeMin=${encodeURIComponent(new Date().toISOString())}`);
        return json({ ok: true, calendar_reachable: true, upcoming_events_seen: (r.items || []).length });
      } catch (e) {
        return json({ ok: false, error: String((e as Error)?.message || e) });
      }
    }
    return json({ error: "Unknown action." }, 400);
  }

  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const email = userData?.user?.email?.toLowerCase();
  if (!email || !userData?.user?.email_confirmed_at || !(await allowlisted(admin, email))) return json({ error: "Unauthorized." }, 401);

  if (body.action === "book") return json(await book(admin, body, email));
  if (body.action === "retry_calendar") {
    const { data: m } = await admin.from("meetings").select("*").eq("id", body.meeting_id).maybeSingle();
    if (!m) return json({ error: "That meeting wasn't found." }, 404);
    if (m.status !== "scheduled") return json({ error: "That meeting isn't scheduled any more." });
    return json({ meeting: await makeEvents(admin, m, email) });
  }
  return json({ error: "Unknown action." }, 400);
});
