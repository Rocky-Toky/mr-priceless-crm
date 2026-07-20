-- Mr Priceless CRM - Campaign-level CPL tracking + multi-contact deals
-- Run after 007. Safe to re-run.

create table if not exists client_campaigns (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  platform text,
  status text not null default 'active', -- active | paused | ended
  cost_per_lead numeric,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists deal_contacts (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null references deals(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  role text,
  created_at timestamptz not null default now()
);

create index if not exists client_campaigns_client_id_idx on client_campaigns(client_id);
create index if not exists deal_contacts_deal_id_idx on deal_contacts(deal_id);

alter table client_campaigns enable row level security;
alter table deal_contacts enable row level security;

drop policy if exists "allowlisted full access" on client_campaigns;
create policy "allowlisted full access" on client_campaigns
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

drop policy if exists "allowlisted full access" on deal_contacts;
create policy "allowlisted full access" on deal_contacts
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table client_campaigns;
alter publication supabase_realtime add table deal_contacts;
