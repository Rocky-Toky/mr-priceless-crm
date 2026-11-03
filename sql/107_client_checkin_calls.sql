-- Mr Priceless CRM - weekly check-in calls for a new client's first 4 weeks.
-- A deal only counts as a client once it reaches Pending Results (or Closed
-- Won). From that day, on each of the next 4 Fridays (9am NZ; Rocky's rule:
-- check-in calls happen on a Friday), a "Week N check-in call" lands in the Client inbox for whoever owns the client (their
-- onboarding_progress.owner: Max, else Rocky), so it can't be missed: it sits
-- there until someone presses "Called them", and the usual 2-hour reminder
-- email goes out if nobody does. Rows are marked gmail_id 'checkin:<client>:<week>'
-- so each week is only ever added once. Weeks more than 3 days overdue when
-- this first runs are skipped, so older clients don't get a pile of them.
-- Run after 106. Safe to re-run.

create or replace function public.queue_client_checkins()
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  n integer := 0;
  r record;
  wk integer;
  due timestamptz;
  who text;
  who_id uuid;
  key text;
  start_day date;
  first_fri date;
begin
  for r in
    select c.id, c.name, c.onboarding_progress ->> 'owner' as owner,
      coalesce(
        (select min((h ->> 'at')::timestamptz)
           from jsonb_array_elements(case when jsonb_typeof(d.stage_history) = 'array' then d.stage_history else '[]'::jsonb end) h
          where h ->> 'stage' in ('pending_results', 'closed_won') and h ->> 'at' is not null),
        case when d.stage in ('pending_results', 'closed_won') then d.stage_changed_at end
      ) as started
    from clients c
    join deals d on d.id = c.source_deal_id
    where coalesce(c.stage, '') not in ('churned', 'archived')
  loop
    continue when r.started is null or r.started < now() - interval '35 days';
    -- The first Friday after they started (a Friday start waits for the next one).
    start_day := (r.started at time zone 'Pacific/Auckland')::date;
    first_fri := start_day + (((5 - extract(isodow from start_day)::int + 6) % 7) + 1);
    for wk in 1..4 loop
      due := ((first_fri + 7 * (wk - 1))::timestamp + interval '9 hours') at time zone 'Pacific/Auckland';
      continue when due > now() or due < now() - interval '3 days';
      key := 'checkin:' || r.id || ':' || wk;
      continue when exists (select 1 from client_emails where gmail_id = key);
      who := case r.owner when 'max' then 'maximus.smith@mrpriceless.com' else 'rocky.oneill@mrpriceless.com' end;
      select u.id into who_id from auth.users u where lower(u.email) = who limit 1;
      insert into client_emails (user_id, inbox_email, gmail_id, client_id, client_name, from_email, from_name, subject, snippet, received_at)
      values (who_id, who, key, r.id, r.name, '', 'Mr Priceless CRM',
        'Week ' || wk || ' of 4 - Friday check-in call',
        'Give ' || r.name || ' a call for a friendly check-in: how the first weeks are going, how the leads look, and anything they need from us. Press "Called them" once you have.',
        due);
      n := n + 1;
    end loop;
  end loop;
  return n;
end;
$$;
revoke all on function public.queue_client_checkins() from public, anon, authenticated;

create extension if not exists pg_cron with schema extensions;

select cron.unschedule('client-checkin-calls')
where exists (select 1 from cron.job where jobname = 'client-checkin-calls');

-- Every hour (on the 7th minute), so a check-in shows up within the hour it's due.
select cron.schedule('client-checkin-calls', '7 * * * *', $$ select public.queue_client_checkins(); $$);
