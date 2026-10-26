-- Mr Priceless CRM - pre-call nurture, phase 1: booked sales meetings.
-- A setter books a prospect in with a closer from the CRM; the
-- precall-meetings Edge Function puts a 15-minute Google Meet invite on the
-- closer's calendar (plus a private 30-minute buffer straight after) and
-- records the event IDs and Meet link here. Times are stored in UTC and
-- shown in NZ time. meeting_events is each meeting's history (booked,
-- calendar problems, and later reschedules, confirmations and outcomes).
-- precall_settings holds test mode: while it's on, invites only go to our
-- own addresses and anything on the test list. Run after 081. Safe to re-run.

create table if not exists meetings (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid references deals(id) on delete set null,
  contact_id uuid references contacts(id) on delete set null,
  first_name text not null,
  last_name text,
  business_name text,
  email text,
  phone text,                                   -- E.164, e.g. +64211234567
  closer text not null,                         -- person key (max, rocky...)
  closer_email text not null,
  setter text,
  setter_email text,
  starts_at timestamptz not null,
  duration_min integer not null default 15,
  buffer_min integer not null default 30,
  description text,
  status text not null default 'scheduled',     -- scheduled | cancelled | completed
  booked_at timestamptz not null default now(),
  lead_time_hours numeric,
  booking_window text,                          -- same_day | next_day | 2_3_days | 4_days
  google_event_id text,
  buffer_event_id text,
  meet_link text,
  calendar_status text not null default 'pending', -- pending | ok | error
  calendar_error text,
  calendar_synced_at timestamptz,
  invite_to_prospect boolean not null default false,
  test_mode boolean not null default false,
  confirmation_status text not null default 'unconfirmed',
  confirmations jsonb not null default '[]'::jsonb,
  confirmed_today_at timestamptz,
  reschedule_count integer not null default 0,
  outcome text,
  outcome_at timestamptz,
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists meetings_starts_idx on meetings (starts_at);
create index if not exists meetings_closer_idx on meetings (closer, starts_at);
create index if not exists meetings_deal_idx on meetings (deal_id);

create table if not exists meeting_events (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references meetings(id) on delete cascade,
  kind text not null,                           -- booked | calendar_error | ...
  detail jsonb not null default '{}'::jsonb,
  by text,
  at timestamptz not null default now()
);
create index if not exists meeting_events_meeting_idx on meeting_events (meeting_id, at);

create table if not exists precall_settings (
  id integer primary key default 1 check (id = 1),
  test_mode boolean not null default true,
  test_allowlist text not null default '',      -- extra emails / phones, comma separated
  updated_by text,
  updated_at timestamptz not null default now()
);
insert into precall_settings (id) values (1) on conflict (id) do nothing;

-- Only the schedule (from phase 2) and the deploy workflow's calendar check
-- can call the function without a signed-in user.
insert into app_secrets (name, value)
values ('precall_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

do $$
declare t text; p record;
begin
  foreach t in array array['meetings', 'meeting_events', 'precall_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy "team only" on public.%I for all using (public.is_allowlisted()) with check (public.is_allowlisted())', t);
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
