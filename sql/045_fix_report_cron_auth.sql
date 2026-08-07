-- Mr Priceless CRM - fix generate-client-reports-daily silently 401ing
-- Discovered while building sync-client-ads-daily (sql/044): the Edge
-- Functions gateway requires a valid Authorization header on every request
-- regardless of a function's own auth logic. The original cron job (sql/011)
-- only sent x-cron-secret, so it never actually reached generate-client-reports
-- at all - it's been failing at the gateway with "Missing authorization
-- header" since the day it was scheduled. Re-scheduling with an Authorization
-- header added (the anon/publishable key - not secret, already public in
-- js/config.js) fixes it going forward.
-- Run after 044. Safe to re-run.

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
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'report_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
