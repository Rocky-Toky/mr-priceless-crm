-- Mr Priceless CRM - Rubios Pro is an ad hoc client (Rocky, 27 Nov 2026): no
-- monthly invoice, so no "invoice due" / "no invoice date" reminders on Today.
-- Sets onboarding_progress.billing.adhoc = true once. Safe to re-run: only
-- while billing has no adhoc setting yet, so unticking it in the CRM sticks.

update clients
set onboarding_progress = jsonb_set(coalesce(onboarding_progress, '{}'::jsonb), '{billing}',
      coalesce(onboarding_progress->'billing', '{}'::jsonb) || '{"adhoc": true}'::jsonb)
where id = '2ab7f562-6d4b-49ab-aaed-272c17b3d5f9' -- Rubios Pro
  and not (coalesce(onboarding_progress->'billing', '{}'::jsonb) ? 'adhoc');

select count(*) as adhoc_clients from clients where (onboarding_progress->'billing'->>'adhoc')::boolean;
