-- Mr Priceless CRM - daily automatic creative sync
-- Schedules sync-client-ads to run once a day for every client with a Meta
-- Ad Account ID set, so creative spend/results flow in automatically instead
-- of needing someone to click Sync per client. Uses the same cron-secret
-- pattern as generate-client-reports-daily (sql/011).
-- Run after 043. Safe to re-run.

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- IMPORTANT: replace 'REPLACE_WITH_CREATIVE_SYNC_CRON_SECRET' below with a
-- real random value BEFORE running this file, then set that same value as
-- the CREATIVE_SYNC_CRON_SECRET secret on the sync-client-ads Edge Function
-- (Dashboard -> Edge Functions -> sync-client-ads -> Secrets).
select vault.create_secret(
  'REPLACE_WITH_CREATIVE_SYNC_CRON_SECRET',
  'creative_sync_cron_secret',
  'Shared secret so pg_cron can call the sync-client-ads Edge Function.'
)
where not exists (select 1 from vault.secrets where name = 'creative_sync_cron_secret');

select cron.unschedule('sync-client-ads-daily')
where exists (select 1 from cron.job where jobname = 'sync-client-ads-daily');

select cron.schedule(
  'sync-client-ads-daily',
  '0 18 * * *', -- 18:00 UTC = 6am NZST / 7am NZDT, well before the working day starts
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/sync-client-ads',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      -- The Edge Functions gateway requires a valid Authorization header on
      -- every request regardless of the function's own auth logic - without
      -- this, pg_cron's call never even reaches the function code and just
      -- 401s at the gateway with "Missing authorization header". The anon
      -- (publishable) key is not secret - it's already public in js/config.js.
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'creative_sync_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
