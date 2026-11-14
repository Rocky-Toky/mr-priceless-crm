-- Mr Priceless CRM - Stripe: who's paid, who's overdue, whose payment failed.
-- The sync-stripe Edge Function copies Stripe customers, subscriptions,
-- invoices and one-off payments in every 15 minutes (read-only key, repo
-- secret STRIPE_API_KEY). The CRM matches each Stripe customer to a client by
-- email / name, or by hand (stripe_customers.client_id). Safe to re-run.

create table if not exists stripe_customers (
  id text primary key,                 -- Stripe customer id (cus_...)
  email text,
  name text,
  client_id uuid,                      -- set by hand in the CRM when the automatic match is wrong / missing
  created_at timestamptz,
  synced_at timestamptz not null default now()
);

create table if not exists stripe_subscriptions (
  id text primary key,                 -- sub_...
  customer_id text,
  status text,                         -- active, past_due, unpaid, canceled, incomplete, trialing ...
  amount numeric,                      -- per period, in dollars
  currency text,
  interval text,                       -- month, week, year
  current_period_end timestamptz,
  cancel_at_period_end boolean,
  created_at timestamptz,
  synced_at timestamptz not null default now()
);

create table if not exists stripe_payments (
  id text primary key,                 -- in_... (invoice) or pi_... (one-off payment)
  kind text not null,                  -- invoice / one_off
  customer_id text,
  customer_email text,
  customer_name text,
  subscription_id text,
  status text,                         -- paid, open, failed, void, uncollectible, refunded, processing
  amount numeric,                      -- in dollars
  currency text,
  description text,
  created_at timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  attempt_count int,
  next_attempt_at timestamptz,
  failure text,                        -- Stripe's reason, e.g. "Your card has insufficient funds."
  url text,                            -- the hosted invoice page (when there is one)
  synced_at timestamptz not null default now()
);
alter table stripe_payments add column if not exists fee numeric;       -- Stripe's fee (dollars)
alter table stripe_payments add column if not exists net numeric;       -- what lands in the bank after the fee
alter table stripe_payments add column if not exists refunded numeric;  -- amount refunded so far
alter table stripe_payments add column if not exists method text;       -- e.g. "Visa 4242"

create table if not exists stripe_payouts (
  id text primary key,                 -- po_...
  amount numeric,
  currency text,
  status text,                         -- paid, pending, in_transit, failed, canceled
  arrival_at timestamptz,
  created_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists stripe_payments_created_idx on stripe_payments (created_at desc);
create index if not exists stripe_payments_customer_idx on stripe_payments (customer_id);

create table if not exists stripe_sync_status (
  id int primary key default 1 check (id = 1),
  connected boolean not null default false,
  cursor_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
insert into stripe_sync_status (id) values (1) on conflict (id) do nothing;

-- Team only, like every other table (billing isn't for Lead Follow Up or client logins).
do $$
declare t text; p record;
begin
  foreach t in array array['stripe_customers', 'stripe_subscriptions', 'stripe_payments', 'stripe_payouts', 'stripe_sync_status'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy "team only" on public.%I for all using (public.is_allowlisted()) with check (public.is_allowlisted())', t);
  end loop;
end $$;

insert into app_secrets (name, value)
values ('stripe_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('sync-stripe')
where exists (select 1 from cron.job where jobname = 'sync-stripe');

select cron.schedule(
  'sync-stripe',
  '3,18,33,48 * * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/sync-stripe',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'stripe_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);

do $$ begin
  if exists (select 1 from pg_proc where proname = 'portal_lock_tables') then perform public.portal_lock_tables(); end if;
end $$;

select (select connected from stripe_sync_status where id = 1) as stripe_connected,
       (select count(*) from stripe_payments) as stripe_payments;
