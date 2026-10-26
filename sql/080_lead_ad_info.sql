-- Mr Priceless CRM - which ad a lead came from (campaign, ad set, ad and
-- Facebook form), read from GoHighLevel's attribution, so the caller knows
-- what the person saw before she rings them. Run after 079. Safe to re-run.
alter table client_leads add column if not exists ad_info jsonb not null default '{}'::jsonb;
