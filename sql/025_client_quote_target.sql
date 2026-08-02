-- Mr Priceless CRM - quote target for clients on a "Quote Guarantee" deal,
-- so progress (quotes sent vs target) can be tracked on the Clients pipeline.
-- Run after 024. Safe to re-run.

alter table clients add column if not exists quote_target integer;
