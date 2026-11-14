// Edge Function: sync-stripe
// Copies Stripe customers, subscriptions, invoices and one-off payments into
// stripe_customers / stripe_subscriptions / stripe_payments (sql/118), so the
// CRM can show who's paid, who's overdue and whose payment failed.
//
//   Scheduled (sql/118 pg_cron, every 15 minutes): header x-cron-secret
//     matches app_secrets.stripe_cron_secret.
//   Signed-in full-access team member: { action: "sync" } runs it now.
//
// Needs the STRIPE_API_KEY function secret (a read-only restricted key, set
// from the repo secret by the deploy workflow). Without it: connected = false.
// Each run re-reads the last 3 days of invoices / payments (statuses change);
// the first run catches up on 180 days. Logs carry counts only.

import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });

const STRIPE = "https://api.stripe.com/v1";
// Pinned so the fields read below (payment_intent.invoice, invoice.subscription,
// subscription.current_period_end) stay where they are whatever the account default is.
const STRIPE_VERSION = "2024-06-20";
const FIRST_RUN_MS = 180 * 86400e3;
const OVERLAP_MS = 3 * 86400e3;
const RUN_BUDGET_MS = 110e3;

async function stripeList(path: string, params: Record<string, string>, key: string, started: number, max = 50) {
  const out: any[] = [];
  let after = "";
  for (let i = 0; i < max; i++) {
    if (Date.now() - started > RUN_BUDGET_MS) return { rows: out, complete: false };
    const q = new URLSearchParams({ limit: "100", ...params, ...(after ? { starting_after: after } : {}) });
    const res = await fetch(`${STRIPE}/${path}?${q}`, { headers: { Authorization: `Bearer ${key}`, "Stripe-Version": STRIPE_VERSION } });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(plainStripeError(body?.error, res.status));
    const data = Array.isArray(body?.data) ? body.data : [];
    out.push(...data);
    if (!body?.has_more || !data.length) return { rows: out, complete: true };
    after = data[data.length - 1].id;
  }
  return { rows: out, complete: false };
}
export function plainStripeError(e: any, status: number) {
  if (status === 401) return "Stripe didn't accept the key - check STRIPE_API_KEY (see the setup steps).";
  if (status === 403) return "The Stripe key is missing a permission - it needs Read on Customers, Subscriptions, Invoices, PaymentIntents, Charges, Balance and Payouts.";
  return String(e?.message || `Stripe returned ${status}`).slice(0, 200);
}

const money = (cents: unknown, currency?: string) => {
  const n = Number(cents);
  if (!Number.isFinite(n)) return null;
  return ["jpy", "krw"].includes(String(currency || "").toLowerCase()) ? n : n / 100;
};
const iso = (unix: unknown) => (typeof unix === "number" && unix > 0 ? new Date(unix * 1000).toISOString() : null);

// Stripe's fee, what lands in the bank and any refund, from the charge behind a payment.
export function chargeMoney(ch: any, currency?: string) {
  if (!ch || typeof ch !== "object") return { fee: null, net: null, refunded: null, method: null };
  const bt = typeof ch.balance_transaction === "object" ? ch.balance_transaction : null;
  // The balance transaction is in the account's own currency; only use it when it matches.
  const same = bt && String(bt.currency || "").toLowerCase() === String(currency || ch.currency || "").toLowerCase();
  const pm = ch.payment_method_details || {};
  const method = pm.card ? `${pm.card.brand ? pm.card.brand[0].toUpperCase() + pm.card.brand.slice(1) : "Card"} ${pm.card.last4 || ""}`.trim() : pm.type || null;
  return {
    fee: same ? money(bt.fee, bt.currency) : null,
    net: same ? money(bt.net, bt.currency) : null,
    refunded: Number(ch.amount_refunded) > 0 ? money(ch.amount_refunded, ch.currency) : 0,
    method,
  };
}
export function payoutRow(p: any) {
  return { id: String(p.id), amount: money(p.amount, p.currency), currency: p.currency || null, status: p.status || null,
    arrival_at: iso(p.arrival_date), created_at: iso(p.created), synced_at: new Date().toISOString() };
}
export function customerRow(c: any) {
  return { id: String(c.id), email: c.email || null, name: c.name || c.description || null, created_at: iso(c.created), synced_at: new Date().toISOString() };
}
export function subscriptionRow(s: any) {
  const item = s.items?.data?.[0];
  const price = item?.price || item?.plan || {};
  const per = (Number(price.unit_amount ?? price.amount) || 0) * (Number(item?.quantity) || 1);
  return {
    id: String(s.id), customer_id: typeof s.customer === "string" ? s.customer : s.customer?.id || null,
    status: s.status || null, amount: money(per, s.currency), currency: s.currency || null,
    interval: price.recurring?.interval || price.interval || null,
    current_period_end: iso(s.current_period_end ?? item?.current_period_end), cancel_at_period_end: !!s.cancel_at_period_end,
    created_at: iso(s.created), synced_at: new Date().toISOString(),
  };
}
export function invoiceRow(inv: any) {
  const failedAttempt = inv.status === "open" && Number(inv.attempt_count) > 0 && !inv.paid;
  return {
    id: String(inv.id), kind: "invoice",
    customer_id: typeof inv.customer === "string" ? inv.customer : inv.customer?.id || null,
    customer_email: inv.customer_email || null, customer_name: inv.customer_name || null,
    subscription_id: typeof inv.subscription === "string" ? inv.subscription : inv.subscription?.id || inv.parent?.subscription_details?.subscription || null,
    status: inv.status === "paid" ? "paid" : failedAttempt ? "failed" : inv.status || null,
    amount: money(inv.status === "paid" ? inv.amount_paid : inv.amount_due, inv.currency), currency: inv.currency || null,
    description: inv.lines?.data?.[0]?.description || inv.description || null,
    created_at: iso(inv.created), due_at: iso(inv.due_date) || (inv.status === "open" ? iso(inv.created) : null),
    paid_at: iso(inv.status_transitions?.paid_at), attempt_count: Number(inv.attempt_count) || 0,
    next_attempt_at: iso(inv.next_payment_attempt), failure: inv.last_finalization_error?.message || null,
    url: inv.hosted_invoice_url || null, synced_at: new Date().toISOString(),
    ...refundStatus(chargeMoney(inv.charge, inv.currency), inv.status === "paid" ? money(inv.amount_paid, inv.currency) : null),
  };
}
function refundStatus(m: ReturnType<typeof chargeMoney>, paid: number | null) {
  const out: Record<string, unknown> = { fee: m.fee, net: m.net, refunded: m.refunded, method: m.method };
  if (paid != null && m.refunded && m.refunded >= paid) out.status = "refunded";
  return out;
}
export function paymentIntentRow(pi: any) {
  const st = pi.status === "succeeded" ? "paid" : pi.status === "processing" ? "processing" : pi.status === "canceled" ? "void"
    : pi.last_payment_error ? "failed" : "open";
  return {
    id: String(pi.id), kind: "one_off",
    customer_id: typeof pi.customer === "string" ? pi.customer : pi.customer?.id || null,
    customer_email: pi.receipt_email || pi.last_payment_error?.payment_method?.billing_details?.email || null,
    customer_name: pi.last_payment_error?.payment_method?.billing_details?.name || null,
    subscription_id: null, status: st, amount: money(pi.amount, pi.currency), currency: pi.currency || null,
    description: pi.description || null, created_at: iso(pi.created), due_at: null,
    paid_at: pi.status === "succeeded" ? iso(pi.created) : null, attempt_count: null, next_attempt_at: null,
    failure: pi.last_payment_error?.message || null, url: null, synced_at: new Date().toISOString(),
    ...refundStatus(chargeMoney(pi.latest_charge, pi.currency), pi.status === "succeeded" ? money(pi.amount, pi.currency) : null),
  };
}

async function setStatus(admin: any, patch: Record<string, unknown>) {
  await admin.from("stripe_sync_status").upsert({ id: 1, ...patch, updated_at: new Date().toISOString() });
}
async function upsert(admin: any, table: string, rows: any[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from(table).upsert(rows.slice(i, i + 500), { onConflict: "id" });
    if (error) throw new Error(`Couldn't save ${table}: ${error.message}`);
  }
}

export async function syncStripe(admin: any) {
  const key = Deno.env.get("STRIPE_API_KEY");
  if (!key) { await setStatus(admin, { connected: false, last_error: null }); return { connected: false }; }
  const started = Date.now(), runAt = new Date().toISOString();
  const { data: st } = await admin.from("stripe_sync_status").select("cursor_at").eq("id", 1).maybeSingle();
  const since = Math.floor((st?.cursor_at ? new Date(st.cursor_at).getTime() - OVERLAP_MS : Date.now() - FIRST_RUN_MS) / 1000);
  try {
    const customers = await stripeList("customers", {}, key, started, 30);
    await upsert(admin, "stripe_customers", customers.rows.map(customerRow));
    const subs = await stripeList("subscriptions", { status: "all" }, key, started, 30);
    await upsert(admin, "stripe_subscriptions", subs.rows.map(subscriptionRow));
    const invoices = await stripeList("invoices", { "created[gte]": String(since), "expand[]": "data.charge.balance_transaction" }, key, started);
    await upsert(admin, "stripe_payments", invoices.rows.filter((i: any) => i.status !== "draft").map(invoiceRow));
    // One-off payments (payment links without a subscription): payment intents that aren't an invoice's.
    const pis = await stripeList("payment_intents", { "created[gte]": String(since), "expand[]": "data.latest_charge.balance_transaction" }, key, started);
    const oneOff = pis.rows.filter((p: any) => !p.invoice && !(p.description || "").startsWith("Subscription"));
    await upsert(admin, "stripe_payments", oneOff.map(paymentIntentRow));
    // Money paid out to the bank.
    const payouts = await stripeList("payouts", { "created[gte]": String(since) }, key, started, 20);
    await upsert(admin, "stripe_payouts", payouts.rows.map(payoutRow));
    const complete = customers.complete && subs.complete && invoices.complete && pis.complete && payouts.complete;
    await setStatus(admin, { connected: true, ...(complete ? { cursor_at: runAt } : {}), last_ok_at: runAt, last_error: null });
    console.log(`stripe sync: ${customers.rows.length} customers, ${subs.rows.length} subscriptions, ${invoices.rows.length} invoices, ${oneOff.length} one-off payments, ${payouts.rows.length} payouts${complete ? "" : " (more next run)"}`);
    return { connected: true, customers: customers.rows.length, subscriptions: subs.rows.length, invoices: invoices.rows.length, one_off: oneOff.length, payouts: payouts.rows.length, complete };
  } catch (e) {
    const msg = String((e as any)?.message || e).slice(0, 300);
    await setStatus(admin, { connected: true, last_error: msg });
    console.log("stripe sync failed: " + msg);
    return { connected: true, error: msg };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { status: 200, headers: corsHeaders });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const ANON = Deno.env.get("SUPABASE_ANON_KEY");
  if (!SUPABASE_URL || !SERVICE || !ANON) return json({ error: "Server misconfigured." }, 500);
  const admin = createClient(SUPABASE_URL, SERVICE, { auth: { persistSession: false } });

  const cronHeader = req.headers.get("x-cron-secret");
  if (cronHeader) {
    const { data: secret } = await admin.from("app_secrets").select("value").eq("name", "stripe_cron_secret").maybeSingle();
    if (!secret?.value || secret.value !== cronHeader) return json({ error: "Unauthorized." }, 401);
    return json(await syncStripe(admin));
  }
  const authed = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false }, global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData } = await authed.auth.getUser();
  const email = userData?.user?.email;
  if (!email) return json({ error: "Unauthorized." }, 401);
  const { data: allowed } = await admin.from("allowlist").select("email, access").ilike("email", email).maybeSingle();
  if (!allowed || (allowed.access && allowed.access !== "full")) return json({ error: "Unauthorized." }, 401);
  let body: any = {};
  try { body = (await req.json()) ?? {}; } catch { body = {}; }
  if (body.action === "sync") return json(await syncStripe(admin));
  return json({ error: "Unknown action." }, 400);
});
