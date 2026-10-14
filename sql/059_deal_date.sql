-- Mr Priceless CRM - the date a deal is for. The Deals pipeline only shows
-- deals dated in or before the month being viewed, so a deal set for
-- December stays out of the way until December. Older deals without one use
-- the date they were created. Run after 058. Safe to re-run.

alter table deals add column if not exists deal_date date;
