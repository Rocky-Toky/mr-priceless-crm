-- Mr Priceless CRM - Clients workspace (retention hub)
-- Run after 006. Safe to re-run.

create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  notes text,
  cost_per_lead numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists client_content (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  type text not null default 'video', -- video | script | post | other
  status text not null default 'idea', -- idea | scripting | filming | posted
  title text not null,
  directions text,
  script text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists client_ad_creatives (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id) on delete cascade,
  name text not null,
  result text not null default 'testing', -- testing | winner | killed
  notes text,
  created_at timestamptz not null default now()
);

create index if not exists client_content_client_id_idx on client_content(client_id);
create index if not exists client_ad_creatives_client_id_idx on client_ad_creatives(client_id);

alter table clients enable row level security;
alter table client_content enable row level security;
alter table client_ad_creatives enable row level security;

drop policy if exists "allowlisted full access" on clients;
create policy "allowlisted full access" on clients
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

drop policy if exists "allowlisted full access" on client_content;
create policy "allowlisted full access" on client_content
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

drop policy if exists "allowlisted full access" on client_ad_creatives;
create policy "allowlisted full access" on client_ad_creatives
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table clients;
alter publication supabase_realtime add table client_content;
alter publication supabase_realtime add table client_ad_creatives;
