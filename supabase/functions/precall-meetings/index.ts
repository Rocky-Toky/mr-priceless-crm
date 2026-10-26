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
//     { action: "reschedule", meeting_id, starts_at, reason, note }  moves the invite + buffer
//     { action: "cancel", meeting_id, reason }  cancels both (the prospect is told)
//     { action: "confirm", meeting_id, note }  the setter heard back from them
//     { action: "resolve_flag", meeting_id, do }  accept_move | put_back | mark_cancelled | dismiss
//     { action: "retry_ghl", meeting_id }  pushes the meeting to GHL again
//   Each of those (and an accept / decline seen by the poll) also syncs the
//   meeting to our GHL sub-account - see "GoHighLevel" below.
//   Deploy workflow (header x-cron-secret = app_secrets.precall_cron_secret):
//     { action: "check_calendar", email }  can the CRM reach that person's calendar?
//     { action: "setup_ghl" }  makes any missing GHL custom fields, lists what's there
//   pg_cron every 5 minutes (sql/083), same header:
//     { action: "poll" }  checks each upcoming invite: an accept confirms the
//       meeting; a decline, or the event moved / deleted in Google, is flagged
//       and emailed to the setter. Nothing about the meeting itself changes.
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
// The closer's name as it reads in the invite title ("Sarah Tane x Maximus").
const CLOSER_NAME: Record<string, string> = { max: "Maximus", rocky: "Rocky", gabriel: "Gabriel", raheem: "Randy", thor: "Thor" };
const closerName = (m: any) => CLOSER_NAME[m.closer] || String(m.closer_email || "").split(/[.@]/)[0].replace(/^./, (c) => c.toUpperCase());

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
      summary: `${fullName(m)} x ${closerName(m)}`,
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

/* ───────── GoHighLevel: keep our own sub-account up to date ─────────
   Every booking change upserts the prospect as a GHL contact, sets the
   meeting's custom fields, and leaves exactly one precall-* tag on them.
   GHL's own workflows (built in GHL) send the texts and emails from those.
   Token and location: GHL_PRECALL_TOKEN / GHL_PRECALL_LOCATION_ID. Tag names
   can be changed with PRECALL_TAG_<STATE> (e.g. PRECALL_TAG_BOOKED). */
const GHL = "https://services.leadconnectorhq.com";
const GHL_TOKEN = Deno.env.get("GHL_PRECALL_TOKEN") || "";
const GHL_LOCATION = Deno.env.get("GHL_PRECALL_LOCATION_ID") || "";
const TAG_STATES = ["booked", "rescheduled", "cancelled", "confirmed", "onehour-noanswer", "showed", "noshow"];
const TAGS: Record<string, string> = Object.fromEntries(TAG_STATES.map((k) => [k, Deno.env.get("PRECALL_TAG_" + k.toUpperCase().replace(/-/g, "_")) || "precall-" + k]));
// The custom fields, created in GHL by the CRM if they aren't there yet.
const GHL_FIELDS: [string, string][] = [
  ["appointment_time", "DATE"], ["appointment_time_display", "TEXT"], ["appointment_day_display", "TEXT"],
  ["meet_link", "TEXT"], ["closer_name", "TEXT"], ["setter_name", "TEXT"], ["setter_mobile", "TEXT"],
  ["booking_window", "TEXT"], ["meeting_before_11am", "TEXT"], ["confirmation_status", "TEXT"], ["reschedule_count", "NUMERICAL"],
];
class GhlError extends Error { constructor(msg: string, public status = 0) { super(msg); } }
// Retries what's worth retrying (rate limits, GHL hiccups) with backoff: 1s, 3s.
async function ghl(path: string, init: RequestInit = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(GHL + path, {
      ...init,
      headers: { Authorization: `Bearer ${GHL_TOKEN}`, Version: "2021-07-28", Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) return body;
    if ((res.status === 429 || res.status >= 500) && attempt < 2) { await new Promise((r) => setTimeout(r, attempt ? 3000 : 1000)); continue; }
    const msg = Array.isArray(body?.message) ? body.message.join(", ") : body?.message || body?.error || `GHL returned ${res.status}`;
    throw new GhlError(res.status === 401 ? "GHL rejected the token (GHL_PRECALL_TOKEN)" : String(msg), res.status);
  }
}
let fieldIds: Record<string, string> | null = null;
async function ghlFields(create = true) {
  if (fieldIds) return fieldIds;
  const body = await ghl(`/locations/${GHL_LOCATION}/customFields?model=contact`);
  const have: Record<string, string> = {};
  for (const f of body?.customFields || []) {
    const key = String(f.fieldKey || "").replace(/^contact\./, "");
    for (const [name] of GHL_FIELDS) if (key === name || f.name === name) have[name] = f.id;
  }
  if (create) {
    for (const [name, dataType] of GHL_FIELDS) {
      if (have[name]) continue;
      const made = await ghl(`/locations/${GHL_LOCATION}/customFields`, { method: "POST", body: JSON.stringify({ name, dataType, model: "contact" }) });
      have[name] = made?.customField?.id || made?.id;
    }
  }
  fieldIds = have;
  return have;
}

const nzParts = (d: Date) => Object.fromEntries(new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, hourCycle: "h23", weekday: "long", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", timeZoneName: "longOffset" })
  .formatToParts(d).map((p) => [p.type, p.value]));
// "2026-10-29T14:00:00+13:00": NZ wall-clock time with its offset, so GHL
// (set to Pacific/Auckland) reads it as the right moment.
function nzIso(d: Date) {
  const p = nzParts(d);
  const off = String(p.timeZoneName || "GMT+13:00").replace("GMT", "") || "+00:00";
  return `${p.year}-${p.month}-${p.day}T${String(+p.hour % 24).padStart(2, "0")}:${p.minute}:${p.second}${off}`;
}
const nzClock = (d: Date) => { const p = nzParts(d); const h = +p.hour % 24; return `${h % 12 || 12}:${p.minute}${h < 12 ? "am" : "pm"}`; };

// The state the meeting's in, which decides its one precall-* tag.
function tagState(m: any) {
  if (m.status === "cancelled") return "cancelled";
  if (m.outcome === "showed" || m.outcome === "noshow") return m.outcome;
  if (m.onehour_noanswer_at && m.confirmation_status !== "confirmed") return "onehour-noanswer";
  if (m.confirmation_status === "confirmed") return "confirmed";
  return m.reschedule_count ? "rescheduled" : "booked";
}

async function ghlTestAllows(admin: SupabaseClient, m: any) {
  const { data } = await admin.from("precall_settings").select("test_mode, test_allowlist").eq("id", 1).maybeSingle();
  if (data && data.test_mode === false) return true;
  const list = String(data?.test_allowlist || "").toLowerCase().split(/[,\s]+/).filter(Boolean);
  const digits = (v: string) => v.replace(/\D/g, "");
  const email = String(m.email || "").toLowerCase();
  return (!!email && (email.endsWith("@" + DOMAIN) || list.includes(email))) ||
    (!!m.phone && list.some((x) => digits(x).length >= 8 && digits(x) === digits(m.phone)));
}

async function syncGhl(admin: SupabaseClient, m: any, by = "") {
  if (!m) return m;
  if (!GHL_TOKEN || !GHL_LOCATION) return m;
  if (!m.email && !m.phone) return await save(admin, m, { ghl_status: "skipped", ghl_error: "No email or mobile to match a GHL contact" });
  if (!(await ghlTestAllows(admin, m))) return await save(admin, m, { ghl_status: "skipped", ghl_error: "Test mode: only our own emails and the test list go to GHL" });
  try {
    const f = await ghlFields();
    const start = new Date(m.starts_at);
    const { data: setter } = m.setter ? await admin.from("employees").select("phone").eq("person_key", m.setter).maybeSingle() : { data: null };
    const values: Record<string, unknown> = {
      appointment_time: nzIso(start),
      appointment_time_display: `${nzParts(start).weekday} ${nzClock(start)}`,
      appointment_day_display: nzParts(start).weekday,
      meet_link: m.meet_link || "",
      closer_name: personName(m.closer, m.closer_email),
      setter_name: personName(m.setter, m.setter_email),
      setter_mobile: setter?.phone ? toE164(setter.phone) : "",
      booking_window: m.booking_window || "",
      meeting_before_11am: +nzParts(start).hour % 24 < 11 ? "true" : "false",
      confirmation_status: m.confirmation_status || "unconfirmed",
      reschedule_count: m.reschedule_count || 0,
    };
    const upsert = (vals: Record<string, unknown>) => ghl("/contacts/upsert", {
      method: "POST",
      body: JSON.stringify({
        locationId: GHL_LOCATION, firstName: m.first_name, lastName: m.last_name || "", name: fullName(m),
        ...(m.email ? { email: m.email } : {}), ...(m.phone ? { phone: m.phone } : {}), ...(m.business_name ? { companyName: m.business_name } : {}),
        customFields: Object.entries(vals).filter(([k]) => f[k]).map(([k, v]) => ({ id: f[k], field_value: v })),
      }),
    });
    // A date field that won't take a time gets just the NZ date instead.
    let up: any, dateNote = "";
    try { up = await upsert(values); } catch (e) {
      if (![400, 422].includes((e as GhlError).status)) throw e;
      up = await upsert({ ...values, appointment_time: nzIso(start).slice(0, 10) });
      dateNote = "appointment_time sent as a date only";
    }
    const contactId = up?.contact?.id || up?.id;
    if (!contactId) throw new GhlError("GHL didn't send back a contact");
    // Exactly one precall-* tag: take the others off first, so a workflow
    // listening for the new one never sees two at once.
    const state = tagState(m), tag = TAGS[state];
    const others = TAG_STATES.filter((k) => k !== state).map((k) => TAGS[k]);
    await ghl(`/contacts/${contactId}/tags`, { method: "DELETE", body: JSON.stringify({ tags: others }) });
    await ghl(`/contacts/${contactId}/tags`, { method: "POST", body: JSON.stringify({ tags: [tag] }) });
    if (m.contact_id) await admin.from("contacts").update({ ghl_contact_id: contactId }).eq("id", m.contact_id);
    if (m.ghl_tag !== tag || dateNote) await logEvent(admin, m, "ghl_tag", by || "crm", { tag, from: m.ghl_tag || null, note: dateNote || null });
    return await save(admin, m, { ghl_contact_id: contactId, ghl_status: "ok", ghl_error: null, ghl_tag: tag, ghl_synced_at: nowIso(), ghl_attempts: 0 });
  } catch (e) {
    const msg = String((e as Error)?.message || e).slice(0, 400);
    console.log(`ghl sync error for meeting ${m.id}: ${msg}`);
    await logEvent(admin, m, "ghl_error", by || "crm", { error: msg });
    return await save(admin, m, { ghl_status: "error", ghl_error: msg, ghl_attempts: (m.ghl_attempts || 0) + 1 });
  }
}
const PERSON_NAME: Record<string, string> = { max: "Maximus", rocky: "Rocky", gabriel: "Gabriel", raheem: "Randy", thor: "Thor" };
const personName = (key: string, email = "") => PERSON_NAME[key] || String(email || key || "").split(/[.@]/)[0].replace(/^./, (c) => c.toUpperCase());
function toE164(raw: string) {
  const s = String(raw || "").trim();
  if (s.startsWith("+")) return "+" + s.replace(/\D/g, "");
  const d = s.replace(/\D/g, "");
  if (d.startsWith("64") || d.startsWith("61")) return "+" + d;
  return "+64" + d.replace(/^0/, "");
}

/* ───────── Reschedule, cancel, confirm ───────── */
const REASONS: Record<string, string> = {
  prospect_conflict: "Prospect couldn't make it",
  closer_conflict: "Closer couldn't make it",
  no_show: "No-show",
  other: "Other",
};
const nowIso = () => new Date().toISOString();
const nzWhen = (iso: string) => new Intl.DateTimeFormat("en-NZ", { timeZone: TZ, weekday: "long", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(new Date(iso));
const slot = (start: Date, mins: number) => ({ dateTime: new Date(start.getTime() + mins * 60e3).toISOString(), timeZone: TZ });
const gone = (e: unknown) => [404, 410].includes((e as GoogleError).status);

async function loadMeeting(admin: SupabaseClient, id: unknown) {
  const { data } = await admin.from("meetings").select("*").eq("id", String(id || "")).maybeSingle();
  return data;
}
async function logEvent(admin: SupabaseClient, m: any, kind: string, by: string, detail: any = {}) {
  await admin.from("meeting_events").insert({ meeting_id: m.id, kind, by, detail });
}
async function save(admin: SupabaseClient, m: any, patch: any) {
  const { data } = await admin.from("meetings").update({ ...patch, updated_at: nowIso() }).eq("id", m.id).select().single();
  return data;
}
// A new time means the old confirmation no longer counts.
const unconfirmed = () => ({ confirmation_status: "unconfirmed", confirmed_at: null, confirmed_today_at: null, prospect_response: null });

// Moves the invite (same event, same Meet link - the prospect gets the
// update) and the buffer after it. status "confirmed" also brings back an
// event someone deleted in Google.
async function moveEvents(m: any, start: Date, moveMain = true) {
  if (moveMain && m.google_event_id) {
    await cal(m.closer_email, `/${m.google_event_id}?sendUpdates=all&conferenceDataVersion=1`, {
      method: "PATCH", body: JSON.stringify({ start: slot(start, 0), end: slot(start, m.duration_min), status: "confirmed" }),
    });
  }
  if (m.buffer_event_id) {
    try {
      await cal(m.closer_email, `/${m.buffer_event_id}?sendUpdates=none`, {
        method: "PATCH", body: JSON.stringify({ start: slot(start, m.duration_min), end: slot(start, m.duration_min + m.buffer_min), status: "confirmed" }),
      });
    } catch (e) { if (!gone(e)) throw e; }
  }
}

async function reschedule(admin: SupabaseClient, b: any, caller: string) {
  const m = await loadMeeting(admin, b.meeting_id);
  if (!m) return { error: "That meeting wasn't found." };
  if (m.status !== "scheduled") return { error: "That meeting isn't scheduled any more." };
  const start = new Date(b.starts_at);
  if (isNaN(start.getTime())) return { error: "Pick the new date and time." };
  if (start.getTime() < Date.now() - 10 * 60e3) return { error: "That time has already passed." };
  const reason = REASONS[b.reason] ? b.reason : "";
  if (!reason) return { error: "Pick why it's being moved." };
  if (m.google_event_id) {
    try { await moveEvents(m, start); } catch (e) { return { error: "Google Calendar didn't take the new time, so nothing's changed: " + String((e as Error)?.message || e) }; }
  }
  const now = new Date();
  const flags = { ...(m.calendar_flag_detail || {}) };
  delete flags.moved; delete flags.deleted; delete flags.declined;
  const saved = await save(admin, m, {
    starts_at: start.toISOString(), reschedule_count: (m.reschedule_count || 0) + 1, ...unconfirmed(),
    booking_window: bookingWindow(now, start), lead_time_hours: Math.round(((start.getTime() - now.getTime()) / 3600e3) * 10) / 10,
    calendar_flag: null, calendar_flag_detail: flags,
  });
  await logEvent(admin, m, "rescheduled", caller, { from: m.starts_at, to: start.toISOString(), reason, note: clean(b.note, 1000) || null, count: saved?.reschedule_count });
  // No invite yet (it failed at booking): try making it now, at the new time.
  return { meeting: m.google_event_id ? saved : await makeEvents(admin, saved, caller) };
}

async function deleteEvents(m: any) {
  for (const [id, notify] of [[m.google_event_id, "all"], [m.buffer_event_id, "none"]]) {
    if (!id) continue;
    try { await cal(m.closer_email, `/${id}?sendUpdates=${notify}`, { method: "DELETE" }); } catch (e) { if (!gone(e)) throw e; }
  }
}
async function cancel(admin: SupabaseClient, b: any, caller: string) {
  const m = await loadMeeting(admin, b.meeting_id);
  if (!m) return { error: "That meeting wasn't found." };
  if (m.status !== "scheduled") return { error: "That meeting isn't scheduled any more." };
  const reason = clean(b.reason, 500);
  if (!reason) return { error: "Say why it's being cancelled." };
  try { await deleteEvents(m); } catch (e) { return { error: "Google Calendar didn't cancel the invite, so nothing's changed: " + String((e as Error)?.message || e) }; }
  const saved = await save(admin, m, { status: "cancelled", cancel_reason: reason, cancelled_at: nowIso(), cancelled_by: caller, calendar_flag: null });
  await logEvent(admin, m, "cancelled", caller, { reason });
  return { meeting: saved };
}

async function confirmMeeting(admin: SupabaseClient, m: any, source: string, by: string, note = "") {
  const now = new Date();
  const today = nzDay(now) === nzDay(new Date(m.starts_at));
  const entry = { source, at: now.toISOString(), by, note: note || null, meeting_day: today };
  const saved = await save(admin, m, {
    confirmation_status: "confirmed",
    confirmed_at: m.confirmed_at || now.toISOString(),
    // Only the setter hearing from them on the day counts as "confirmed today".
    ...(today && source === "setter" ? { confirmed_today_at: now.toISOString() } : {}),
    confirmations: [...(Array.isArray(m.confirmations) ? m.confirmations : []), entry],
  });
  await logEvent(admin, m, "confirmed", by, { source, note: note || null, meeting_day: today });
  return saved;
}

/* ───────── Watching Google Calendar (every 5 minutes) ───────── */
let alertsQueued = 0;
// calendar_flag_detail keeps what's been seen: { moved: {from, to, at}, deleted: {at}, declined: {at} },
// each with dismissed: true once someone's dealt with it. calendar_flag is the one that needs attention.
const FLAG_ORDER = ["deleted", "moved", "declined"];
const topFlag = (flags: any) => FLAG_ORDER.find((k) => flags[k] && !flags[k].dismissed) || null;
const CRM_URL = "https://rocky-toky.github.io/mr-priceless-crm/";

async function alertSetter(admin: SupabaseClient, m: any, kind: string, extra = "") {
  const to = m.setter_email || m.created_by;
  if (!to) return;
  alertsQueued++;
  const who = fullName(m) + (m.business_name ? ` (${m.business_name})` : "");
  const what: Record<string, string> = {
    declined: `${who} declined the calendar invite for ${nzWhen(m.starts_at)}.`,
    moved: `${who}'s meeting was moved in Google Calendar${extra ? ` to ${nzWhen(extra)}` : ""}. It was booked for ${nzWhen(m.starts_at)}.`,
    deleted: `${who}'s meeting on ${nzWhen(m.starts_at)} was deleted from Google Calendar.`,
  };
  await admin.from("scheduled_emails").insert({
    kind: "precall_alert", to_email: to,
    subject: kind === "declined" ? `${fullName(m)} declined their meeting` : `${fullName(m)}'s meeting changed in Google Calendar`,
    body: `Hey,\n\n${what[kind]}\n\nNothing's been changed in the CRM. Open Upcoming Meetings to sort it out${kind === "declined" ? " - give them a call" : ""}:\n${CRM_URL}\n\nMr Priceless CRM`,
    send_at: nowIso(), created_by: "precall-watch",
  });
}

// The email sender normally runs every 5 minutes; nudge it so an alert goes
// out now rather than up to 5 minutes later.
async function kickEmailSender(admin: SupabaseClient) {
  const { data } = await admin.from("app_secrets").select("value").eq("name", "email_cron_secret").maybeSingle();
  if (!data?.value) return;
  try {
    await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/send-scheduled-emails`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${Deno.env.get("SUPABASE_ANON_KEY")}`, "x-cron-secret": data.value },
      body: "{}",
    });
  } catch { /* the 5-minute run picks it up anyway */ }
}

async function poll(admin: SupabaseClient) {
  const now = Date.now();
  const { data: list } = await admin.from("meetings").select("*").eq("status", "scheduled").not("google_event_id", "is", null)
    .gt("starts_at", new Date(now - 2 * 3600e3).toISOString()).lt("starts_at", new Date(now + 120 * 86400e3).toISOString()).order("starts_at").limit(300);
  let checked = 0, changed = 0, errors = 0;
  alertsQueued = 0;
  for (const m of list || []) {
    let ev: any = null;
    try { ev = await cal(m.closer_email, "/" + m.google_event_id); } catch (e) {
      if (!gone(e)) { errors++; continue; }
      ev = { status: "cancelled" };
    }
    checked++;
    const before = m.confirmation_status;
    const flags = JSON.parse(JSON.stringify(m.calendar_flag_detail || {}));
    const patch: any = { calendar_checked_at: nowIso() };
    const at = nowIso();
    if (ev.status === "cancelled") {
      if (!flags.deleted) { flags.deleted = { at }; await logEvent(admin, m, "deleted_in_google", "google"); await alertSetter(admin, m, "deleted"); }
    } else {
      delete flags.deleted;
      const gStart = Date.parse(ev.start?.dateTime || ev.start?.date || "");
      if (gStart && Math.abs(gStart - Date.parse(m.starts_at)) > 60e3) {
        const to = new Date(gStart).toISOString();
        if (flags.moved?.to !== to) { flags.moved = { from: m.starts_at, to, at }; await logEvent(admin, m, "moved_in_google", "google", { from: m.starts_at, to }); await alertSetter(admin, m, "moved", to); }
      } else delete flags.moved;
      const att = m.email ? (ev.attendees || []).find((a: any) => String(a.email || "").toLowerCase() === m.email) : null;
      const resp = att?.responseStatus || null;
      if (resp && resp !== m.prospect_response) {
        patch.prospect_response = resp;
        if (resp !== "needsAction") await logEvent(admin, m, "invite_" + resp, "google");
        if (resp === "accepted" && m.confirmation_status !== "confirmed") Object.assign(m, await confirmMeeting(admin, m, "calendar", "google"));
      }
      if (resp === "declined") {
        if (m.confirmation_status === "confirmed" && resp !== m.prospect_response) Object.assign(patch, { confirmation_status: "unconfirmed", confirmed_today_at: null });
        if (!flags.declined) { flags.declined = { at }; await alertSetter(admin, m, "declined"); }
      } else delete flags.declined;
    }
    patch.calendar_flag_detail = flags;
    patch.calendar_flag = topFlag(flags);
    if (patch.calendar_flag !== m.calendar_flag || patch.prospect_response) changed++;
    const { data: saved } = await admin.from("meetings").update(patch).eq("id", m.id).select().single();
    if (saved && saved.confirmation_status !== before) await syncGhl(admin, saved, "google");
  }
  // GHL syncs that failed get another go (up to 8 tries, 5 minutes apart).
  const { data: retry } = await admin.from("meetings").select("*").eq("status", "scheduled").eq("ghl_status", "error").lt("ghl_attempts", 8).limit(25);
  const { data: retryGone } = await admin.from("meetings").select("*").eq("status", "cancelled").eq("ghl_status", "error").lt("ghl_attempts", 8).limit(25);
  for (const m of [...(retry || []), ...(retryGone || [])]) await syncGhl(admin, m, "retry");
  if (alertsQueued) await kickEmailSender(admin);
  return { checked, changed, errors, alerts: alertsQueued, ghl_retried: (retry || []).length + (retryGone || []).length };
}

// What the setter does about a flag: take the new time from Google, put a
// deleted invite back, cancel it, or just mark it seen.
async function resolveFlag(admin: SupabaseClient, b: any, caller: string) {
  const m = await loadMeeting(admin, b.meeting_id);
  if (!m) return { error: "That meeting wasn't found." };
  const flags = { ...(m.calendar_flag_detail || {}) };
  const kind = m.calendar_flag;
  if (!kind || !flags[kind]) return { meeting: m };
  if (b.do === "accept_move" && kind === "moved") {
    const start = new Date(flags.moved.to);
    try { await moveEvents(m, start, false); } catch (e) { return { error: "Couldn't move the buffer: " + String((e as Error)?.message || e) }; }
    delete flags.moved;
    const now = new Date();
    const saved = await save(admin, m, {
      starts_at: start.toISOString(), reschedule_count: (m.reschedule_count || 0) + 1, ...unconfirmed(),
      booking_window: bookingWindow(now, start), lead_time_hours: Math.round(((start.getTime() - now.getTime()) / 3600e3) * 10) / 10,
      calendar_flag_detail: flags, calendar_flag: topFlag(flags),
    });
    await logEvent(admin, m, "rescheduled", caller, { from: m.starts_at, to: start.toISOString(), reason: "closer_conflict", note: "Moved in Google Calendar", count: saved?.reschedule_count });
    return { meeting: saved };
  }
  if (b.do === "put_back" && kind === "deleted") {
    try { await moveEvents(m, new Date(m.starts_at)); } catch (e) { return { error: "Google wouldn't bring the invite back: " + String((e as Error)?.message || e) }; }
    delete flags.deleted;
    await logEvent(admin, m, "restored", caller);
    return { meeting: await save(admin, m, { calendar_flag_detail: flags, calendar_flag: topFlag(flags) }) };
  }
  if (b.do === "mark_cancelled" && kind === "deleted") {
    return await cancel(admin, { meeting_id: m.id, reason: "Deleted in Google Calendar" }, caller);
  }
  if (b.do === "dismiss") {
    flags[kind] = { ...flags[kind], dismissed: true, by: caller };
    await logEvent(admin, m, "flag_dismissed", caller, { flag: kind });
    return { meeting: await save(admin, m, { calendar_flag_detail: flags, calendar_flag: topFlag(flags) }) };
  }
  return { error: "That can't be done for this meeting." };
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
    if (body.action === "poll") return json(await poll(admin));
    if (body.action === "setup_ghl") {
      if (!GHL_TOKEN || !GHL_LOCATION) return json({ ok: false, error: "GHL_PRECALL_TOKEN / GHL_PRECALL_LOCATION_ID aren't set." });
      try {
        const before = Object.keys(await ghlFields(false)); fieldIds = null;
        const after = await ghlFields(true);
        return json({ ok: true, fields_already_there: before, fields_created: Object.keys(after).filter((k) => !before.includes(k)), tags: Object.values(TAGS) });
      } catch (e) { return json({ ok: false, error: String((e as Error)?.message || e) }); }
    }
    return json({ error: "Unknown action." }, 400);
  }

  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const email = userData?.user?.email?.toLowerCase();
  if (!email || !userData?.user?.email_confirmed_at || !(await allowlisted(admin, email))) return json({ error: "Unauthorized." }, 401);

  const synced = async (r: any) => (r?.meeting ? { ...r, meeting: await syncGhl(admin, r.meeting, email) } : r);
  if (body.action === "book") return json(await synced(await book(admin, body, email)));
  if (body.action === "retry_calendar") {
    const { data: m } = await admin.from("meetings").select("*").eq("id", body.meeting_id).maybeSingle();
    if (!m) return json({ error: "That meeting wasn't found." }, 404);
    if (m.status !== "scheduled") return json({ error: "That meeting isn't scheduled any more." });
    return json({ meeting: await makeEvents(admin, m, email) });
  }
  if (body.action === "reschedule") return json(await synced(await reschedule(admin, body, email)));
  if (body.action === "cancel") return json(await synced(await cancel(admin, body, email)));
  if (body.action === "retry_ghl") {
    const m = await loadMeeting(admin, body.meeting_id);
    if (!m) return json({ error: "That meeting wasn't found." }, 404);
    if (!GHL_TOKEN || !GHL_LOCATION) return json({ error: "GHL isn't connected yet." });
    return json({ meeting: await syncGhl(admin, m, email) });
  }
  if (body.action === "confirm") {
    const m = await loadMeeting(admin, body.meeting_id);
    if (!m || m.status !== "scheduled") return json({ error: "That meeting isn't scheduled any more." });
    return json(await synced({ meeting: await confirmMeeting(admin, m, "setter", email, clean(body.note, 500)) }));
  }
  if (body.action === "resolve_flag") return json(await synced(await resolveFlag(admin, body, email)));
  return json({ error: "Unknown action." }, 400);
});
