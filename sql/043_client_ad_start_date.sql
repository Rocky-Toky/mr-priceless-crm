-- Mr Priceless CRM - track when a client's ads actually start running, so
-- the team knows when to invoice them (surfaced via the "Add the date we
-- start running their ads to Clients" onboarding step).
-- Run after 042. Safe to re-run.

alter table clients add column if not exists ad_start_date date;
