// Edge Function: voice-twiml
// This is the "Voice Request URL" configured on both the Twilio TwiML App
// (for outbound calls placed from the browser) and the Twilio phone number
// itself (for inbound calls, e.g. a prospect calling back) - not something a
// person visits directly.
//
// IMPORTANT: Twilio's "Direction" param is NOT reliable here - it comes
// through as "inbound" for every call that hits a TwiML App's Voice Request
// URL, including calls a browser places outbound via Device.connect(). The
// real signal is the standard "To" param: for a browser-placed outbound
// call it's whatever number Device.connect({ params: { To } }) sent (the
// prospect's number); for a genuine PSTN call to our own Twilio number it's
// that Twilio number itself. We branch on whether To matches our own number.
//
// Outbound: we respond with TwiML telling Twilio which real phone number to
// dial and which of our numbers to show as the caller ID.
//
// Inbound - a three-stage escalation, tracked via a "stage" query param on
// the action URL we hand Twilio (Twilio always re-POSTs the same params on
// each redirect, so the query string is the only reliable place to stash
// which stage just finished):
//   1. "team"     - ring every allowlisted teammate's browser in parallel
//                   (via Twilio Client - only whoever has the Dialer open
//                   actually rings, Twilio silently skips anyone else).
//   2. "fallback" - if nobody on the team picked up, ring a real fallback
//                   number if one's configured (TWILIO_FALLBACK_NUMBER),
//                   e.g. someone's personal mobile.
//   3. done       - if that also goes unanswered (or isn't configured), log
//                   a task in the CRM so the missed call doesn't just
//                   disappear, and play a short message to the caller.

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
const NO_ONE_AVAILABLE_MESSAGE = "Sorry, nobody is available to take your call right now. We've logged your number and will call you back.";

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

  const to = params.To || "";
  const digits = to.replace(/[^0-9+]/g, "");
  const callerIdDigits = CALLER_ID.replace(/[^0-9+]/g, "");
  // Only a genuine inbound PSTN call has To == our own Twilio number - a
  // browser-placed outbound call's To is always the prospect's number.
  const isGenuineInbound = !!callerIdDigits && digits === callerIdDigits;

  if (isGenuineInbound) {
    return new Response(await inboundTwiml(params, FALLBACK_NUMBER, req.url), {
      headers: { "Content-Type": "text/xml", ...corsHeaders },
    });
  }

  const twiml = digits && CALLER_ID
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Dial callerId="${escapeXml(CALLER_ID)}"><Number>${escapeXml(digits)}</Number></Dial></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Sorry, this call could not be placed. No destination number was provided.</Say></Response>`;

  return new Response(twiml, { headers: { "Content-Type": "text/xml", ...corsHeaders } });
});

async function inboundTwiml(params: Record<string, string>, fallbackNumber: string, requestUrl: string): Promise<string> {
  const url = new URL(requestUrl);
  const stage = url.searchParams.get("stage") || "";

  // Twilio re-POSTs here once whichever <Dial> we sent finishes (answered,
  // timed out, or nobody was reachable) - DialCallStatus only appears on
  // those follow-up requests, never on the very first ring.
  if (params.DialCallStatus) {
    if (params.DialCallStatus === "completed") {
      // Someone answered and the call already ran its course - nothing more to do.
      return `<?xml version="1.0" encoding="UTF-8"?><Response></Response>`;
    }
    if (stage === "team" && fallbackNumber) {
      const actionUrl = new URL(requestUrl);
      actionUrl.search = "stage=fallback";
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="${RING_TIMEOUT_SECONDS}" action="${escapeXml(actionUrl.toString())}"><Number>${escapeXml(fallbackNumber)}</Number></Dial></Response>`;
    }
    // Either the fallback leg also went unanswered, or there was no
    // fallback number to try - either way, nobody actually picked up.
    await logMissedCallTask(params.From || "");
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(NO_ONE_AVAILABLE_MESSAGE)}</Say></Response>`;
  }

  const identities = await allowlistIdentities();
  if (!identities.length) {
    if (fallbackNumber) {
      const actionUrl = new URL(requestUrl);
      actionUrl.search = "stage=fallback";
      return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="${RING_TIMEOUT_SECONDS}" action="${escapeXml(actionUrl.toString())}"><Number>${escapeXml(fallbackNumber)}</Number></Dial></Response>`;
    }
    await logMissedCallTask(params.From || "");
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${escapeXml(NO_ONE_AVAILABLE_MESSAGE)}</Say></Response>`;
  }

  const actionUrl = new URL(requestUrl);
  actionUrl.search = "stage=team";
  const clients = identities.map((id) => `<Client>${escapeXml(id)}</Client>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="${RING_TIMEOUT_SECONDS}" action="${escapeXml(actionUrl.toString())}">${clients}</Dial></Response>`;
}

function adminClient() {
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
}

async function allowlistIdentities(): Promise<string[]> {
  const admin = adminClient();
  const { data } = await admin.from("allowlist").select("email");
  return (data || [])
    .map((row: { email: string }) => row.email.replace(/[^a-zA-Z0-9_.-]/g, "_"))
    .filter(Boolean);
}

// Best-effort caller ID, same idea as the frontend's findCallerLabel - match
// the inbound number against prospects, clients and contacts so the task
// title says who called instead of just a bare digit string.
async function callerLabel(admin: ReturnType<typeof adminClient>, fromNumber: string): Promise<string> {
  const digits = fromNumber.replace(/\D/g, "");
  if (!digits) return fromNumber || "Unknown number";
  const { data: prospects } = await admin.from("dial_prospects").select("name, company, phone");
  const prospect = (prospects || []).find((p: { phone: string }) => (p.phone || "").replace(/\D/g, "") === digits);
  if (prospect) return prospect.company ? `${prospect.name} - ${prospect.company}` : prospect.name;
  const { data: clients } = await admin.from("clients").select("name, phone");
  const client = (clients || []).find((c: { phone: string }) => (c.phone || "").replace(/\D/g, "") === digits);
  if (client) return client.name;
  const { data: contacts } = await admin.from("contacts").select("name, company, phone");
  const contact = (contacts || []).find((c: { phone: string }) => (c.phone || "").replace(/\D/g, "") === digits);
  if (contact) return contact.company ? `${contact.name} - ${contact.company}` : contact.name;
  return fromNumber || "Unknown number";
}

// Nobody picked up anywhere - leave a task behind so a missed callback
// doesn't just vanish. Left unassigned (visible to the whole team) since
// there's no signed-in user in this context to attribute it to.
async function logMissedCallTask(fromNumber: string): Promise<void> {
  if (!fromNumber) return;
  const admin = adminClient();
  const label = await callerLabel(admin, fromNumber);
  await admin.from("tasks").insert({
    title: `${label} reached out - missed call`,
    notes: `Called in on ${fromNumber} and nobody was available to take it. Call them back.`,
    due_date: new Date().toISOString().slice(0, 10),
    priority: "urgent",
    status: "open",
  });
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] || c));
}
