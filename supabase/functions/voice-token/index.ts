// Edge Function: voice-token
// Called by the browser right before placing a call from the Dialer. Verifies
// the caller is a signed-in, allowlisted user, then mints a short-lived
// Twilio Access Token (a signed JWT) scoped to outbound voice calls through
// our TwiML App. The Twilio Voice JS SDK uses this token to open a WebRTC
// connection - the actual PSTN leg (dialling the prospect's real number) is
// handled by the voice-twiml function once the call connects.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID")!;
  const TWILIO_API_KEY_SID = Deno.env.get("TWILIO_API_KEY_SID")!;
  const TWILIO_API_KEY_SECRET = Deno.env.get("TWILIO_API_KEY_SECRET")!;
  const TWILIO_TWIML_APP_SID = Deno.env.get("TWILIO_TWIML_APP_SID")!;

  const authHeader = req.headers.get("Authorization") || "";
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user?.email) return json({ error: "Unauthorized." }, 401);

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: allowed } = await admin.from("allowlist").select("email").eq("email", user.email).maybeSingle();
  if (!allowed) return json({ error: "Unauthorized." }, 401);

  const identity = user.email.replace(/[^a-zA-Z0-9_.-]/g, "_");
  const token = await buildAccessToken({
    accountSid: TWILIO_ACCOUNT_SID,
    apiKeySid: TWILIO_API_KEY_SID,
    apiKeySecret: TWILIO_API_KEY_SECRET,
    twimlAppSid: TWILIO_TWIML_APP_SID,
    identity,
  });

  return json({ token, identity });
});

async function buildAccessToken(opts: {
  accountSid: string; apiKeySid: string; apiKeySecret: string; twimlAppSid: string; identity: string;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { typ: "JWT", alg: "HS256", cty: "twilio-fpa;v=1" };
  const payload = {
    jti: `${opts.apiKeySid}-${now}`,
    iss: opts.apiKeySid,
    sub: opts.accountSid,
    exp: now + 3600,
    nbf: now,
    grants: {
      identity: opts.identity,
      voice: { outgoing: { application_sid: opts.twimlAppSid }, incoming: { allow: false } },
    },
  };
  const encoder = new TextEncoder();
  const base64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const headerB64 = base64url(encoder.encode(JSON.stringify(header)));
  const payloadB64 = base64url(encoder.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(opts.apiKeySecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(signingInput)));
  return `${signingInput}.${base64url(signature)}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}
