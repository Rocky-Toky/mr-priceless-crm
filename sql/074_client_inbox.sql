-- Mr Priceless CRM - client inbox. Every 5 minutes the sync-client-inbox Edge
-- Function looks through each teammate's connected Gmail for emails from a
-- client, and saves one row per email here so the CRM can show what's
-- waiting on a reply. A reply sent from Gmail ticks it off by itself.
-- Run after 073. Safe to re-run.

create table if not exists client_emails (
  id uuid primary key default gen_random_uuid(),
  user_id uuid,                 -- whose inbox it came into
  inbox_email text,
  gmail_id text not null,
  thread_id text,
  message_id text,              -- the email's own Message-ID, so a client cc'ing both of us shows once
  client_id uuid,
  client_name text,
  from_email text,
  from_name text,
  subject text not null default '',
  snippet text not null default '',
  received_at timestamptz not null default now(),
  status text not null default 'new', -- new, replied, done
  replied_at timestamptz,
  done_by text,
  reminded_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists client_emails_gmail_idx on client_emails (user_id, gmail_id);
create unique index if not exists client_emails_message_idx on client_emails (message_id) where message_id is not null;
create index if not exists client_emails_status_idx on client_emails (status, received_at);

-- Whose inbox is connected, and whether the last check worked.
create table if not exists inbox_connections (
  user_id uuid primary key,
  email text,
  status text not null default 'ok', -- ok, needs_connect, error
  error text,
  last_sync_at timestamptz
);

do $$
declare p record;
begin
  alter table public.client_emails enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'client_emails' loop
    execute format('drop policy %I on public.client_emails', p.policyname);
  end loop;
  create policy "team only" on public.client_emails for all
    using (public.is_allowlisted()) with check (public.is_allowlisted());

  alter table public.inbox_connections enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'inbox_connections' loop
    execute format('drop policy %I on public.inbox_connections', p.policyname);
  end loop;
  create policy "team can see inboxes" on public.inbox_connections for select using (public.is_allowlisted());
end $$;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'client_emails') then
    alter publication supabase_realtime add table client_emails;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'inbox_connections') then
    alter publication supabase_realtime add table inbox_connections;
  end if;
end $$;

-- Only the schedule below can ask the function to check the inboxes.
insert into app_secrets (name, value)
values ('inbox_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('sync-client-inbox')
where exists (select 1 from cron.job where jobname = 'sync-client-inbox');

select cron.schedule(
  'sync-client-inbox',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/sync-client-inbox',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'inbox_cron_secret')
    ),
    body := '{}'::jsonb
  )
  where exists (select 1 from public.google_tokens);
  $$
);
