-- Mr Priceless CRM - client portal calendar connections. A client login can
-- connect their Google Calendar or Outlook (one click, OAuth, done by the
-- client-portal function). The app then shows their calendar and free times
-- when they book a site visit or a call, and puts those bookings in their
-- calendar. Run after 113. Safe to re-run.

-- One connection per portal login. Server only: holds the refresh token.
create table if not exists portal_calendars (
  email text primary key,              -- the portal login (lower case)
  provider text not null,              -- google | microsoft
  account_email text,                  -- the calendar account they signed in with
  refresh_token text,
  access_token text,
  expires_at timestamptz,
  error text,                          -- set when the connection stops working (they reconnect)
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- The one-off "state" for each Connect press (10 minutes), so the sign-in
-- that comes back is the one we started. Server only.
create table if not exists portal_calendar_states (
  state text primary key,
  email text not null,
  provider text not null,
  created_at timestamptz not null default now()
);
do $$
declare t text; p record;
begin
  foreach t in array array['portal_calendars', 'portal_calendar_states'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t and policyname <> 'no client logins' loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- The event a booking made in the client's own calendar ({ provider, id, at }),
-- so moving the booking moves the event instead of adding another.
alter table client_leads add column if not exists calendar_event jsonb;

delete from portal_calendar_states where created_at < now() - interval '1 day';

select public.portal_lock_tables() as tables_closed_to_client_logins;
