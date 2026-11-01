-- Mr Priceless CRM - Lead Follow Up: Carmen works 10am - 6pm NZ time, and the
-- Schedule's times are now NZ time. Any schedule saved on the old 5am - 1pm
-- hours (her hours in her own time zone) moves 5 hours later, so it keeps the
-- same shape. Only schedules that sit wholly inside 5am - 1pm and start before
-- 10am are moved. Runs once. Run after 104. Safe to re-run.

do $$
declare
  shift constant interval := interval '5 hours';
begin
  if exists (select 1 from crm_migrations where key = '105_schedule_nz_hours') then return; end if;

  -- { days: { mon: [ { from, to, ... } ] } }
  update employees e set schedule = jsonb_set(e.schedule, '{days}', (
    select coalesce(jsonb_object_agg(d.k, coalesce((
      select jsonb_agg(b || jsonb_build_object(
        'from', to_char(('2000-01-01 ' || (b->>'from'))::timestamp + shift, 'HH24:MI'),
        'to',   to_char(('2000-01-01 ' || (b->>'to'))::timestamp + shift, 'HH24:MI')) order by x.ord)
      from jsonb_array_elements(d.v) with ordinality as x(b, ord)), '[]'::jsonb)), '{}'::jsonb)
    from jsonb_each(e.schedule->'days') as d(k, v) where jsonb_typeof(d.v) = 'array'))
  where jsonb_typeof(e.schedule->'days') = 'object'
    and exists (select 1 from jsonb_each(e.schedule->'days') d, jsonb_array_elements(case when jsonb_typeof(d.value) = 'array' then d.value else '[]' end) b where b->>'from' < '10:00')
    and not exists (select 1 from jsonb_each(e.schedule->'days') d, jsonb_array_elements(case when jsonb_typeof(d.value) = 'array' then d.value else '[]' end) b
                    where coalesce(b->>'from', '') !~ '^\d\d:\d\d$' or coalesce(b->>'to', '') !~ '^\d\d:\d\d$' or b->>'from' < '05:00' or b->>'to' > '13:00');

  -- Older { blocks: [ ... ] } (one list for every day)
  update employees e set schedule = jsonb_set(e.schedule, '{blocks}', coalesce((
      select jsonb_agg(b || jsonb_build_object(
        'from', to_char(('2000-01-01 ' || (b->>'from'))::timestamp + shift, 'HH24:MI'),
        'to',   to_char(('2000-01-01 ' || (b->>'to'))::timestamp + shift, 'HH24:MI')) order by x.ord)
      from jsonb_array_elements(e.schedule->'blocks') with ordinality as x(b, ord)), '[]'::jsonb))
  where jsonb_typeof(e.schedule->'blocks') = 'array' and e.schedule->'days' is null
    and exists (select 1 from jsonb_array_elements(e.schedule->'blocks') b where b->>'from' < '10:00')
    and not exists (select 1 from jsonb_array_elements(e.schedule->'blocks') b
                    where coalesce(b->>'from', '') !~ '^\d\d:\d\d$' or coalesce(b->>'to', '') !~ '^\d\d:\d\d$' or b->>'from' < '05:00' or b->>'to' > '13:00');

  insert into crm_migrations (key) values ('105_schedule_nz_hours');
end $$;
