-- Mr Priceless CRM - Plastering leads: quote requests from the Priceless
-- Plastering & Painting website (clients/priceless-plastering in the
-- mr-priceless-website repo). The site's /api/quote calls
-- submit_plastering_lead() with the public anon key; the team works the
-- leads on the "Plastering leads" page. Run after 113 (and calls
-- portal_lock_tables() again at the end). Safe to re-run.

create table if not exists plastering_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  phone text not null,
  email text,
  suburb text,
  service text,
  timing text,
  message text,
  source text,              -- the page on the website the form was on
  status text not null default 'new',  -- new, contacted, quoted, won, lost
  notes text,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists plastering_leads_created_idx on plastering_leads (created_at desc);

-- Team only, like every other table. The website never reads this table.
do $$
declare p record;
begin
  alter table public.plastering_leads enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'plastering_leads' loop
    execute format('drop policy %I on public.plastering_leads', p.policyname);
  end loop;
  create policy "team only" on public.plastering_leads for all
    using (public.is_allowlisted()) with check (public.is_allowlisted());
end $$;

-- How the website adds a lead. Runs as the table owner, so the website (anon
-- key) can add a lead but can't read, change or delete any. Checks every
-- field, keeps lengths sane, ignores the same phone number sent again within
-- 10 minutes (double taps), and stops after 30 leads in an hour so a bot
-- can't flood the CRM.
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
  v_id uuid;
begin
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
  insert into plastering_leads (name, phone, email, suburb, service, timing, message, source)
  values (v_name, v_phone, v_email, v_suburb, v_service, v_timing, v_message, v_source)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id);
end $$;

revoke all on function public.submit_plastering_lead(jsonb) from public;
grant execute on function public.submit_plastering_lead(jsonb) to anon, authenticated;

-- Live updates, so a new lead shows straight away on an open CRM.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'plastering_leads') then
    alter publication supabase_realtime add table public.plastering_leads;
  end if;
end $$;

-- Keep client portal logins out of the new table too (sql/112).
do $$
begin
  if exists (select 1 from pg_proc where proname = 'portal_lock_tables') then
    perform public.portal_lock_tables();
  end if;
end $$;

select count(*) as plastering_leads from plastering_leads;
