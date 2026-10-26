-- Mr Priceless CRM - Employees. One row per person on the team, with their
-- onboarding/offboarding checklist, 1:1s and leave kept on the row (jsonb),
-- so there's one place to look. Pay, contract and emergency contact live in
-- employee_private, which only Rocky and Max can read or change - the
-- database enforces that, not just the page.
-- Run after 076. Safe to re-run.

create table if not exists employees (
  id uuid primary key default gen_random_uuid(),
  person_key text unique,              -- the CRM's name for them on deals/tasks (rocky, max, gabriel...)
  name text not null,
  role text,
  team text not null default 'sales',  -- sales, delivery, both
  email text,
  phone text,
  status text not null default 'active', -- onboarding, active, on_leave, left
  employment_type text,                -- full_time, part_time, contractor, commission_only
  start_date date,
  end_date date,
  manager text,                        -- person_key of who they report to
  location text,
  targets jsonb not null default '{}'::jsonb,   -- { dials_per_day, meetings_per_week, ... }
  onboarding jsonb not null default '{}'::jsonb, -- checklist ticks { key: "2026-10-26" }
  checkins jsonb not null default '[]'::jsonb,   -- 1:1 notes [{ id, date, by, wins, blockers, actions }]
  leave jsonb not null default '[]'::jsonb,      -- [{ id, type, from, to, note }]
  next_checkin date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists employee_private (
  employee_id uuid primary key references employees(id) on delete cascade,
  pay_rate numeric,
  pay_unit text,                       -- hour, week, year
  commission_pct numeric,
  contract_url text,
  emergency_name text,
  emergency_phone text,
  private_notes text,
  updated_at timestamptz not null default now()
);

-- Who counts as a manager for the private details.
create or replace function public.is_employee_manager()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select public.is_allowlisted() and exists (
    select 1 from auth.users u
    where u.id = auth.uid()
      and lower(u.email) in ('rockyoneill02@gmail.com', 'rocky.oneill@mrpriceless.com', 'maximus.smith@mrpriceless.com')
  );
$$;
revoke all on function public.is_employee_manager() from public;
grant execute on function public.is_employee_manager() to authenticated, anon;

do $$
declare p record;
begin
  alter table public.employees enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'employees' loop
    execute format('drop policy %I on public.employees', p.policyname);
  end loop;
  create policy "team only" on public.employees for all
    using (public.is_allowlisted()) with check (public.is_allowlisted());

  alter table public.employee_private enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'employee_private' loop
    execute format('drop policy %I on public.employee_private', p.policyname);
  end loop;
  -- Names is_allowlisted() outright as well: sql/066's safety net keeps only
  -- policies whose text mentions it.
  create policy "managers only" on public.employee_private for all
    using (public.is_allowlisted() and public.is_employee_manager())
    with check (public.is_allowlisted() and public.is_employee_manager());
end $$;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'employees') then
    alter publication supabase_realtime add table employees;
  end if;
end $$;
