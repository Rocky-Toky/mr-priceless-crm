-- Mr Priceless CRM - Lead Follow Up: Recorded calls. Every Aircall call
-- (in and out) is copied here by the sync-aircall-calls Edge Function every
-- 5 minutes, matched to the lead or client by phone number. The recording
-- itself stays in Aircall: the page asks the function for a fresh link when
-- someone presses Play (Aircall's links only last a few minutes).
-- Needs the repo secrets AIRCALL_API_ID and AIRCALL_API_TOKEN; until they're
-- set, the function does nothing. Run after 091. Safe to re-run.

create table if not exists aircall_calls (
  id bigint primary key,              -- Aircall's call id
  direction text,                     -- inbound / outbound
  status text,                        -- answered / missed / voicemail / done
  number text,                        -- the other person's number (E.164)
  line text,                          -- which of our Aircall numbers
  user_name text,                     -- who took or made it
  user_email text,
  started_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration integer,                   -- seconds
  recorded boolean not null default false,
  voicemail boolean not null default false,
  lead_id uuid references client_leads(id) on delete set null,
  client_id uuid references clients(id) on delete set null,
  synced_at timestamptz not null default now()
);
create index if not exists aircall_calls_started_idx on aircall_calls (started_at desc);
create index if not exists aircall_calls_lead_idx on aircall_calls (lead_id);

-- How the sync is going (one row): the page uses it to say whether Aircall
-- is connected.
create table if not exists aircall_sync_status (
  id integer primary key default 1,
  connected boolean not null default false,
  cursor_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

do $$
declare p record; t text;
begin
  foreach t in array array['aircall_calls', 'aircall_sync_status'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy "team only" on public.%I for all using (public.is_allowlisted()) with check (public.is_allowlisted())', t);
  end loop;
end $$;

-- Live updates, so a new recording shows without a refresh.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'aircall_calls') then
    alter publication supabase_realtime add table public.aircall_calls;
  end if;
end $$;

-- Only the schedule below can ask the function to sync.
insert into app_secrets (name, value)
values ('aircall_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('sync-aircall-calls')
where exists (select 1 from cron.job where jobname = 'sync-aircall-calls');

select cron.schedule(
  'sync-aircall-calls',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/sync-aircall-calls',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'aircall_cron_secret')
    ),
    body := '{}'::jsonb
  );
  $$
);
