-- Mr Priceless CRM - Expense Tracker (shared business costs)
-- Run after 016. Safe to re-run.

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  category text not null default 'other', -- software, ad_spend, contractors, wages, office, other
  amount numeric not null default 0,
  frequency text not null default 'one_off', -- one_off, monthly
  expense_date date not null default current_date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists expenses_expense_date_idx on expenses(expense_date);

alter table expenses enable row level security;

drop policy if exists "allowlisted full access" on expenses;
create policy "allowlisted full access" on expenses
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table expenses;
