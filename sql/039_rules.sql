-- Mr Priceless CRM - Rules (per-channel process standards, shared with the whole team)
-- Run after 038. Safe to re-run.

create table if not exists rules (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  content text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table rules enable row level security;

drop policy if exists "allowlisted full access" on rules;
create policy "allowlisted full access" on rules
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table rules;

insert into rules (title, sort_order)
select v.title, v.sort_order
from (values ('Meta Ads', 0), ('Google Ads', 1), ('Landing Pages & Websites', 2), ('SEO', 3)) as v(title, sort_order)
where not exists (select 1 from rules r where r.title = v.title);
