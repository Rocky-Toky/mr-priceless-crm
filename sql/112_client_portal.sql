-- Mr Priceless CRM - the client portal (portal/). Clients sign in to their
-- own small app to see their leads (with what they put on the form), their
-- ads and their account with us, and to call their leads fast.
--
-- Security, in three layers:
--   1. Client logins live in client_portal_users, never in the allowlist, so
--      is_allowlisted() / is_lead_caller() and every Edge Function's
--      allowlist check refuse them.
--   2. They get no table access at all. Everything they see comes through
--      the portal_* functions below, which only ever return their own
--      client's rows and only the columns meant for them (no notes, margin,
--      churn risk, who on our team called, GHL details, ...).
--   3. A restrictive "no client logins" rule on every table (and storage),
--      so even an old or forgotten permissive rule can't let them in.
-- Their leads, pipeline, alerts and the 24-hour check-in are in sql/113.
-- Runs after every other migration (after 100, then 113) on each deploy, so
-- tables added later get rule 3 too. Safe to re-run.

-- ───────── Client logins ─────────
create table if not exists client_portal_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  client_id uuid not null references clients(id) on delete cascade,
  name text,
  notify_new_leads boolean not null default true,
  phone text,
  created_by text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
-- Their mobile, for a text when an alert can't reach the app (sql/113).
alter table client_portal_users add column if not exists phone text;
create unique index if not exists client_portal_users_email_client on client_portal_users (lower(email), client_id);
create index if not exists client_portal_users_client on client_portal_users (client_id);
do $$
declare p record;
begin
  alter table public.client_portal_users enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'client_portal_users' loop
    execute format('drop policy %I on public.client_portal_users', p.policyname);
  end loop;
  -- The team sees and removes logins; new ones are made by the client-portal function.
  create policy "team only" on public.client_portal_users for all
    using (public.is_allowlisted()) with check (public.is_allowlisted());
end $$;

-- Who calls a client's leads: false = our team (Lead Follow Up, as before),
-- true = the client calls them, and we follow up any they haven't spoken to
-- within 24 hours. Each lead remembers which it was when it came in.
alter table clients add column if not exists lead_client_calls boolean not null default false;
alter table client_leads add column if not exists client_calls boolean not null default false;
alter table client_leads add column if not exists client_seen_at timestamptz;
alter table client_leads add column if not exists client_dialled_at timestamptz;

-- ───────── Who's asking ─────────
create or replace function public.is_portal_user()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.users u
    join public.client_portal_users p on lower(p.email) = lower(u.email)
    where u.id = auth.uid()
  ) and not public.is_allowlisted() and not public.is_lead_caller();
$$;
revoke all on function public.is_portal_user() from public;
grant execute on function public.is_portal_user() to authenticated, anon;

-- The client a portal call is about: a client login gets their own (the one
-- asked for if they have more than one), the team can look at any client
-- (preview), anyone else gets nothing.
create or replace function public.portal_client_for(p_client uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, auth
as $$
declare cid uuid;
begin
  if auth.uid() is null then return null; end if;
  if public.is_allowlisted() then return p_client; end if;
  select p.client_id into cid
  from auth.users u
  join public.client_portal_users p on lower(p.email) = lower(u.email)
  where u.id = auth.uid() and u.email_confirmed_at is not null
    and (p_client is null or p.client_id = p_client)
  order by p.created_at
  limit 1;
  return cid;
end $$;
revoke all on function public.portal_client_for(uuid) from public;
-- ───────── What the portal reads ─────────
-- The client's account: plain words only. "At Risk" is shown as Live, and
-- nothing internal (notes, margin, churn risk, billing) leaves the database.
create or replace function public.portal_me(p_client uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  cid uuid := public.portal_client_for(p_client);
  c record;
  team boolean := public.is_allowlisted();
  owner text;
  lastrep timestamptz;
  me_name text;
  me_notify boolean;
  me_phone text;
begin
  if cid is null and not team then raise exception 'Not allowed'; end if;
  if cid is null and team then
    select id into cid from clients where coalesce(stage, '') not in ('churned', 'archived') order by name limit 1;
  end if;
  select * into c from clients where id = cid;
  if not found then raise exception 'Not allowed'; end if;
  owner := coalesce(c.onboarding_progress ->> 'owner', '');
  select max(created_at) into lastrep from client_reports where client_id = cid and coalesce(metrics ->> 'kind', '') = 'mtd';
  if not team then
    update client_portal_users p set last_seen_at = now()
    from auth.users u where u.id = auth.uid() and lower(p.email) = lower(u.email) and p.client_id = cid;
    select p.name, p.notify_new_leads, p.phone into me_name, me_notify, me_phone
    from client_portal_users p join auth.users u on lower(p.email) = lower(u.email)
    where u.id = auth.uid() and p.client_id = cid limit 1;
  end if;
  return jsonb_build_object(
    'viewer', case when team then 'team' else 'client' end,
    'email', (select email from auth.users where id = auth.uid()),
    'name', me_name,
    'notify_new_leads', coalesce(me_notify, false),
    'phone', me_phone,
    'push_key', (select value::jsonb ->> 'publicKey' from app_secrets where name = 'push_vapid'),
    'clients', case when team then
        (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.name), '[]'::jsonb)
         from clients x where coalesce(x.stage, '') not in ('churned', 'archived'))
      else
        (select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'name', x.name) order by x.name), '[]'::jsonb)
         from clients x where x.id in (select p.client_id from client_portal_users p join auth.users u on lower(p.email) = lower(u.email) where u.id = auth.uid()))
      end,
    'client', jsonb_build_object(
      'id', c.id,
      'name', c.name,
      'stage', case coalesce(c.stage, '') when 'onboarding' then 'onboarding' when 'quote_guarantee' then 'quote_guarantee' when 'churned' then 'finished' when 'archived' then 'finished' else 'live' end,
      'quote_target', case when c.stage = 'quote_guarantee' then c.quote_target end,
      'quotes_sent', case when c.stage = 'quote_guarantee' then c.quotes_sent end,
      'since', coalesce(c.onboarding_progress ->> 'signed_at', c.created_at::text),
      'ads_since', c.ad_start_date,
      'monthly_ad_spend', c.monthly_ad_spend,
      'services', c.services,
      'website', c.website,
      'region', c.lead_region,
      'area', c.lead_area,
      'client_calls', c.lead_client_calls,
      'manager', case when owner = 'max' then 'max' else 'rocky' end,
      -- Their account manager's name and email, from the Team page (employees).
      'manager_name', (select e.name from employees e where e.person_key = case when owner = 'max' then 'max' else 'rocky' end limit 1),
      'manager_email', (select e.email from employees e where e.person_key = case when owner = 'max' then 'max' else 'rocky' end limit 1),
      'report_anchor', c.report_anchor,
      'last_report_at', coalesce(lastrep, c.last_report_sent_at)
    )
  );
end $$;

-- Their ads: what's running, what it's cost and the leads it's brought in
-- (Meta's all-time numbers from the daily sync). Our own win/kill calls and
-- notes stay out.
create or replace function public.portal_ads(p_client uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare cid uuid := public.portal_client_for(p_client);
begin
  if cid is null then raise exception 'Not allowed'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id', a.id,
      'name', a.name,
      'campaign', cp.name,
      'status', coalesce(a.delivery_status, cp.status),
      'image', a.image_url,
      'media', a.media_type,
      'spend', a.spend,
      'results', a.results,
      'cost_per_result', a.cost_per_result,
      'impressions', a.impressions,
      'clicks', a.clicks,
      'updated_at', a.insights_updated_at,
      'leads_90d', (select count(*) from client_leads l where l.client_id = cid
                      and coalesce(l.lead_created_at, l.created_at) > now() - interval '90 days'
                      and ((a.meta_ad_id is not null and l.ad_info ->> 'ad_id' = a.meta_ad_id)
                        or (l.ad_info ->> 'ad' is not null and lower(l.ad_info ->> 'ad') = lower(a.name))))
    ) order by coalesce(a.spend, 0) desc, a.created_at desc), '[]'::jsonb)
    from client_ad_creatives a
    left join client_campaigns cp on cp.id = a.campaign_id
    where a.client_id = cid
  );
end $$;
create or replace function public.portal_set_notify(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if not public.is_portal_user() then raise exception 'Not allowed'; end if;
  update client_portal_users p set notify_new_leads = coalesce(p_on, true)
  from auth.users u where u.id = auth.uid() and lower(p.email) = lower(u.email);
  return jsonb_build_object('ok', true);
end $$;

do $$
declare f text;
begin
  foreach f in array array['portal_me(uuid)', 'portal_ads(uuid)', 'portal_set_notify(boolean)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
-- ───────── New leads: remember who calls them (their pipeline, alerts and
-- the 24-hour check-in are in sql/113) ─────────
create or replace function public.client_leads_set_client_calls()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.client_calls := coalesce((select lead_client_calls from clients where id = new.client_id), false);
  return new;
end $$;
drop trigger if exists client_leads_client_calls on client_leads;
create trigger client_leads_client_calls before insert on client_leads
  for each row execute function public.client_leads_set_client_calls();

-- ───────── No client logins anywhere else ─────────
-- A restrictive rule is ANDed with every other rule on the table, so a client
-- login is refused on every table and in storage whatever else is there.
-- The portal_* functions above run as the owner and aren't affected.
-- sql/113 calls this again at its end, so its own tables are covered too.
create or replace function public.portal_lock_tables()
returns integer
language plpgsql
set search_path = public
as $$
declare t record;
begin
  -- A table with row level security off lets anyone signed in read it. Turn
  -- it on with a rule that keeps things exactly as they were for everyone
  -- except client logins (should be none, but this makes sure).
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
  loop
    raise notice 'Row level security was off on %, turning it on (no change for the team)', t.relname;
    execute format('alter table public.%I enable row level security', t.relname);
    execute format('drop policy if exists "everyone but client logins" on public.%I', t.relname);
    execute format('create policy "everyone but client logins" on public.%I for all using (not (select public.is_portal_user())) with check (not (select public.is_portal_user()))', t.relname);
  end loop;
  for t in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity
  loop
    execute format('drop policy if exists "no client logins" on public.%I', t.relname);
    execute format('create policy "no client logins" on public.%I as restrictive for all to authenticated using (not (select public.is_portal_user())) with check (not (select public.is_portal_user()))', t.relname);
  end loop;
  if to_regclass('storage.objects') is not null then
    begin
      drop policy if exists "no client logins" on storage.objects;
      create policy "no client logins" on storage.objects as restrictive for all to authenticated
        using (not (select public.is_portal_user())) with check (not (select public.is_portal_user()));
    exception when insufficient_privilege then raise notice 'storage.objects: no permission to add the client rule';
    end;
  end if;
  return (select count(*)::int from pg_policies where schemaname = 'public' and policyname = 'no client logins');
end $$;
revoke all on function public.portal_lock_tables() from public;

-- For the deploy log: how many tables now refuse client logins.
select public.portal_lock_tables() as tables_closed_to_client_logins;
