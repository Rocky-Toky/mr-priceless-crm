-- Mr Priceless CRM - client inbox, take two. Each teammate's own Gmail now
-- sends client emails in through a small Apps Script (handed out on the
-- Client inbox page), so there's no Google Cloud project or Google sign-in
-- involved. The 5-minute schedule just sends the 2-hour reminders now, so it
-- only calls in while an email is still waiting. Run after 074. Safe to re-run.

select cron.unschedule('sync-client-inbox')
where exists (select 1 from cron.job where jobname = 'sync-client-inbox');

select cron.schedule(
  'sync-client-inbox',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/sync-client-inbox',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'inbox_cron_secret')
    ),
    body := '{}'::jsonb
  )
  where exists (select 1 from public.client_emails where status = 'new' and reminded_at is null and received_at < now() - interval '2 hours');
  $$
);
