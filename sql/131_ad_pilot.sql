-- Mr Priceless CRM - Ad pilot, stage 1 (Rocky, 28 Nov 2026).
-- Claude looks after every client's Meta ads: once a day (and on demand) the
-- ad-pilot Edge Function reads each ad account through Meta's official
-- Marketing API, Claude suggests changes (pause a losing ad, turn one back on,
-- move a daily budget, flag a problem), and the team approves them in the CRM
-- (Clients -> Ad pilot). Approved changes go straight to Meta. Small, low-risk
-- changes can run by themselves per client once auto is switched on, inside
-- hard limits. Every result and every "not now" note feeds the playbook Claude
-- reads on the next review, so it gets better over time.
-- Team-only. Safe to re-run.

-- What Claude suggested and what happened to it.
create table if not exists ad_actions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  client_id uuid references clients(id) on delete cascade,
  platform text not null default 'meta',
  kind text not null,                 -- pause | resume | budget | flag
  target_type text,                   -- ad | adset | campaign | account
  target_id text,
  target_name text,
  current_value numeric,              -- e.g. today's daily budget (dollars)
  new_value numeric,                  -- e.g. the suggested daily budget (dollars)
  reason text,                        -- why, in plain words
  impact text,                        -- what we expect to happen
  risk text not null default 'high',  -- low | high (only low can run by itself)
  status text not null default 'suggested', -- suggested | applying | applied | failed | dismissed | expired
  auto boolean not null default false,
  decided_by text,
  decided_at timestamptz,
  applied_at timestamptz,
  note text,                          -- the team's reason for "not now"
  error text,
  result jsonb,
  review_id uuid
);
create index if not exists ad_actions_client_idx on ad_actions (client_id, created_at desc);
create index if not exists ad_actions_status_idx on ad_actions (status, created_at desc);

-- One review per client per run: the numbers Claude saw and its summary.
create table if not exists ad_reviews (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  client_id uuid references clients(id) on delete cascade,
  platform text not null default 'meta',
  summary text,
  health text,                        -- good | watch | bad
  stats jsonb,                        -- spend / leads / cpl for 7 and 30 days, ads, ad sets
  model text,
  cost_usd numeric,
  error text
);
create index if not exists ad_reviews_client_idx on ad_reviews (client_id, created_at desc);

-- Per-client rules for the pilot.
create table if not exists ad_pilot_settings (
  client_id uuid primary key references clients(id) on delete cascade,
  auto_on boolean not null default false,     -- let low-risk changes run by themselves
  max_change_pct int not null default 20,     -- biggest budget move in one go (auto and suggested)
  max_daily_budget numeric,                   -- never suggest a daily budget above this (dollars)
  target_cpl numeric,                         -- cost per lead we're aiming for
  monthly_budget numeric,                     -- ad spend per month we agreed with them
  notes text,                                 -- anything Claude should always keep in mind
  updated_at timestamptz not null default now(),
  updated_by text
);

-- What works, written by Claude after reviews and by the team. Read on every review.
create table if not exists ad_playbook (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  platform text not null default 'meta',
  client_id uuid references clients(id) on delete cascade, -- null = applies to every client
  lesson text not null,
  source text not null default 'claude',      -- claude | team
  active boolean not null default true
);

-- Is our Meta connection allowed to change ads (not just read them)?
create table if not exists ad_pilot_status (
  id int primary key default 1 check (id = 1),
  meta_perms text[] not null default '{}',
  meta_can_manage boolean not null default false,
  checked_at timestamptz,
  last_run_at timestamptz,
  last_error text
);
insert into ad_pilot_status (id) values (1) on conflict (id) do nothing;

do $$
declare t text; p record;
begin
  foreach t in array array['ad_actions', 'ad_reviews', 'ad_pilot_settings', 'ad_playbook', 'ad_pilot_status'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy "team only" on public.%I for all using (public.is_allowlisted()) with check (public.is_allowlisted())', t);
  end loop;
end $$;

-- The daily review: a cron secret made once, then six runs from 18:13 to 19:53 UTC
-- (about 7-9am NZ in summer, 6-8am in winter). Each run reviews the clients not
-- reviewed in the last 20 hours that fit in two minutes, so everyone is done by breakfast.
insert into app_secrets (name, value)
select 'adpilot_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '')
where not exists (select 1 from app_secrets where name = 'adpilot_cron_secret');

select cron.unschedule('ad-pilot-review')
where exists (select 1 from cron.job where jobname = 'ad-pilot-review');
select cron.schedule(
  'ad-pilot-review',
  '13,33,53 18,19 * * *',
  $$
  select net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/ad-pilot',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'adpilot_cron_secret')
    ),
    body := '{"action":"review"}'::jsonb,
    timeout_milliseconds := 300000
  );
  $$
);

do $$
begin
  if exists (select 1 from pg_proc where proname = 'portal_lock_tables') then perform public.portal_lock_tables(); end if;
end $$;

select (select count(*) from ad_actions) as actions,
       (select count(*) from ad_reviews) as reviews,
       (select meta_can_manage from ad_pilot_status where id = 1) as meta_can_manage;
