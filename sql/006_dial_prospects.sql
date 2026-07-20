-- Mr Priceless CRM - power dialer prospect list
-- Run after 005. Safe to re-run.

create table if not exists dial_prospects (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  company text,
  email text,
  calls_made integer not null default 0,
  last_called_at timestamptz,
  last_outcome text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table dial_prospects enable row level security;

drop policy if exists "allowlisted full access" on dial_prospects;
create policy "allowlisted full access" on dial_prospects
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table dial_prospects;
