-- Mr Priceless CRM - security tidy-up. Run after 065. Safe to re-run.
--
-- What this makes true:
--  * Only people on the allowlist, whose email address is CONFIRMED, can read
--    or change anything. (A brand new account that hasn't proved it owns the
--    email gets nothing, even if it uses a teammate's address.)
--  * Every table has row level security on, with one "team only" rule.
--  * Old looser rules are removed: "authenticated full access" from the very
--    first schema, and "own rows or unowned legacy rows" on tasks, which let
--    any signed-in account see unassigned tasks.
--  * Server-only tables (GHL keys, app secrets) have no browser access at all.

-- 1. The one check every rule uses.
create or replace function public.is_allowlisted()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.users u
    join public.allowlist a on lower(a.email) = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
  );
$$;
revoke all on function public.is_allowlisted() from public;
grant execute on function public.is_allowlisted() to authenticated, anon;

-- 2. Shared team tables: drop whatever rules they had, add one "team only" rule.
do $$
declare
  t text;
  p record;
  team_tables text[] := array[
    'contacts', 'cold_calls', 'deals', 'notes', 'prospecting_regions', 'dial_prospects',
    'clients', 'client_content', 'client_ad_creatives', 'client_campaigns', 'deal_contacts',
    'tasks', 'client_reports', 'playbooks', 'rules', 'email_templates', 'expenses',
    'call_activity', 'playbook_usage', 'creative_weekly_snapshots', 'team_focus',
    'client_leads', 'completed_verticals', 'jarvis_memory', 'scheduled_emails'
  ];
begin
  foreach t in array team_tables loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    execute format('create policy "team only" on public.%I for all using (public.is_allowlisted()) with check (public.is_allowlisted())', t);
  end loop;
end $$;

-- 3. Per-person tables: your own rows, and only while you're on the team.
do $$
declare p record;
begin
  if to_regclass('public.user_widget_state') is not null then
    alter table public.user_widget_state enable row level security;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'user_widget_state' loop
      execute format('drop policy %I on public.user_widget_state', p.policyname);
    end loop;
    create policy "own rows, team only" on public.user_widget_state for all
      using (user_id = auth.uid() and public.is_allowlisted())
      with check (user_id = auth.uid() and public.is_allowlisted());
  end if;
  if to_regclass('public.meeting_reviews') is not null then
    alter table public.meeting_reviews enable row level security;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'meeting_reviews' loop
      execute format('drop policy %I on public.meeting_reviews', p.policyname);
    end loop;
    create policy "own rows, team only" on public.meeting_reviews for all
      using (user_id = auth.uid() and public.is_allowlisted())
      with check (user_id = auth.uid() and public.is_allowlisted());
  end if;
  if to_regclass('public.jarvis_messages') is not null then
    alter table public.jarvis_messages enable row level security;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'jarvis_messages' loop
      execute format('drop policy %I on public.jarvis_messages', p.policyname);
    end loop;
    create policy "own messages, team only" on public.jarvis_messages for all
      using (user_email = auth.jwt() ->> 'email' and public.is_allowlisted())
      with check (user_email = auth.jwt() ->> 'email' and public.is_allowlisted());
  end if;
  -- Google tokens: save and update your own, never read back from the browser.
  if to_regclass('public.google_tokens') is not null then
    alter table public.google_tokens enable row level security;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'google_tokens' loop
      execute format('drop policy %I on public.google_tokens', p.policyname);
    end loop;
    create policy "store own token, team only" on public.google_tokens for insert
      with check (auth.uid() = user_id and public.is_allowlisted());
    create policy "update own token, team only" on public.google_tokens for update
      using (auth.uid() = user_id and public.is_allowlisted())
      with check (auth.uid() = user_id and public.is_allowlisted());
  end if;
end $$;

-- 4. The allowlist itself: the team can see who's on it. Nobody can add,
--    change or remove rows from the browser - that's the invite function's job.
do $$
declare p record;
begin
  alter table public.allowlist enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'allowlist' loop
    execute format('drop policy %I on public.allowlist', p.policyname);
  end loop;
  create policy "team can see the team" on public.allowlist for select using (public.is_allowlisted());
end $$;

-- 5. Server-only tables: row level security on, no rules, so only the
--    server functions (which use the service key) can touch them.
do $$
declare
  t text;
  p record;
begin
  foreach t in array array['client_ghl', 'app_secrets', 'crm_migrations'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
  end loop;
end $$;

-- 6. Safety net for anything else in the database: switch row level security
--    on, and drop any rule that doesn't check the team (e.g. a "read access
--    for all users" rule added by hand), replacing it with "team only".
do $$
declare
  r record;
  p record;
  known text[] := array[
    'contacts', 'cold_calls', 'deals', 'notes', 'prospecting_regions', 'dial_prospects',
    'clients', 'client_content', 'client_ad_creatives', 'client_campaigns', 'deal_contacts',
    'tasks', 'client_reports', 'playbooks', 'rules', 'email_templates', 'expenses',
    'call_activity', 'playbook_usage', 'creative_weekly_snapshots', 'team_focus',
    'client_leads', 'completed_verticals', 'jarvis_memory', 'scheduled_emails',
    'user_widget_state', 'meeting_reviews', 'jarvis_messages', 'google_tokens', 'allowlist',
    'client_ghl', 'app_secrets', 'crm_migrations'
  ];
begin
  for r in select c.relname as t from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relkind = 'r' and not (c.relname = any(known)) loop
    execute format('alter table public.%I enable row level security', r.t);
    for p in select policyname, coalesce(qual, '') || coalesce(with_check, '') as expr from pg_policies
             where schemaname = 'public' and tablename = r.t loop
      if p.expr not ilike '%is_allowlisted%' then
        execute format('drop policy %I on public.%I', p.policyname, r.t);
      end if;
    end loop;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.t) then
      execute format('create policy "team only" on public.%I for all using (public.is_allowlisted()) with check (public.is_allowlisted())', r.t);
    end if;
  end loop;
end $$;

-- 7. Ad creative pictures: only the team can upload, change or delete them.
--    (The bucket stays public-read so the pictures load in the app and PDFs.)
drop policy if exists "allowlisted read ad-creatives" on storage.objects;
drop policy if exists "allowlisted write ad-creatives" on storage.objects;
drop policy if exists "allowlisted update ad-creatives" on storage.objects;
drop policy if exists "allowlisted delete ad-creatives" on storage.objects;
drop policy if exists "team read ad-creatives" on storage.objects;
drop policy if exists "team write ad-creatives" on storage.objects;
drop policy if exists "team update ad-creatives" on storage.objects;
drop policy if exists "team delete ad-creatives" on storage.objects;
create policy "team read ad-creatives" on storage.objects for select
  using (bucket_id = 'ad-creatives' and public.is_allowlisted());
create policy "team write ad-creatives" on storage.objects for insert
  with check (bucket_id = 'ad-creatives' and public.is_allowlisted());
create policy "team update ad-creatives" on storage.objects for update
  using (bucket_id = 'ad-creatives' and public.is_allowlisted());
create policy "team delete ad-creatives" on storage.objects for delete
  using (bucket_id = 'ad-creatives' and public.is_allowlisted());

-- 8. Quick check, safe to show in the deploy log (table names only, no data):
--    every public table should say rls = true.
select c.relname as table_name, c.relrowsecurity as rls,
       (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as rules
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;
