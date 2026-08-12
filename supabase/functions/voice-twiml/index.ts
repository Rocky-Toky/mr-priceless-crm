// Edge Function: voice-twiml
// This is the "Voice Request URL" configured on both the Twilio TwiML App
// (for outbound calls placed from the browser) and the Twilio phone number
// itself (for inbound calls, e.g. a prospect calling back). Twilio decides
// which case we're in via the "Direction" param it sends - not something a
// person visits directly.
//
// Outbound: Twilio POSTs the params passed to Device.connect({ params }), and
// we respond with TwiML telling Twilio which real phone number to dial and
// which of our numbers to show as the caller ID.
//
// Inbound: Twilio POSTs the caller's number. We ring every allowlisted
// teammate's browser in parallel (via Twilio Client - only whoever currently
// has the Dialer open actually rings, Twilio silently skips anyone not
// registered) for a short window. If nobody picks up, we fall back to a real
// phone number if one's configured (TWILIO_FALLBACK_NUMBER), otherwise we
// play a short message so the caller isn't just met with silence.

import { createClient } from "jsr:@supabase/supabase-js@2";

// Inlined rather than imported from ../_shared/cors.ts - this function gets
// deployed as a standalone bundle (including via the Supabase dashboard's
// single-file editor), which can't resolve relative imports that reach
// outside the function's own folder.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RING_TIMEOUT_SECONDS = 20;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const CALLER_ID = Deno.env.get("TWILIO_CALLER_ID") || "";
  const FALLBACK_NUMBER = Deno.env.get("TWILIO_FALLBACK_NUMBER") || "";

  const contentType = req.headers.get("content-type") || "";
  let params: Record<string, string> = {};
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    for (const [k, v] of form.entries()) params[k] = String(v);
  } else {
    try { params = await req.json(); } catch { /* no body */ }
  }

  const direction = params.Direction || "";

  if (direction === "inbound") {
    return new Response(await inboundTwiml(params, FALLBACK_NUMBER, req.url), {
      headers: { "Content-Type": "text/xml", ...corsHeaders },
    });
  }

  const to = params.To || "";
  const digits = to.replace(/[^0-9+]/g, "");
  const twiml = digits && CALLER_ID
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${escapeXml(CALLER_ID)}"><Number>${escapeXml(digits)}</Number></Dial></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this call could not be placed. No destination number was provided.</Say></Response>`;

  return new Response(twiml, { headers: { "Content-Type": "text/xml", ...corsHeaders } });
});

async function inboundTwiml(params: Record<string, string>, fallbackNumber: string, requestUrl: string): Promise<string> {
  // Twilio re-POSTs here once the <Dial> below finishes (answered, timed out,
  // or nobody was reachable) because we set action to this same URL. That
  // second pass carries DialCallStatus - the first, initial ring never does.
  if (params.DialCallStatus) {
    if (params.DialCallStatus === "completed") {
      // Someone answered and the call already ran its course - nothing more to do.
      return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
    }
    if (fallbackNumber) {
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Number>${escapeXml(fallbackNumber)}</Number></Dial></Response>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, nobody is available to take your call right now. Please try again during business hours.</Say></Response>`;
  }

  const identities = await allowlistIdentities();
  if (!identities.length) {
    if (fallbackNumber) {
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Number>${escapeXml(fallbackNumber)}</Number></Dial></Response>`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, nobody is available to take your call right now. Please try again during business hours.</Say></Response>`;
  }

  const actionUrl = new URL(requestUrl);
  actionUrl.search = "";
  const clients = identities.map((id) => `<Client>${escapeXml(id)}</Client>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="${RING_TIMEOUT_SECONDS}" action="${escapeXml(actionUrl.toString())}">${clients}</Dial></Response>`;
}

async function allowlistIdentities(): Promise<string[]> {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data } = await admin.from("allowlist").select("email");
  return (data || [])
    .map((row: { email: string }) => row.email.replace(/[^a-zA-Z0-9_.-]/g, "_"))
    .filter(Boolean);
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] || c));
}
