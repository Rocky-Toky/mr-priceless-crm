-- Mr Priceless CRM - pre-call nurture, phase 2: reschedule, cancel,
-- confirmations, and watching Google Calendar. Every 5 minutes the
-- precall-meetings Edge Function looks at each upcoming meeting's invite:
-- the prospect accepting confirms the meeting; the prospect declining, or
-- the event being moved or deleted in Google, is flagged on the meeting
-- (calendar_flag) and emailed to the setter - nothing is changed by itself.
-- Run after 082. Safe to re-run.

alter table meetings add column if not exists cancel_reason text;
alter table meetings add column if not exists cancelled_at timestamptz;
alter table meetings add column if not exists cancelled_by text;
alter table meetings add column if not exists confirmed_at timestamptz;
alter table meetings add column if not exists prospect_response text;          -- needsAction | accepted | declined | tentative
alter table meetings add column if not exists calendar_flag text;              -- moved | deleted | declined
alter table meetings add column if not exists calendar_flag_detail jsonb not null default '{}'::jsonb;
alter table meetings add column if not exists calendar_checked_at timestamptz;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('precall-watch')
where exists (select 1 from cron.job where jobname = 'precall-watch');

select cron.schedule(
  'precall-watch',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/precall-meetings',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'precall_cron_secret')
    ),
    body := '{"action":"poll"}'::jsonb
  )
  where exists (
    select 1 from public.meetings
    where status = 'scheduled' and google_event_id is not null
      and starts_at > now() - interval '2 hours'
  );
  $$
);
