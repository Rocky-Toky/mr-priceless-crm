-- Mr Priceless CRM - Lead Follow Up: make sure new and changed leads (and
-- Carmen's follow-ups) are sent to open CRMs straight away, so a new lead
-- pops up without a refresh. Adds client_leads and lead_tasks to Supabase's
-- live-updates publication if they aren't in it already. Run after 109.
-- Safe to re-run.

do $$
declare t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then return; end if;
  foreach t in array array['client_leads', 'lead_tasks'] loop
    if to_regclass('public.' || t) is not null and not exists (
      select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

select tablename as live_updates_on from pg_publication_tables
where pubname = 'supabase_realtime' and tablename in ('client_leads', 'lead_tasks') order by 1;
