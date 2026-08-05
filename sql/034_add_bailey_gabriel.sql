-- Mr Priceless CRM - add Bailey and Gabriel as recognised people alongside
-- Rocky and Max, for the two new cold callers Rocky's bringing on.
--
-- call_activity and playbook_usage both check person against a fixed list -
-- drop whatever Postgres auto-named that constraint and recreate it with
-- the two new names included.
--
-- Run after 033. Safe to re-run.

do $$
declare
  con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'call_activity'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%person%'
  loop
    execute format('alter table call_activity drop constraint %I', con.conname);
  end loop;
end $$;
alter table call_activity add constraint call_activity_person_check
  check (person in ('rocky','max','bailey','gabriel'));

do $$
declare
  con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'playbook_usage'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%person%'
  loop
    execute format('alter table playbook_usage drop constraint %I', con.conname);
  end loop;
end $$;
alter table playbook_usage add constraint playbook_usage_person_check
  check (person in ('rocky','max','bailey','gabriel'));
