-- Mr Priceless CRM - Live Meta insights on ad creatives
-- Run after 019. Safe to re-run.

alter table client_ad_creatives add column if not exists meta_ad_id text;
alter table client_ad_creatives add column if not exists impressions integer;
alter table client_ad_creatives add column if not exists clicks integer;
alter table client_ad_creatives add column if not exists spend numeric;
alter table client_ad_creatives add column if not exists results integer;
alter table client_ad_creatives add column if not exists cost_per_result numeric;
alter table client_ad_creatives add column if not exists insights_updated_at timestamptz;
