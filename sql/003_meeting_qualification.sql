-- Mr Priceless CRM — meeting qualification automation
-- Run in the SQL Editor after 001/002. Safe to re-run.

create table if not exists meeting_reviews (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  google_event_id text not null,
  meeting_title text,
  meeting_start timestamptz,
  meeting_end timestamptz,
  external_emails text[] not null default '{}',
  status text not null default 'pending',  -- pending, qualified, disqualified
  deal_id uuid references deals(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (user_id, google_event_id)
);

alter table meeting_reviews enable row level security;

drop policy if exists "users manage own meeting reviews" on meeting_reviews;
create policy "users manage own meeting reviews" on meeting_reviews
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter publication supabase_realtime add table meeting_reviews;

-- ───────── Scheduled scan: call scan-meetings every 10 minutes ─────────
-- The shared secret is stored encrypted in Supabase Vault (not in this file
-- and not in plaintext inside the stored cron job) and looked up at run time.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select vault.create_secret(
  'REPLACE_WITH_CRON_SECRET',
  'scan_meetings_cron_secret',
  'Shared secret so pg_cron can call the scan-meetings Edge Function.'
)
where not exists (select 1 from vault.secrets where name = 'scan_meetings_cron_secret');

select cron.unschedule('scan-meetings-every-10-min')
where exists (select 1 from cron.job where jobname = 'scan-meetings-every-10-min');

select cron.schedule(
  'scan-meetings-every-10-min',
  '*/10 * * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/scan-meetings',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'scan_meetings_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
