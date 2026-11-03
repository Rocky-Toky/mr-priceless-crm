-- Mr Priceless CRM - fortnightly report reminders in the Client inbox.
-- Every client (Pending Results onwards, not onboarding or churned) gets a
-- report every fortnight. When one is due - 14 days after their last report,
-- or 14 days after their ads started if they've never had one (and never
-- sooner than a fortnight after the last reminder) - a
-- "Fortnightly report due" row lands in the Client inbox for whoever owns the
-- client (onboarding_progress.owner: Max, else Rocky). It stays there until
-- someone presses "Sent it" or makes the report on the Reporting page, and the
-- usual 2-hour reminder email goes out if nobody does. Rows are marked
-- gmail_id 'report:<client>:<due date>' so each due date is only added once.
-- Each client can have their own report day (clients.report_anchor, set on
-- the Reporting page or their page): then a report is due on that date and
-- every 14 days from it, a report made from 3 days before covers it, and
-- "Sent it" on the reminder covers that date.
-- Run after 107. Safe to re-run.

alter table clients add column if not exists report_anchor date;

create or replace function public.queue_client_reports()
returns integer
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  n integer := 0;
  r record;
  due date;
  base date;
  after_last date;
  due_at timestamptz;
  who text;
  who_id uuid;
  key text;
  today date := (now() at time zone 'Pacific/Auckland')::date;
begin
  for r in
    select c.id, c.name, c.onboarding_progress ->> 'owner' as owner, c.report_anchor,
      (select max(cr.period_end) from client_reports cr
        where cr.client_id = c.id and coalesce(cr.metrics ->> 'kind', '') = 'mtd') as last_report,
      coalesce(c.ad_start_date,
        case when (c.onboarding_progress ->> 'live_at') ~ '^\d{4}-\d{2}-\d{2}' then left(c.onboarding_progress ->> 'live_at', 10)::date end,
        c.stage_changed_at::date, c.created_at::date) as started
    from clients c
    left join deals d on d.id = c.source_deal_id
    where coalesce(c.stage, 'onboarding') not in ('onboarding', 'churned', 'archived')
      and coalesce(d.stage, '') not in ('qualified', 'no_show', 'proposal', 'negotiation', 'onboarding')
  loop
    -- A set report day: due on it and every 14 days after.
    if r.report_anchor is not null then
      continue when today < r.report_anchor;
      due := r.report_anchor + ((today - r.report_anchor) / 14) * 14;
      if exists (select 1 from client_reports cr where cr.client_id = r.id and coalesce(cr.metrics ->> 'kind', '') = 'mtd'
                  and (cr.created_at at time zone 'Pacific/Auckland')::date >= due - 3) then
        update client_emails set status = 'done', done_by = 'Report made'
          where client_id = r.id and status = 'new' and gmail_id like 'report:%';
        continue;
      end if;
    else
    base := coalesce(r.last_report, r.started) + 14;
    -- A report made since: anything still open for an earlier due date is done.
    update client_emails set status = 'done', done_by = 'Report made'
      where client_id = r.id and status = 'new' and gmail_id like 'report:%'
        and split_part(gmail_id, ':', 3)::date < base;
    -- After a reminder (sent or not), the next one is a fortnight on.
    select max((created_at at time zone 'Pacific/Auckland')::date) + 14 into after_last
      from client_emails where client_id = r.id and gmail_id like 'report:%';
    due := greatest(base, coalesce(after_last, base));
    continue when due > today;
    end if;
    continue when exists (select 1 from client_emails where client_id = r.id and status = 'new' and gmail_id like 'report:%');
    key := 'report:' || r.id || ':' || due;
    continue when exists (select 1 from client_emails where gmail_id = key);
    due_at := (due::timestamp + interval '9 hours') at time zone 'Pacific/Auckland';
    -- Shows from 9am NZ on the day it's due.
    continue when due_at > now();
    who := case r.owner when 'max' then 'maximus.smith@mrpriceless.com' else 'rocky.oneill@mrpriceless.com' end;
    select u.id into who_id from auth.users u where lower(u.email) = who limit 1;
    insert into client_emails (user_id, inbox_email, gmail_id, client_id, client_name, from_email, from_name, subject, snippet, received_at)
    values (who_id, who, key, r.id, r.name, '', 'Mr Priceless CRM',
      'Fortnightly report due',
      'Make ' || r.name || '''s fortnightly report on the Reporting page and email it to them. Press "Sent it" once it''s gone.',
      greatest(least(due_at, now()), now() - interval '3 days'));
    n := n + 1;
  end loop;
  return n;
end;
$$;
revoke all on function public.queue_client_reports() from public, anon, authenticated;

create extension if not exists pg_cron with schema extensions;

select cron.unschedule('client-report-reminders')
where exists (select 1 from cron.job where jobname = 'client-report-reminders');

-- Every hour (on the 17th minute).
select cron.schedule('client-report-reminders', '17 * * * *', $$ select public.queue_client_reports(); $$);
