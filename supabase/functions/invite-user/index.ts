// Edge Function: invite-user
// Lets an existing (allowlisted) teammate add a new person by email.
// Adds them to the `allowlist` table and sends them Supabase's built-in
// invite email. Uses the service_role key, which must NEVER be exposed
// to the frontend - that's the whole reason this runs as a server function.

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

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    if (!token) {
      return json({ error: "Not signed in." }, 401);
    }

    // Client scoped to the caller's own token - used only to find out who's calling.
    const callerClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller?.email) {
      return json({ error: "Could not verify who you are." }, 401);
    }

    // Admin client - the only place the service_role key is ever used.
    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    const { data: callerAllowed } = await admin
      .from("allowlist")
      .select("email")
      .eq("email", caller.email)
      .maybeSingle();
    if (!callerAllowed) {
      return json({ error: "You're not authorized to invite people." }, 403);
    }

    const { email } = await req.json();
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return json({ error: "Enter a valid email address." }, 400);
    }
    const normalizedEmail = email.trim().toLowerCase();

    const { error: insertErr } = await admin
      .from("allowlist")
      .upsert({ email: normalizedEmail, invited_by: caller.email }, { onConflict: "email" });
    if (insertErr) {
      return json({ error: insertErr.message }, 500);
    }

    const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(normalizedEmail);
    // If they already have an account, inviteUserByEmail errors - that's fine,
    // they're allowlisted now and can just sign in with Google directly.
    if (inviteErr && !/already been registered|already exists/i.test(inviteErr.message)) {
      return json({ error: inviteErr.message }, 500);
    }

    return json({ ok: true, email: normalizedEmail });
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
