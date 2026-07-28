-- Mr Priceless CRM - Playbooks (shared sales scripts / process docs)
-- Run after 013. Safe to re-run.

create table if not exists playbooks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table playbooks enable row level security;

drop policy if exists "allowlisted full access" on playbooks;
create policy "allowlisted full access" on playbooks
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table playbooks;
