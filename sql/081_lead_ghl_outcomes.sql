-- Mr Priceless CRM - call outcomes go back into GoHighLevel. When Carmen
-- books a site visit or consultation call, or the lead's not a fit / not
-- interested / wrong number / never answers, the lead's opportunity moves to
-- the matching stage in that client's pipeline (and bookings go in their
-- calendar). lead_stage_map holds each client's choice of stage and
-- calendar for each outcome; blank means "match it by name". ghl_sync on
-- the lead records what happened in GHL. Run after 080. Safe to re-run.

alter table client_leads add column if not exists ghl_sync jsonb not null default '{}'::jsonb;

create table if not exists lead_stage_map (
  client_id uuid primary key references clients(id) on delete cascade,
  site_visit_stage text,
  consult_stage text,
  disqualified_stage text,
  no_answer_stage text,
  site_visit_calendar text,
  consult_calendar text,
  updated_at timestamptz not null default now()
);

do $$
declare p record;
begin
  alter table public.lead_stage_map enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'lead_stage_map' loop
    execute format('drop policy %I on public.lead_stage_map', p.policyname);
  end loop;
  create policy "team only" on public.lead_stage_map for all
    using (public.is_allowlisted()) with check (public.is_allowlisted());
end $$;
