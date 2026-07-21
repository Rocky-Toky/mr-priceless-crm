-- Mr Priceless CRM - Meta Ads client reporting
-- Run after 010. Safe to re-run.

alter table clients add column if not exists meta_ad_account_id text;
alter table clients add column if not exists report_email text;
alter table clients add column if not exists report_frequency text not null default 'monthly'; -- weekly | monthly | off
alter table clients add column if not exists last_report_sent_at timestamptz;

create table if not exists client_reports (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  metrics jsonb not null default '{}',
  status text not null default 'sent', -- sent | failed
  error text,
  created_at timestamptz not null default now()
);

create index if not exists client_reports_client_id_idx on client_reports(client_id);

alter table client_reports enable row level security;

drop policy if exists "allowlisted full access" on client_reports;
create policy "allowlisted full access" on client_reports
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table client_reports;

-- ───────── Scheduled send: check for due reports once a day ─────────
-- The shared secret is stored encrypted in Supabase Vault (not in this file
-- and not in plaintext inside the stored cron job) and looked up at run time.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select vault.create_secret(
  'REPLACE_WITH_REPORT_CRON_SECRET',
  'report_cron_secret',
  'Shared secret so pg_cron can call the generate-client-reports Edge Function.'
)
where not exists (select 1 from vault.secrets where name = 'report_cron_secret');

select cron.unschedule('generate-client-reports-daily')
where exists (select 1 from cron.job where jobname = 'generate-client-reports-daily');

select cron.schedule(
  'generate-client-reports-daily',
  '0 21 * * *', -- 21:00 UTC = 9am NZST / 10am NZDT
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/generate-client-reports',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'report_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
