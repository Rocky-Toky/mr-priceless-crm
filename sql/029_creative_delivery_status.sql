-- Mr Priceless CRM - store each ad's real Meta delivery status (active,
-- learning, paused, etc.) so the Creative Library can show which ads are
-- actually running instead of just the manually-set testing/winner/killed
-- tag. Populated by sync-client-ads / creative-insights on every refresh.
-- Run after 028. Safe to re-run.

alter table client_ad_creatives add column if not exists delivery_status text;
