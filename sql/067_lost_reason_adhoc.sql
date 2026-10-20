-- Mr Priceless CRM - why a deal was lost, and one-off (ad-hoc) deals.
-- Run after 066. Safe to re-run.

-- The reason given when a deal moves to Closed Lost.
alter table deals add column if not exists lost_reason text;

-- Ad-hoc: a one-off job with a single $ value, alongside the others.
alter table deals drop constraint if exists deals_contract_type_check;
alter table deals add constraint deals_contract_type_check
  check (contract_type in ('retainer','profit_share','revenue_share','ppl','adhoc'));
