-- Adds Pay Per Lead as a valid deals.contract_type, alongside the existing
-- retainer / profit_share / revenue_share (see 024_deal_contract_type.sql).
alter table deals drop constraint if exists deals_contract_type_check;
alter table deals add constraint deals_contract_type_check
  check (contract_type in ('retainer','profit_share','revenue_share','ppl'));
