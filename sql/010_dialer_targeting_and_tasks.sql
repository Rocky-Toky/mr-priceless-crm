-- Mr Priceless CRM - Dialer region/industry targeting + Tasks
-- Run after 009. Safe to re-run.

alter table dial_prospects add column if not exists region text;
alter table dial_prospects add column if not exists industry text;
alter table dial_prospects add column if not exists converted_at timestamptz;

create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  notes text,
  due_date date,
  priority text not null default 'medium', -- low | medium | high | urgent
  status text not null default 'open', -- open | done
  contact_id uuid references contacts(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tasks_due_date_idx on tasks(due_date);
create index if not exists dial_prospects_region_idx on dial_prospects(region);
create index if not exists dial_prospects_industry_idx on dial_prospects(industry);

alter table tasks enable row level security;

drop policy if exists "allowlisted full access" on tasks;
create policy "allowlisted full access" on tasks
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table tasks;
