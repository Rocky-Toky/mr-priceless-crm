// Tests for calendar.ts with Google and Microsoft faked (no network).
// Run: deno test --allow-env supabase/functions/client-portal
import { assert, assertEquals } from "jsr:@std/assert@1";
import { accessToken, authUrl, dayEvents, exchangeCode, putEvent, redirectUri, type Conn } from "./calendar.ts";

Deno.env.set("GOOGLE_OAUTH_CLIENT_ID", "g-id");
Deno.env.set("GOOGLE_OAUTH_CLIENT_SECRET", "g-secret");
Deno.env.set("MS_OAUTH_CLIENT_ID", "m-id");
Deno.env.set("MS_OAUTH_CLIENT_SECRET", "m-secret");

type Call = { url: string; method: string; body: string; headers: Record<string, string> };
function fake(routes: [RegExp, (c: Call) => { status?: number; json: unknown }][]) {
  const calls: Call[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = { url: String(input), method: init?.method || "GET", body: String(init?.body ?? ""), headers: (init?.headers || {}) as Record<string, string> };
    calls.push(c);
    const hit = routes.find(([re]) => re.test(c.method + " " + c.url));
    if (!hit) return new Response("{}", { status: 404 });
    const r = hit[1](c);
    return new Response(JSON.stringify(r.json), { status: r.status || 200 });
  }) as typeof fetch;
  return { f, calls };
}

Deno.test("sign-in links ask for calendar access and come back to our function", () => {
  const g = new URL(authUrl("google", "g-id", "st8", "a@b.co"));
  assertEquals(g.searchParams.get("redirect_uri"), redirectUri("google"));
  assert(g.searchParams.get("scope")!.includes("calendar.events"));
  assertEquals(g.searchParams.get("access_type"), "offline");
  assertEquals(g.searchParams.get("state"), "st8");
  const m = new URL(authUrl("microsoft", "m-id", "st9"));
  assert(m.searchParams.get("scope")!.includes("Calendars.ReadWrite"));
  assert(m.searchParams.get("scope")!.includes("offline_access"));
  assertEquals(m.searchParams.get("redirect_uri"), redirectUri("microsoft"));
});

Deno.test("swapping the code gets tokens and the account's email", async () => {
  const { f, calls } = fake([
    [/POST https:\/\/oauth2\.googleapis\.com\/token/, () => ({ json: { access_token: "at1", refresh_token: "rt1", expires_in: 3600 } })],
    [/userinfo/, () => ({ json: { email: "tradie@gmail.com" } })],
  ]);
  const t = await exchangeCode("google", "code1", f);
  assertEquals(t.refresh_token, "rt1");
  assertEquals(t.account_email, "tradie@gmail.com");
  const sent = new URLSearchParams(calls[0].body);
  assertEquals(sent.get("client_secret"), "g-secret");
  assertEquals(sent.get("grant_type"), "authorization_code");
});

Deno.test("an expired token is refreshed and saved; a revoked one asks them to reconnect", async () => {
  const conn: Conn = { email: "x", provider: "microsoft", refresh_token: "old", access_token: "stale", expires_at: new Date(Date.now() - 1000).toISOString() };
  const saved: any[] = [];
  const ok = fake([[/token/, () => ({ json: { access_token: "fresh", refresh_token: "newrt", expires_in: 3600 } })]]);
  assertEquals(await accessToken(conn, async (p) => saved.push(p), ok.f), "fresh");
  assertEquals(saved[0].refresh_token, "newrt");
  assertEquals(saved[0].error, null);

  const gone = fake([[/token/, () => ({ status: 400, json: { error: "invalid_grant" } })]]);
  const conn2: Conn = { ...conn, access_token: null };
  let threw = false;
  try { await accessToken(conn2, async (p) => saved.push(p), gone.f); } catch { threw = true; }
  assert(threw);
  assertEquals(saved[1].error, "Reconnect your calendar");

  const fine: Conn = { ...conn, access_token: "good", expires_at: new Date(Date.now() + 600e3).toISOString() };
  assertEquals(await accessToken(fine, async () => {}, gone.f), "good");
});

Deno.test("a day's events from Google skip free and cancelled ones", async () => {
  const { f, calls } = fake([[/calendars\/primary\/events/, () => ({ json: { items: [
    { summary: "Site visit - Jo", start: { dateTime: "2026-11-18T01:00:00Z" }, end: { dateTime: "2026-11-18T02:00:00Z" } },
    { summary: "Kids", start: { date: "2026-11-18" }, end: { date: "2026-11-19" } },
    { summary: "Reminder", transparency: "transparent", start: { dateTime: "2026-11-18T03:00:00Z" }, end: { dateTime: "2026-11-18T03:15:00Z" } },
    { status: "cancelled", start: { dateTime: "2026-11-18T04:00:00Z" }, end: { dateTime: "2026-11-18T05:00:00Z" } },
  ] } })]]);
  const ev = await dayEvents({ email: "x", provider: "google", refresh_token: "r", access_token: "a", expires_at: null }, "a", "2026-11-17T11:00:00Z", "2026-11-18T11:00:00Z", f);
  assertEquals(ev.length, 2);
  assertEquals(ev[0].title, "Site visit - Jo");
  assertEquals(ev[1].allDay, true);
  assert(calls[0].url.includes("singleEvents=true"));
});

Deno.test("a day's events from Outlook come back in UTC", async () => {
  const { f, calls } = fake([[/calendarView/, () => ({ json: { value: [
    { subject: "Quote - Sam", start: { dateTime: "2026-11-18T01:00:00.0000000" }, end: { dateTime: "2026-11-18T01:30:00.0000000" }, showAs: "busy" },
    { subject: "Free time", start: { dateTime: "2026-11-18T02:00:00.0000000" }, end: { dateTime: "2026-11-18T03:00:00.0000000" }, showAs: "free" },
  ] } })]]);
  const ev = await dayEvents({ email: "x", provider: "microsoft", refresh_token: "r", access_token: "a", expires_at: null }, "a", "2026-11-17T11:00:00Z", "2026-11-18T11:00:00Z", f);
  assertEquals(ev.length, 1);
  assertEquals(new Date(ev[0].start).toISOString(), "2026-11-18T01:00:00.000Z");
  assertEquals(calls[0].headers.Prefer, 'outlook.timezone="UTC"');
});

Deno.test("a booking is added, then moved instead of added twice", async () => {
  const { f, calls } = fake([
    [/POST https:\/\/www\.googleapis\.com\/calendar\/v3\/calendars\/primary\/events$/, () => ({ json: { id: "ev1" } })],
    [/PATCH .*events\/ev1$/, () => ({ json: { id: "ev1" } })],
    [/PATCH .*events\/gone$/, () => ({ status: 404, json: {} })],
  ]);
  const conn: Conn = { email: "x", provider: "google", refresh_token: "r", access_token: "a", expires_at: null };
  const base = { title: "Site visit - Jo", start: "2026-11-18T01:00:00Z", end: "2026-11-18T02:00:00Z", location: "1 Main St", details: "Phone: 021" };
  assertEquals(await putEvent(conn, "a", base, f), "ev1");
  assertEquals(await putEvent(conn, "a", { ...base, id: "ev1" }, f), "ev1");
  assertEquals(calls[1].method, "PATCH");
  // Deleted in their calendar: make it again.
  assertEquals(await putEvent(conn, "a", { ...base, id: "gone" }, f), "ev1");
  assertEquals(calls[3].method, "POST");
  const ms = fake([[/POST https:\/\/graph\.microsoft\.com\/v1\.0\/me\/events$/, (c) => ({ json: { id: "m1", echo: c.body } })]]);
  assertEquals(await putEvent({ ...conn, provider: "microsoft" }, "a", base, ms.f), "m1");
  const sent = JSON.parse(ms.calls[0].body);
  assertEquals(sent.start, { dateTime: "2026-11-18T01:00:00.000", timeZone: "UTC" });
});
