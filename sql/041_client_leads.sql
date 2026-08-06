-- Mr Priceless CRM - Meta Lead Center import (manual CSV, since Meta has no
-- API for the Intake/Qualified/DQ'd status set inside Leads Center itself).
-- Run after 040. Safe to re-run.

create table if not exists client_leads (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  external_lead_id text not null default '',
  name text not null default '',
  email text not null default '',
  phone text not null default '',
  status text not null default '',
  form_name text not null default '',
  lead_created_at timestamptz,
  imported_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists client_leads_client_id_idx on client_leads(client_id);

alter table client_leads enable row level security;

drop policy if exists "allowlisted full access" on client_leads;
create policy "allowlisted full access" on client_leads
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table client_leads;
