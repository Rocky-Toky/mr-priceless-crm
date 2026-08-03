-- Mr Priceless CRM - link ad creatives to a campaign, so a campaign's
-- Ad Spend and CPL can be rolled up from the real Meta-pulled numbers on
-- its linked creatives instead of being typed in by hand.
-- Run after 027. Safe to re-run.

alter table client_ad_creatives add column if not exists campaign_id uuid references client_campaigns(id) on delete set null;
