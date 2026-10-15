-- Mr Priceless CRM - emails that send themselves (receipts / tax invoices).
-- The CRM builds the PDF and saves a row here with the time to send it; the
-- send-scheduled-emails Edge Function runs every 5 minutes, emails anything
-- that's due through Resend, and marks it sent. Run after 061. Safe to re-run.

create table if not exists scheduled_emails (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'receipt',
  client_id uuid,
  record_id text,
  to_email text not null,
  cc_email text,
  subject text not null default '',
  body text not null default '',
  attachment_name text,
  attachment_b64 text,
  send_at timestamptz not null default now(),
  status text not null default 'scheduled', -- scheduled, sending, sent, failed, cancelled
  sent_at timestamptz,
  error text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists scheduled_emails_due_idx on scheduled_emails (status, send_at);

alter table scheduled_emails enable row level security;
drop policy if exists "allowlisted full access" on scheduled_emails;
create policy "allowlisted full access" on scheduled_emails
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

-- A random secret only the database and the function can see, so only the
-- schedule below can ask the function to send what's due. No policies =
-- the browser can't read it.
create table if not exists app_secrets (name text primary key, value text not null);
alter table app_secrets enable row level security;
insert into app_secrets (name, value)
values ('email_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('send-scheduled-emails')
where exists (select 1 from cron.job where jobname = 'send-scheduled-emails');

select cron.schedule(
  'send-scheduled-emails',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/send-scheduled-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'email_cron_secret')
    ),
    body := '{}'::jsonb
  )
  where exists (select 1 from public.scheduled_emails where status = 'scheduled' and send_at <= now());
  $$
);
