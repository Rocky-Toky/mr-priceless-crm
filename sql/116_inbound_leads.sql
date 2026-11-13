-- Mr Priceless CRM - Inbound leads: Mr Priceless's own enquiries from its
-- Facebook / Instagram lead forms (the ones in Meta's Leads Center). The
-- sync-meta-leads Edge Function copies them in every 5 minutes from the
-- Facebook page(s) picked on the Sales → Inbound leads page. Safe to re-run.

create table if not exists inbound_leads (
  id uuid primary key default gen_random_uuid(),
  meta_lead_id text unique,          -- Meta's lead id (null for leads added by hand)
  created_at timestamptz not null default now(),   -- when they filled in the form
  page_id text,
  form_id text,
  form_name text,
  ad_id text,
  ad_name text,
  campaign_name text,
  name text,
  phone text,
  email text,
  business text,
  answers jsonb not null default '[]'::jsonb,      -- every form answer: [{ q, a }]
  status text not null default 'new',              -- new, contacted, booked, not_a_fit, lost
  notes text,
  updated_at timestamptz not null default now(),
  updated_by text,
  synced_at timestamptz
);
create index if not exists inbound_leads_created_idx on inbound_leads (created_at desc);

-- Which Facebook page(s) the leads come from, and how the last sync went.
create table if not exists inbound_settings (
  id int primary key default 1 check (id = 1),
  page_ids text[] not null default '{}',
  pages jsonb not null default '[]'::jsonb,        -- the pages the token can see: [{ id, name }]
  cursor_at timestamptz,
  last_ok_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);
insert into inbound_settings (id) values (1) on conflict (id) do nothing;

-- Team only, like every other table.
do $$
declare t text; p record;
begin
  foreach t in array array['inbound_leads', 'inbound_settings'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy "team only" on public.%I for all using (public.is_allowlisted()) with check (public.is_allowlisted())', t);
  end loop;
end $$;

-- New leads show up live on the page.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'inbound_leads') then
    execute 'alter publication supabase_realtime add table public.inbound_leads';
  end if;
end $$;

-- Only the schedule below can ask the function to sync.
insert into app_secrets (name, value)
values ('inbound_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

select cron.unschedule('sync-meta-leads')
where exists (select 1 from cron.job where jobname = 'sync-meta-leads');

select cron.schedule(
  'sync-meta-leads',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/sync-meta-leads',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'inbound_cron_secret')
    ),
    body := '{}'::jsonb
  )
  where exists (select 1 from public.inbound_settings where id = 1 and cardinality(page_ids) > 0);
  $$
);

-- The client portal lock (sql/112) covers new tables too.
do $$ begin
  if exists (select 1 from pg_proc where proname = 'portal_lock_tables') then perform public.portal_lock_tables(); end if;
end $$;

select (select count(*) from inbound_leads) as inbound_leads, (select cardinality(page_ids) from inbound_settings where id = 1) as pages_picked;
