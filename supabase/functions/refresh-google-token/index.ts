// Edge Function: refresh-google-token
// Exchanges the caller's stored Google refresh_token for a fresh access_token.
// The Google client secret lives only here (as a function secret), never in
// frontend code — that's why this can't just happen in app.js.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const GOOGLE_CLIENT_ID = Deno.env.get("GOOGLE_CLIENT_ID")!;
    const GOOGLE_CLIENT_SECRET = Deno.env.get("GOOGLE_CLIENT_SECRET")!;

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) return json({ error: "Not signed in." }, 401);

    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user }, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !user) return json({ error: "Could not verify who you are." }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
    const { data: row, error: rowErr } = await admin
      .from("google_tokens")
      .select("refresh_token")
      .eq("user_id", user.id)
      .maybeSingle();

    if (rowErr || !row?.refresh_token) {
      return json({ error: "Google Calendar isn't connected for this account yet. Sign out and back in to reconnect." }, 404);
    }

    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: row.refresh_token,
        grant_type: "refresh_token",
      }),
    });
    const tokenData = await resp.json();
    if (!resp.ok) {
      // invalid_grant means Google has revoked/expired this refresh token (commonly
      // because the OAuth consent screen is still in "Testing" mode, which caps
      // refresh tokens for sensitive scopes like calendar at 7 days). Only a fresh
      // consent flow via the Calendar page's "Connect / Reconnect" button fixes it.
      if (tokenData.error === "invalid_grant") {
        return json({ error: "Your Google Calendar connection has expired. Click \"Connect / Reconnect Google Calendar\" on the Calendar page to reconnect." }, 401);
      }
      return json({ error: tokenData.error_description || tokenData.error || "Google token refresh failed." }, 500);
    }

    return json({ access_token: tokenData.access_token, expires_in: tokenData.expires_in });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
