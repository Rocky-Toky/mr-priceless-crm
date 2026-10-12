-- Mr Priceless CRM - each client's industry (Creative Library > Statistics
-- groups results by it), and whether an ad's performer tag was set by hand
-- (the automatic "over $50 a lead goes to Low" rule leaves those alone).
-- Run after 057. Safe to re-run.

alter table clients add column if not exists industry text;
alter table client_ad_creatives add column if not exists result_manual boolean not null default false;
