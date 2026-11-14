// Client portal calendar connections: one-click Google Calendar / Outlook
// (OAuth). A connected client sees their own calendar and free times when they
// book a site visit or a call, and those bookings go into their calendar.
//
// Setup (repo secrets, passed on by the deploy workflow; until they're set the
// portal doesn't offer the buttons):
//   GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET   (Google Cloud OAuth client, "Web application")
//   MS_OAUTH_CLIENT_ID / MS_OAUTH_CLIENT_SECRET           (Microsoft Entra app registration)
// Redirect URIs to register:
//   https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/client-portal/oauth/google
//   https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/client-portal/oauth/microsoft
//
// Tokens live in portal_calendars (sql/117, server only). Everything here takes
// a `fetch` so the tests can fake Google and Microsoft.

export type Provider = "google" | "microsoft";
export type Conn = { email: string; provider: Provider; account_email?: string | null; refresh_token: string | null; access_token: string | null; expires_at: string | null };
export type CalEvent = { title: string; start: string; end: string; allDay: boolean };
type Fetch = typeof fetch;

const FUNCTIONS_URL = "https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/client-portal";
export const redirectUri = (p: Provider) => `${FUNCTIONS_URL}/oauth/${p}`;

export function creds(p: Provider) {
  const id = Deno.env.get(p === "google" ? "GOOGLE_OAUTH_CLIENT_ID" : "MS_OAUTH_CLIENT_ID") || "";
  const secret = Deno.env.get(p === "google" ? "GOOGLE_OAUTH_CLIENT_SECRET" : "MS_OAUTH_CLIENT_SECRET") || "";
  return id && secret ? { id, secret } : null;
}

export function authUrl(p: Provider, clientId: string, state: string, loginHint = ""): string {
  if (p === "google") {
    const q = new URLSearchParams({
      client_id: clientId, redirect_uri: redirectUri(p), response_type: "code", state,
      scope: "openid email https://www.googleapis.com/auth/calendar.events",
      access_type: "offline", prompt: "consent", include_granted_scopes: "true",
      ...(loginHint ? { login_hint: loginHint } : {}),
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
  }
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri(p), response_type: "code", state, response_mode: "query",
    scope: "openid email offline_access User.Read Calendars.ReadWrite", prompt: "select_account",
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${q}`;
}

const TOKEN_URL = { google: "https://oauth2.googleapis.com/token", microsoft: "https://login.microsoftonline.com/common/oauth2/v2.0/token" };

async function tokenCall(p: Provider, body: Record<string, string>, f: Fetch) {
  const c = creds(p);
  if (!c) throw new Error("Calendar connections aren't set up yet");
  const res = await f(TOKEN_URL[p], {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: c.id, client_secret: c.secret, ...body, ...(p === "microsoft" ? { scope: "openid email offline_access User.Read Calendars.ReadWrite" } : {}) }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: any = new Error(out?.error_description || out?.error || `Sign-in failed (${res.status})`);
    err.code = out?.error || "";
    throw err;
  }
  return out;
}

// The sign-in came back: swap the code for tokens and find out whose calendar it is.
export async function exchangeCode(p: Provider, code: string, f: Fetch = fetch) {
  const t = await tokenCall(p, { code, grant_type: "authorization_code", redirect_uri: redirectUri(p) }, f);
  let account = "";
  try {
    if (p === "google") {
      const r = await f("https://openidconnect.googleapis.com/v1/userinfo", { headers: { Authorization: `Bearer ${t.access_token}` } });
      account = (await r.json())?.email || "";
    } else {
      const r = await f("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName", { headers: { Authorization: `Bearer ${t.access_token}` } });
      const me = await r.json();
      account = me?.mail || me?.userPrincipalName || "";
    }
  } catch (_e) { /* the account name is only for show */ }
  return {
    access_token: t.access_token as string,
    refresh_token: (t.refresh_token as string) || null,
    expires_at: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60e3).toISOString(),
    account_email: account,
  };
}

// A working access token for the connection, refreshing it when it's due.
// save() stores what changed (new access token, or the error to show).
export async function accessToken(conn: Conn, save: (patch: Record<string, unknown>) => Promise<unknown>, f: Fetch = fetch): Promise<string> {
  if (conn.access_token && conn.expires_at && new Date(conn.expires_at).getTime() > Date.now() + 30e3) return conn.access_token;
  if (!conn.refresh_token) { await save({ error: "Reconnect your calendar" }); throw new Error("Reconnect your calendar"); }
  try {
    const t = await tokenCall(conn.provider, { refresh_token: conn.refresh_token, grant_type: "refresh_token" }, f);
    const patch: Record<string, unknown> = {
      access_token: t.access_token, expires_at: new Date(Date.now() + (Number(t.expires_in) || 3600) * 1000 - 60e3).toISOString(),
      error: null, updated_at: new Date().toISOString(),
    };
    if (t.refresh_token) patch.refresh_token = t.refresh_token; // Microsoft hands out a new one each time
    await save(patch);
    conn.access_token = t.access_token;
    return t.access_token;
  } catch (e) {
    if ((e as any).code === "invalid_grant") await save({ error: "Reconnect your calendar", access_token: null });
    throw e;
  }
}

// Their events between two times (their own calendar, so titles are fine to show).
export async function dayEvents(conn: Conn, token: string, from: string, to: string, f: Fetch = fetch): Promise<CalEvent[]> {
  if (conn.provider === "google") {
    const q = new URLSearchParams({ timeMin: from, timeMax: to, singleEvents: "true", orderBy: "startTime", maxResults: "50" });
    const r = await f(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(`Google Calendar said ${r.status}`);
    const out = await r.json();
    return (out.items || []).filter((e: any) => e.status !== "cancelled" && e.transparency !== "transparent").map((e: any) => ({
      title: e.summary || "Busy",
      start: e.start?.dateTime || e.start?.date,
      end: e.end?.dateTime || e.end?.date,
      allDay: !e.start?.dateTime,
    }));
  }
  const q = new URLSearchParams({ startDateTime: from, endDateTime: to, $top: "50", $orderby: "start/dateTime", $select: "subject,start,end,isAllDay,showAs,isCancelled" });
  const r = await f(`https://graph.microsoft.com/v1.0/me/calendarView?${q}`, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } });
  if (!r.ok) throw new Error(`Outlook said ${r.status}`);
  const out = await r.json();
  const utc = (s: string) => s ? (/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(/(\.\d{3})\d*$/, "$1") + "Z") : s;
  return (out.value || []).filter((e: any) => !e.isCancelled && e.showAs !== "free").map((e: any) => ({
    title: e.subject || "Busy", start: utc(e.start?.dateTime), end: utc(e.end?.dateTime), allDay: !!e.isAllDay,
  }));
}

// Put a booking in their calendar, or move the one we already made.
export async function putEvent(conn: Conn, token: string, ev: { id?: string | null; title: string; start: string; end: string; location: string; details: string }, f: Fetch = fetch): Promise<string> {
  if (conn.provider === "google") {
    const body = JSON.stringify({ summary: ev.title, location: ev.location || undefined, description: ev.details, start: { dateTime: ev.start }, end: { dateTime: ev.end } });
    const base = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
    let r = ev.id ? await f(`${base}/${encodeURIComponent(ev.id)}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body }) : null;
    if (!r || r.status === 404 || r.status === 410) r = await f(base, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
    if (!r.ok) throw new Error(`Google Calendar said ${r.status}`);
    return (await r.json()).id;
  }
  const iso = (s: string) => new Date(s).toISOString().replace("Z", "");
  const body = JSON.stringify({
    subject: ev.title, body: { contentType: "text", content: ev.details }, location: { displayName: ev.location || "" },
    start: { dateTime: iso(ev.start), timeZone: "UTC" }, end: { dateTime: iso(ev.end), timeZone: "UTC" },
  });
  const base = "https://graph.microsoft.com/v1.0/me/events";
  let r = ev.id ? await f(`${base}/${encodeURIComponent(ev.id)}`, { method: "PATCH", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body }) : null;
  if (!r || r.status === 404) r = await f(base, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body });
  if (!r.ok) throw new Error(`Outlook said ${r.status}`);
  return (await r.json()).id;
}
