-- Mr Priceless CRM - Team: the details Rocky gave for the team (27 Oct 2026).
-- Carmen started Mon 26 Oct 2026, full-time, reports to Rocky, on the Lead
-- Follow Up team. Rocky and Max started Mr Priceless in 2025, full-time, in
-- Auckland. Runs once, and only fills in what's still blank, so anything
-- changed in the CRM later is left alone. Run after 089. Safe to re-run.

do $$
begin
  if not exists (select 1 from crm_migrations where key = '090_team_details') then
    update employees set
      start_date = coalesce(start_date, date '2026-10-26'),
      employment_type = coalesce(employment_type, 'full_time'),
      manager = coalesce(manager, 'rocky'),
      team = case when team in ('delivery', 'sales') then 'leads' else team end
    where person_key = 'carmen';
    update employees set
      start_date = coalesce(start_date, date '2025-01-01'),
      employment_type = coalesce(employment_type, 'full_time'),
      location = coalesce(nullif(location, ''), 'Auckland')
    where person_key in ('rocky', 'max');
    insert into crm_migrations (key) values ('090_team_details');
  end if;
end $$;
