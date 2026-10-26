-- Mr Priceless CRM - pre-call nurture, phase 3: keeping GoHighLevel up to
-- date. Every booking, reschedule, cancel and confirmation change is pushed
-- to our own GHL sub-account by the precall-meetings Edge Function: the
-- contact is upserted, the meeting's custom fields are set, and exactly one
-- precall-* tag shows where the meeting's at (GHL's workflows send the texts
-- and emails from those). The result is recorded on the meeting so a failed
-- sync shows in the CRM; failures are retried by the 5-minute check.
-- Run after 084. Safe to re-run.

alter table meetings add column if not exists ghl_contact_id text;
alter table meetings add column if not exists ghl_status text;        -- ok | error | skipped (test mode) | off (not set up)
alter table meetings add column if not exists ghl_error text;
alter table meetings add column if not exists ghl_tag text;           -- the precall-* tag it was last given
alter table meetings add column if not exists ghl_synced_at timestamptz;
alter table meetings add column if not exists ghl_attempts integer not null default 0;
alter table contacts add column if not exists ghl_contact_id text;

create index if not exists meetings_ghl_retry_idx on meetings (ghl_status) where ghl_status = 'error';

-- The 5-minute check (first set up in 083) also runs while a GHL sync is
-- waiting to be retried. This replaces 083's schedule on every deploy.
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
    body := '{"action":"poll"}'::jsonb,
    timeout_milliseconds := 60000
  )
  where exists (
    select 1 from public.meetings
    where (status = 'scheduled' and google_event_id is not null and starts_at > now() - interval '2 hours')
       or (ghl_status = 'error' and ghl_attempts < 8)
  );
  $$
);
