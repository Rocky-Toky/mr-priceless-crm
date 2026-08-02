-- Mr Priceless CRM - contract type (retainer / profit share / revenue share)
-- and percentage for deals. Run after 023. Safe to re-run.

alter table deals add column if not exists contract_type text not null default 'retainer';
alter table deals drop constraint if exists deals_contract_type_check;
alter table deals add constraint deals_contract_type_check
  check (contract_type in ('retainer','profit_share','revenue_share'));

alter table deals add column if not exists percentage numeric;
