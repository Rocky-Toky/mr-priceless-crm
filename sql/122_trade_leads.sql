-- Mr Priceless CRM - Priceless trade leads: one board for every trade business
-- Rocky runs himself (plastering now; roofing, concreting ... to come), and a
-- text to Rocky's mobile the moment a lead comes in (Rocky, 26 Nov 2026).
-- Leads stay in plastering_leads (sql/114) with a `business` key; each website
-- calls submit_plastering_lead (or submit_trade_lead) with p.business.
-- Run after 114. Safe to re-run.

alter table plastering_leads add column if not exists business text not null default 'plastering';
create index if not exists plastering_leads_business_idx on plastering_leads (business, created_at desc);

-- The businesses (name and branding for the board and, later, estimates).
create table if not exists trade_businesses (
  key text primary key,              -- plastering, roofing, concreting ...
  name text not null,                -- shown in the CRM, e.g. "Priceless Plastering"
  legal_name text,
  gst_number text,
  phone text,
  email text,
  website text,
  address text,
  color text,
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);
insert into trade_businesses (key, name, website, sort)
values ('plastering', 'Priceless Plastering', 'pricelessplastering.co.nz', 0)
on conflict (key) do nothing;

-- Where the new-lead texts go (set on the board, never in code).
create table if not exists trade_settings (
  id int primary key default 1 check (id = 1),
  alert_phone text,
  alerts_on boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by text
);
insert into trade_settings (id) values (1) on conflict (id) do nothing;

-- The text queue: the client-portal function sends these (deliver).
create table if not exists trade_alerts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  lead_id uuid,
  to_phone text not null,
  body text not null,
  status text not null default 'pending',  -- pending, sending, sent, failed
  error text,
  sent_at timestamptz
);
create index if not exists trade_alerts_status_idx on trade_alerts (status, created_at);

do $$
declare t text; p record;
begin
  foreach t in array array['trade_businesses', 'trade_settings', 'trade_alerts'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy "team only" on public.%I for all using (public.is_allowlisted()) with check (public.is_allowlisted())', t);
  end loop;
end $$;

-- The websites add a lead here (anon key). Same checks as before, plus which
-- business it's for (unknown or missing = plastering).
create or replace function public.submit_plastering_lead(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text := left(btrim(coalesce(p->>'name', '')), 100);
  v_phone text := left(btrim(coalesce(p->>'phone', '')), 40);
  v_email text := nullif(left(btrim(coalesce(p->>'email', '')), 120), '');
  v_suburb text := nullif(left(btrim(coalesce(p->>'suburb', '')), 80), '');
  v_service text := nullif(left(btrim(coalesce(p->>'service', '')), 80), '');
  v_timing text := nullif(left(btrim(coalesce(p->>'timing', '')), 60), '');
  v_message text := nullif(left(btrim(coalesce(p->>'message', '')), 3000), '');
  v_source text := nullif(left(btrim(coalesce(p->>'source', '')), 120), '');
  v_business text := lower(left(btrim(coalesce(p->>'business', '')), 40));
  v_id uuid;
begin
  if not exists (select 1 from trade_businesses where key = v_business and active) then v_business := 'plastering'; end if;
  if length(v_name) < 2 or length(regexp_replace(v_phone, '\D', '', 'g')) < 7 then
    return jsonb_build_object('ok', false, 'error', 'name and phone are required');
  end if;
  select id into v_id from plastering_leads
   where regexp_replace(phone, '\D', '', 'g') = regexp_replace(v_phone, '\D', '', 'g')
     and created_at > now() - interval '10 minutes'
   limit 1;
  if v_id is not null then
    return jsonb_build_object('ok', true, 'id', v_id, 'duplicate', true);
  end if;
  if (select count(*) from plastering_leads where created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'too many leads this hour');
  end if;
  insert into plastering_leads (name, phone, email, suburb, service, timing, message, source, business)
  values (v_name, v_phone, v_email, v_suburb, v_service, v_timing, v_message, v_source, v_business)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;
create or replace function public.submit_trade_lead(p jsonb)
returns jsonb language sql security definer set search_path = public
as $$ select public.submit_plastering_lead(p) $$;
revoke all on function public.submit_plastering_lead(jsonb) from public;
revoke all on function public.submit_trade_lead(jsonb) from public;
grant execute on function public.submit_plastering_lead(jsonb) to anon, authenticated;
grant execute on function public.submit_trade_lead(jsonb) to anon, authenticated;

-- A new lead queues a text to Rocky's mobile and wakes the sender straight
-- away. Never stops the lead being saved.
create or replace function public.trade_lead_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare s record; b text;
begin
  select alert_phone, alerts_on into s from trade_settings where id = 1;
  if s.alert_phone is null or btrim(s.alert_phone) = '' or not s.alerts_on then return new; end if;
  select name into b from trade_businesses where key = new.business;
  insert into trade_alerts (lead_id, to_phone, body)
  values (new.id, s.alert_phone, left(
    'New ' || coalesce(b, 'Priceless') || ' lead: ' || new.name
    || coalesce(' - ' || new.service, '') || coalesce(' in ' || new.suburb, '')
    || '. Call ' || new.phone || '.'
    || coalesce(' "' || left(new.message, 160) || '"', '')
    || ' Open: https://rocky-toky.github.io/mr-priceless-crm/', 600));
  begin
    if exists (select 1 from pg_proc where proname = 'portal_kick') then perform public.portal_kick(); end if;
  exception when others then null;
  end;
  return new;
exception when others then
  raise notice 'trade_lead_alert: %', sqlerrm;
  return new;
end $$;
drop trigger if exists plastering_leads_alert on plastering_leads;
create trigger plastering_leads_alert after insert on plastering_leads
  for each row execute function public.trade_lead_alert();

do $$
begin
  if exists (select 1 from pg_proc where proname = 'portal_lock_tables') then perform public.portal_lock_tables(); end if;
end $$;

select (select count(*) from trade_businesses) as businesses,
       (select alert_phone is not null from trade_settings where id = 1) as alert_phone_set,
       (select count(*) from trade_alerts where status = 'failed') as alerts_failed;
