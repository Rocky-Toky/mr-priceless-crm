// Edge Function: scan-meetings
// Called on a schedule (see sql/003_meeting_qualification.sql cron job).
// For every user who has connected Google Calendar, looks at meetings that
// ended in the last ~40 minutes. If any attendee's email is outside the
// internal domain, queues a "was this person qualified?" review row for
// that user to answer next time they open the CRM.

import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });
  }

  const CRON_SECRET = Deno.env.get("CRON_SECRET");
  if (!CRON_SECRET || req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return json({ error: "Unauthorized." }, 401);
  }

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
  const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
  const INTERNAL_DOMAIN = (Deno.env.get("INTERNAL_DOMAIN") || "").toLowerCase();

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: tokenRows, error: tokenErr } = await admin
    .from("google_tokens")
    .select("user_id, refresh_token");

  if (tokenErr) return json({ error: tokenErr.message }, 500);

  const now = new Date();
  const timeMin = new Date(now.getTime() - 40 * 60 * 1000).toISOString();
  const timeMax = now.toISOString();

  let scanned = 0;
  let created = 0;
  const errors: string[] = [];

  for (const row of tokenRows || []) {
    scanned++;
    try {
      const accessToken = await refreshAccessToken(row.refresh_token, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
      if (!accessToken) continue;

      const eventsResp = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime&maxResults=50`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const eventsData = await eventsResp.json();
      if (!eventsResp.ok) { errors.push(`calendar list failed for ${row.user_id}: ${JSON.stringify(eventsData)}`); continue; }

      for (const ev of eventsData.items || []) {
        const endStr = ev.end?.dateTime;
        if (!endStr) continue; // skip all-day events
        const endTime = new Date(endStr);
        if (endTime > now) continue; // still ongoing / not finished yet

        const attendees = ev.attendees || [];
        const externalEmails = attendees
          .filter((a: any) => !a.resource && a.email && !a.email.toLowerCase().endsWith("@" + INTERNAL_DOMAIN))
          .map((a: any) => a.email);

        if (externalEmails.length === 0) continue;

        const { error: insErr } = await admin.from("meeting_reviews").insert({
          user_id: row.user_id,
          google_event_id: ev.id,
          meeting_title: ev.summary || "Untitled meeting",
          meeting_start: ev.start?.dateTime || null,
          meeting_end: endStr,
          external_emails: externalEmails,
          status: "pending",
        });
        // Unique constraint on (user_id, google_event_id) means duplicates just no-op with an error we can ignore.
        if (!insErr) created++;
      }
    } catch (e) {
      errors.push(`user ${row.user_id}: ${String(e)}`);
    }
  }

  return json({ scanned, created, errors });
});

async function refreshAccessToken(refreshToken: string, clientId: string, clientSecret: string): Promise<string | null> {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await resp.json();
  if (!resp.ok) return null;
  return data.access_token;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}
