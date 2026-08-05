-- Mr Priceless CRM - manual monthly ad spend per client.
--
-- There's no clean per-month figure coming through the Meta sync (ad
-- creative spend is a lifetime cumulative number), so this is a simple
-- manually-set field, same pattern as cost_per_lead. Defaults every
-- existing client to $1,250/mo as the current real-world baseline.
--
-- Run after 034. Safe to re-run.

alter table clients add column if not exists monthly_ad_spend numeric;

update clients set monthly_ad_spend = 1250 where monthly_ad_spend is null;
