// Edge Function: voice-twiml
// This is the "Voice Request URL" configured on the Twilio TwiML App (see
// sql-adjacent setup in README). Twilio calls this the instant someone in the
// CRM places a call from the browser - it's not something a person visits
// directly. Twilio POSTs the params passed to Device.connect({ params }), and
// we respond with TwiML telling Twilio which real phone number to dial and
// which of our numbers to show as the caller ID.

import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const CALLER_ID = Deno.env.get("TWILIO_CALLER_ID") || "";

  let to = "";
  const contentType = req.headers.get("content-type") || "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    to = String(form.get("To") || "");
  } else {
    try {
      const body = await req.json();
      to = body.To || "";
    } catch {
      // no body - fall through to the "no destination" response below
    }
  }

  const digits = to.replace(/[^0-9+]/g, "");
  const twiml = digits && CALLER_ID
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${escapeXml(CALLER_ID)}"><Number>${escapeXml(digits)}</Number></Dial></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this call could not be placed. No destination number was provided.</Say></Response>`;

  return new Response(twiml, { headers: { "Content-Type": "text/xml", ...corsHeaders } });
});

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] || c));
}
