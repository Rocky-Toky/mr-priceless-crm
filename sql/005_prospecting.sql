-- Mr Priceless CRM — prospecting-by-region tracking
-- Run after 004. Safe to re-run.

create table if not exists prospecting_regions (
  id uuid primary key default gen_random_uuid(),
  region text not null,
  calls_made integer not null default 0,
  meetings_booked integer not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table prospecting_regions enable row level security;

drop policy if exists "allowlisted full access" on prospecting_regions;
create policy "allowlisted full access" on prospecting_regions
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table prospecting_regions;
