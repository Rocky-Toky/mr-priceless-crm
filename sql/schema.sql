-- Mr Priceless CRM — database schema
-- Run this once in your Supabase project's SQL Editor (Dashboard → SQL Editor → New query → Run)

create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  company text,
  email text,
  phone text,
  status text not null default 'lead',        -- lead, active, client, inactive
  tags text,
  created_at timestamptz not null default now(),
  created_by text
);

create table if not exists cold_calls (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references contacts(id) on delete set null,
  contact_name text not null,                 -- kept even if contact is later deleted
  phone text,
  call_date date not null default current_date,
  outcome text not null default 'no_answer',  -- no_answer, call_back, not_interested, interested, booked_meeting
  follow_up_date date,
  notes text,
  created_at timestamptz not null default now(),
  created_by text
);

create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references contacts(id) on delete set null,
  contact_name text,
  title text not null,
  value numeric not null default 0,
  stage text not null default 'new',          -- new, contacted, proposal, negotiation, won, lost
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text
);

create table if not exists notes (
  id uuid primary key default gen_random_uuid(),
  title text,
  body text not null,
  contact_id uuid references contacts(id) on delete set null,
  deal_id uuid references deals(id) on delete set null,
  created_at timestamptz not null default now(),
  created_by text
);

-- Row Level Security: any signed-in user (i.e. you and your partner) can read/write everything.
-- This is intentionally simple — a two-person shared CRM, not a multi-tenant product.
alter table contacts enable row level security;
alter table cold_calls enable row level security;
alter table deals enable row level security;
alter table notes enable row level security;

create policy "authenticated full access" on contacts
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated full access" on cold_calls
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated full access" on deals
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
create policy "authenticated full access" on notes
  for all using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- Realtime: let the app subscribe to live changes so you both see updates instantly.
alter publication supabase_realtime add table contacts;
alter publication supabase_realtime add table cold_calls;
alter publication supabase_realtime add table deals;
alter publication supabase_realtime add table notes;
