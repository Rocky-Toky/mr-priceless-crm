-- Mr Priceless CRM - Lead Engine: mark a region+industry combo as fully
-- worked, so its prospects stop cluttering Prospecting for everyone
-- without actually deleting anything. Ticking a vertical off just adds a
-- row here; Prospecting excludes any prospect whose (region, industry)
-- matches one. Unticking (reactivating) is just deleting the row - the
-- prospects themselves were never touched, so they're straight back in the
-- active pool.
-- Run after 053. Safe to re-run.

create table if not exists completed_verticals (
  id uuid primary key default gen_random_uuid(),
  region text not null,
  industry text not null,
  completed_at timestamptz not null default now(),
  completed_by text,
  unique(region, industry)
);

alter table completed_verticals enable row level security;

drop policy if exists "allowlisted full access" on completed_verticals;
create policy "allowlisted full access" on completed_verticals
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table completed_verticals;
