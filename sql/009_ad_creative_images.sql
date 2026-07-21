-- Mr Priceless CRM - ad creative images
-- Run after 008. Safe to re-run.

alter table client_ad_creatives add column if not exists image_url text;

insert into storage.buckets (id, name, public)
values ('ad-creatives', 'ad-creatives', true)
on conflict (id) do nothing;

drop policy if exists "allowlisted read ad-creatives" on storage.objects;
create policy "allowlisted read ad-creatives" on storage.objects
  for select
  using (bucket_id = 'ad-creatives' and exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

drop policy if exists "allowlisted write ad-creatives" on storage.objects;
create policy "allowlisted write ad-creatives" on storage.objects
  for insert
  with check (bucket_id = 'ad-creatives' and exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

drop policy if exists "allowlisted update ad-creatives" on storage.objects;
create policy "allowlisted update ad-creatives" on storage.objects
  for update
  using (bucket_id = 'ad-creatives' and exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

drop policy if exists "allowlisted delete ad-creatives" on storage.objects;
create policy "allowlisted delete ad-creatives" on storage.objects
  for delete
  using (bucket_id = 'ad-creatives' and exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));
