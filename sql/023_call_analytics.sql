-- Mr Priceless CRM - shared daily call/meeting activity per person, for
-- team analytics on the Meetings Booked page.
-- Run after 022. Safe to re-run.

create table if not exists call_activity (
  id uuid primary key default gen_random_uuid(),
  person text not null check (person in ('rocky','max')),
  activity_date date not null,
  calls integer not null default 0,
  conversations integer not null default 0,
  meetings_booked integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(person, activity_date)
);
create index if not exists call_activity_date_idx on call_activity(activity_date);

alter table call_activity enable row level security;
drop policy if exists "allowlisted full access" on call_activity;
create policy "allowlisted full access" on call_activity
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table call_activity;

-- Which cold-calling playbook each person used in a given month, so
-- conversion performance can be tracked against which script was in use.
create table if not exists playbook_usage (
  id uuid primary key default gen_random_uuid(),
  person text not null check (person in ('rocky','max')),
  month text not null, -- 'YYYY-MM'
  playbook_id uuid references playbooks(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(person, month)
);

alter table playbook_usage enable row level security;
drop policy if exists "allowlisted full access" on playbook_usage;
create policy "allowlisted full access" on playbook_usage
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table playbook_usage;
