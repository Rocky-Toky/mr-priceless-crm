-- Mr Priceless CRM - Lead Follow Up. Every lead that comes through for a
-- client gets a call from our caller (Carmen). New leads arrive in
-- client_leads by themselves: the sync-ghl-leads Edge Function checks each
-- client's GoHighLevel every 5 minutes. These columns track the calling:
-- where each lead is up to, every attempt, and when to try again.
-- Run after 077. Safe to re-run.

alter table client_leads add column if not exists follow_status text;
alter table client_leads add column if not exists attempts integer not null default 0;
alter table client_leads add column if not exists first_called_at timestamptz;
alter table client_leads add column if not exists last_attempt_at timestamptz;
alter table client_leads add column if not exists next_attempt_at timestamptz;
alter table client_leads add column if not exists booked_for timestamptz;
alter table client_leads add column if not exists follow_notes text;
alter table client_leads add column if not exists called_by text;
alter table client_leads add column if not exists call_log jsonb not null default '[]'::jsonb;
alter table client_leads add column if not exists source text;

-- Leads already in the CRM from before this: only the last two days go in
-- the queue, so Carmen doesn't start on a backlog of old CSV imports.
update client_leads
set follow_status = case when coalesce(lead_created_at, created_at) > now() - interval '2 days' then 'new' else 'old' end
where follow_status is null;
alter table client_leads alter column follow_status set default 'new';

create index if not exists client_leads_follow_idx on client_leads (follow_status, next_attempt_at);
create index if not exists client_leads_external_idx on client_leads (client_id, external_lead_id);

-- Only the schedule below can ask the function to pull new leads.
insert into app_secrets (name, value)
values ('leads_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('sync-ghl-leads')
where exists (select 1 from cron.job where jobname = 'sync-ghl-leads');

select cron.schedule(
  'sync-ghl-leads',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/sync-ghl-leads',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'leads_cron_secret')
    ),
    body := '{}'::jsonb
  )
  where exists (select 1 from public.client_ghl);
  $$
);
