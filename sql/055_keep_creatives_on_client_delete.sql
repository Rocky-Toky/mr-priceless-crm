-- Mr Priceless CRM - keep ad creatives in the Creative Library when their
-- client is deleted. Instead of cascading the delete, the creative is
-- unlinked (client_id -> null) and keeps the client's name in client_name
-- so the library can still show who it was for.
-- Run after 054. Safe to re-run.

alter table client_ad_creatives add column if not exists client_name text;

-- Backfill the name for every existing creative.
update client_ad_creatives cr
set client_name = cl.name
from clients cl
where cl.id = cr.client_id and cr.client_name is null;

alter table client_ad_creatives alter column client_id drop not null;

alter table client_ad_creatives drop constraint if exists client_ad_creatives_client_id_fkey;
alter table client_ad_creatives
  add constraint client_ad_creatives_client_id_fkey
  foreign key (client_id) references clients(id) on delete set null;
