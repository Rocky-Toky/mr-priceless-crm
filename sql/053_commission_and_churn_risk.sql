-- Mr Priceless CRM - rep commission tracking + client churn risk.
-- Run after 052. Safe to re-run.

-- Commission per deal: the elevated monthly amount a rep gets paid for the
-- first 6 months, anchored to the date the client's invoice is first due
-- (invoices recur monthly, at the end of each month, from that date). After
-- 6 months the rate steps down to the flat steady rate (see
-- COMMISSION_STEADY_RATE in js/app.js) - that part isn't stored per deal
-- since it's the same for everyone, only the elevated rate and the anchor
-- date vary deal to deal.
alter table deals add column if not exists commission_initial_amount numeric;
alter table deals add column if not exists commission_invoice_date date;

-- Churn risk: a manually-set Low/Medium/High read on how likely a client is
-- to leave - separate from the At Risk/Churned pipeline stage, which only
-- reflects a decision already made to move them there.
alter table clients add column if not exists churn_risk text;
alter table clients drop constraint if exists clients_churn_risk_check;
alter table clients add constraint clients_churn_risk_check
  check (churn_risk is null or churn_risk in ('low','medium','high'));
