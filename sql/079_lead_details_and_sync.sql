-- Mr Priceless CRM - lead details and sync health. Each lead now carries
-- where they are and what they picked on the form (pulled from the GHL
-- contact), and lead_sync_status records, per client, when their leads were
-- last pulled and whether anything went wrong - so a client that isn't
-- sending leads shows up instead of quietly going missing.
-- Run after 078. Safe to re-run.

alter table client_leads add column if not exists address text;
alter table client_leads add column if not exists city text;
alter table client_leads add column if not exists answers jsonb not null default '[]'::jsonb;
alter table client_leads add column if not exists ghl_contact_id text;
alter table client_leads add column if not exists details_at timestamptz;
create index if not exists client_leads_contact_idx on client_leads (client_id, ghl_contact_id);

create table if not exists lead_sync_status (
  client_id uuid primary key references clients(id) on delete cascade,
  last_sync_at timestamptz,
  last_ok_at timestamptz,
  error text,
  contacts_access boolean,
  leads_added integer not null default 0,
  last_lead_at timestamptz
);

do $$
declare p record;
begin
  alter table public.lead_sync_status enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'lead_sync_status' loop
    execute format('drop policy %I on public.lead_sync_status', p.policyname);
  end loop;
  -- The team can see it; only the sync function (service key) writes it.
  create policy "team can see sync status" on public.lead_sync_status for select using (public.is_allowlisted());
end $$;
