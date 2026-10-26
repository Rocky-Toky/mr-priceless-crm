-- Mr Priceless CRM - Employees: each person's responsibilities, and the team
-- as it stands now (Rocky, Max and Carmen). Each person gets their own item in
-- the Employees menu, with what they're responsible for.
-- Run after 083. Safe to re-run: the team set-up below only runs once, so
-- anyone added or changed in the CRM afterwards is left alone.

alter table employees add column if not exists responsibilities jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from crm_migrations where key = '084_team_rocky_max_carmen') then
    -- Make sure all three are on the list.
    insert into employees (person_key, name, role, team, email, status, employment_type, manager)
    select 'rocky', 'Rocky', 'Appointment Setting & Running Ads', 'both', 'rocky.oneill@mrpriceless.com', 'active', 'full_time', null
    where not exists (select 1 from employees where person_key = 'rocky');
    insert into employees (person_key, name, role, team, email, status, employment_type, manager)
    select 'max', 'Max', 'Closing & Process Improvement', 'both', 'maximus.smith@mrpriceless.com', 'active', 'full_time', null
    where not exists (select 1 from employees where person_key = 'max');
    insert into employees (person_key, name, role, team, status, manager)
    select 'carmen', 'Carmen', 'Lead Follow Up', 'delivery', 'active', 'rocky'
    where not exists (select 1 from employees where person_key = 'carmen');

    update employees set role = 'Appointment Setting & Running Ads', status = 'active', responsibilities = jsonb_build_array(
      jsonb_build_object('title', 'Appointment Setting', 'detail', 'Booking meetings with tradies who need more work: cold calls, follow-ups, and getting them into the calendar with a closer.'),
      jsonb_build_object('title', 'Running Ads', 'detail', 'Building, launching and looking after every client''s Meta ads so they bring in good leads at a good cost.')
    ) where person_key = 'rocky';
    update employees set role = 'Closing & Process Improvement', status = 'active', responsibilities = jsonb_build_array(
      jsonb_build_object('title', 'Closing', 'detail', 'Running the sales meetings and turning booked appointments into signed clients.'),
      jsonb_build_object('title', 'Process Improvement', 'detail', 'Finding what slows the team down and fixing it: playbooks, systems and the way we work.')
    ) where person_key = 'max';
    update employees set role = 'Lead Follow Up', status = 'active', responsibilities = jsonb_build_array(
      jsonb_build_object('title', 'Lead Follow Up', 'detail', 'Calling every lead that comes through for our clients, on the client''s behalf, and booking site visits or consultation calls.'),
      jsonb_build_object('title', '3-minute response', 'detail', 'Every new enquiry gets a call within 3 minutes. Missed calls are tried again in morning and afternoon waves, 5 calls in all.')
    ) where person_key = 'carmen';

    -- Everyone else moves to Past employees (their history stays).
    update employees set status = 'left', end_date = coalesce(end_date, current_date)
    where coalesce(person_key, '') not in ('rocky', 'max', 'carmen') and status <> 'left';

    insert into crm_migrations (key) values ('084_team_rocky_max_carmen');
  end if;
end $$;
