-- Mr Priceless CRM - the client portal's lead pipeline, phone alerts and the
-- 24-hour check-in (portal/, sql/112 has the logins and security).
--
-- Pipeline (client_leads.client_stage): new, no_answer ("Didn't answer"),
-- call_scheduled, site_visit, quote_to_send, quote_sent, won, lost,
-- not_qualified. Each change is kept in client_log; call-type changes also go
-- in call_log (by "client") and move follow_status, so Lead Follow Up sees
-- them. Our own calls move the client's stage forward too (trigger below).
--
-- Who calls (clients.lead_client_calls = true, the lead's client_calls):
--   - never rung by the client 24 hours after it came in -> our team
--     (handed_over_at, reason not_called)
--   - "Didn't answer": 24 hours after their first no-answer the lead goes to
--     the top of their list in red, "Did they get back to you?", with a phone
--     alert (else a text, else an email). Yes = they pick where it's at.
--     No, or no reply by 10pm NZ that day (10pm the next day if it popped up
--     after 6pm) = our team (handed_over_at, reason client_no / no_reply).
--   - once our team has rung it, or it's handed over, it's ours to call.
-- Alerts: portal_notifications, delivered by the client-portal function
-- (phone notification to every device the login turned alerts on for; a
-- text or email if none got it and the kind allows). portal_tick() runs every
-- 5 minutes from pg_cron.
-- Runs after 112 (and calls portal_lock_tables() again at the end). Safe to re-run.

-- ───────── Lead columns ─────────
alter table client_leads add column if not exists client_stage text;
alter table client_leads add column if not exists client_stage_at timestamptz;
alter table client_leads add column if not exists client_next_at timestamptz;
alter table client_leads add column if not exists client_log jsonb not null default '[]'::jsonb;
alter table client_leads add column if not exists quote_amount numeric;
alter table client_leads add column if not exists quote_sent_at timestamptz;
alter table client_leads add column if not exists quote_chased_at timestamptz;
alter table client_leads add column if not exists job_value numeric;
alter table client_leads add column if not exists lost_reason text;
alter table client_leads add column if not exists client_first_na_at timestamptz;
alter table client_leads add column if not exists checkin_at timestamptz;
alter table client_leads add column if not exists checkin_deadline timestamptz;
alter table client_leads add column if not exists checkin_answered_at timestamptz;
alter table client_leads add column if not exists checkin_token text;
alter table client_leads add column if not exists handed_over_at timestamptz;
alter table client_leads add column if not exists handover_reason text;
alter table client_leads add column if not exists call_reminded_for timestamptz;
alter table client_leads add column if not exists visit_reminded_for timestamptz;
create index if not exists client_leads_client_calls_idx on client_leads (client_id) where client_calls and handed_over_at is null;
create unique index if not exists client_leads_checkin_token_idx on client_leads (checkin_token) where checkin_token is not null;

-- ───────── Stages ─────────
-- Where a lead sits in the client's pipeline when they haven't set it
-- themselves: worked out from our calling status.
create or replace function public.portal_stage_from_follow(fs text)
returns text
language sql
immutable
as $$
  select case coalesce(fs, 'new')
    when 'no_answer' then 'no_answer'
    when 'unreachable' then 'no_answer'
    when 'call_back' then 'call_scheduled'
    when 'consult_call' then 'call_scheduled'
    when 'site_visit' then 'site_visit'
    when 'booked' then 'site_visit'
    when 'disqualified' then 'not_qualified'
    when 'wrong_number' then 'not_qualified'
    when 'not_interested' then 'lost'
    else 'new' end;
$$;
create or replace function public.portal_stage_rank(st text)
returns integer
language sql
immutable
as $$
  select case st when 'new' then 0 when 'no_answer' then 1 when 'call_scheduled' then 2 when 'site_visit' then 3
    when 'quote_to_send' then 4 when 'quote_sent' then 5 when 'won' then 6 when 'lost' then 7 when 'not_qualified' then 7 else 0 end;
$$;
create or replace function public.portal_lead_stage(l client_leads)
returns text
language sql
stable
as $$
  select coalesce(l.client_stage, public.portal_stage_from_follow(l.follow_status));
$$;

-- Is a lead ours to call (true) or still the client's (false)?
create or replace function public.portal_lead_is_ours(l client_leads)
returns boolean
language sql
stable
as $$
  select not l.client_calls
    or l.handed_over_at is not null
    or exists (select 1 from jsonb_array_elements(coalesce(l.call_log, '[]'::jsonb)) e where coalesce(e ->> 'by', '') <> 'client');
$$;

-- 10pm NZ the day it's asked, or the next day if asked after 6pm.
create or replace function public.portal_checkin_deadline(p_at timestamptz)
returns timestamptz
language sql
stable
as $$
  select (date_trunc('day', p_at at time zone 'Pacific/Auckland')
    + case when extract(hour from p_at at time zone 'Pacific/Auckland') >= 18 then interval '1 day' else interval '0' end
    + interval '22 hours') at time zone 'Pacific/Auckland';
$$;

-- Our own calls (Lead Follow Up, GHL) move the client's stage forward, never back.
create or replace function public.client_leads_stage_follow()
returns trigger
language plpgsql
as $$
declare cur text; nxt text;
begin
  if new.follow_status is distinct from old.follow_status and new.client_stage is not distinct from old.client_stage then
    cur := coalesce(old.client_stage, public.portal_stage_from_follow(old.follow_status));
    nxt := public.portal_stage_from_follow(new.follow_status);
    if nxt <> cur and (
      public.portal_stage_rank(nxt) > public.portal_stage_rank(cur) and cur not in ('lost', 'not_qualified', 'won')
    ) then
      new.client_stage := nxt;
      new.client_stage_at := now();
    end if;
  end if;
  return new;
end $$;
drop trigger if exists client_leads_stage_follow on client_leads;
create trigger client_leads_stage_follow before update on client_leads
  for each row execute function public.client_leads_stage_follow();

-- ───────── Alerts ─────────
create table if not exists portal_push_subs (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  failures integer not null default 0
);
create index if not exists portal_push_subs_email on portal_push_subs (lower(email));
create table if not exists portal_notifications (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  client_id uuid references clients(id) on delete cascade,
  lead_id uuid references client_leads(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  url text,
  fallback text,            -- 'sms,email', 'email' or null (phone alert only)
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending', -- pending, sent, texted, emailed, no_device, failed
  channel text,
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists portal_notifications_pending on portal_notifications (created_at) where status = 'pending';
do $$
declare t text; p record;
begin
  foreach t in array array['portal_push_subs', 'portal_notifications'] loop
    execute format('alter table public.%I enable row level security', t);
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;
    -- The team can see them; only the functions below and client-portal write.
    execute format('create policy "team can see" on public.%I for select using (public.is_allowlisted())', t);
  end loop;
end $$;

insert into app_secrets (name, value)
values ('portal_cron_secret', replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;

-- One alert per portal login of the client.
create or replace function public.portal_queue(p_client uuid, p_lead uuid, p_kind text, p_title text, p_body text, p_url text, p_fallback text default null, p_payload jsonb default '{}'::jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare n integer := 0; u record;
begin
  for u in select distinct lower(email) as email from client_portal_users where client_id = p_client loop
    insert into portal_notifications (email, client_id, lead_id, kind, title, body, url, fallback, payload)
    values (u.email, p_client, p_lead, p_kind, p_title, p_body, p_url, p_fallback, coalesce(p_payload, '{}'::jsonb));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Ask the client-portal function to send what's waiting. Never fails the caller.
create or replace function public.portal_kick()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform net.http_post(
    url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/client-portal',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
      'x-cron-secret', (select value from public.app_secrets where name = 'portal_cron_secret')
    ),
    body := '{"action":"deliver"}'::jsonb,
    timeout_milliseconds := 60000
  );
exception when others then
  raise notice 'portal_kick: %', sqlerrm;
end $$;

-- ───────── New leads: email (if they want it) and a phone alert, straight away ─────────
create or replace function public.client_leads_portal_alert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  u record;
  biz text;
  first text;
  qa text;
  body text;
  url text := 'https://rocky-toky.github.io/mr-priceless-crm/portal/?lead=' || new.id;
  emailed int := 0;
  pushed int := 0;
begin
  -- Only fresh enquiries (not older leads the sync pulls in) for clients who call their own.
  if not new.client_calls or coalesce(new.follow_status, 'new') <> 'new'
     or coalesce(new.lead_created_at, new.created_at) < now() - interval '2 hours' then
    return new;
  end if;
  select name into biz from clients where id = new.client_id;
  first := nullif(split_part(trim(coalesce(new.name, '')), ' ', 1), '');
  select string_agg((a ->> 'q') || ': ' || (a ->> 'a'), chr(10)) into qa
  from (select a from jsonb_array_elements(coalesce(new.answers, '[]'::jsonb)) a
        where coalesce(a ->> 'q', '') <> '' and coalesce(a ->> 'a', '') <> '' limit 8) s;
  body := 'Hi,' || chr(10) || chr(10)
    || coalesce(nullif(trim(new.name), ''), 'Someone') || ' just enquired with ' || coalesce(biz, 'you')
    || case when coalesce(new.form_name, '') <> '' then ' (' || new.form_name || ')' else '' end || '.' || chr(10) || chr(10)
    || case when coalesce(new.phone, '') <> '' then 'Phone: ' || new.phone || chr(10) else '' end
    || case when coalesce(new.city, new.address, '') <> '' then 'Where: ' || coalesce(new.address, new.city) || chr(10) else '' end
    || case when qa is not null then chr(10) || qa || chr(10) else '' end
    || chr(10) || 'Call ' || coalesce(first, 'them') || ' now - people rung in the first 5 minutes are far more likely to book.' || chr(10)
    || 'Open the lead: ' || url || chr(10) || chr(10)
    || 'Can''t get hold of them? Tap "Didn''t answer" in the portal. We''ll check with you the next day, and our team can follow them up for you.' || chr(10) || chr(10)
    || 'Mr Priceless';
  for u in select distinct lower(email) as email from client_portal_users where client_id = new.client_id and notify_new_leads loop
    insert into scheduled_emails (kind, record_id, to_email, subject, body, send_at, created_by)
    values ('portal_new_lead', new.id::text, u.email, 'New lead: ' || coalesce(nullif(trim(new.name), ''), 'someone') || ' - call them now', body, now(), 'portal');
    emailed := emailed + 1;
  end loop;
  pushed := public.portal_queue(new.client_id, new.id, 'new_lead',
    'New lead: ' || coalesce(nullif(trim(new.name), ''), 'someone'),
    coalesce(nullif(new.form_name, '') || ' · ', '') || coalesce(nullif(new.city, ''), '') || case when coalesce(new.city, '') <> '' then ' · ' else '' end || 'Call ' || coalesce(first, 'them') || ' now',
    url, null, '{}'::jsonb);
  -- Send now rather than on the next 5-minute run. Never holds up the lead itself.
  if emailed > 0 then
    begin
      perform net.http_post(
        url := 'https://chaexdenosljtdwuyjnw.supabase.co/functions/v1/send-scheduled-emails',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer sb_publishable_2FnHNV8THv1QUrFumCzu4A_WyCD9UH_',
          'x-cron-secret', (select value from public.app_secrets where name = 'email_cron_secret')
        ),
        body := '{}'::jsonb
      );
    exception when others then null;
    end;
  end if;
  if pushed > 0 then perform public.portal_kick(); end if;
  return new;
exception when others then
  return new;
end $$;
drop trigger if exists client_leads_portal_alert on client_leads;
create trigger client_leads_portal_alert after insert on client_leads
  for each row execute function public.client_leads_portal_alert();

-- ───────── What the portal reads ─────────
-- Their leads from the last p_days days, newest first, with what they put on
-- the form and where each one is in their pipeline. Who on our team rang them
-- is never sent - just "Mr Priceless".
create or replace function public.portal_leads(p_client uuid default null, p_days integer default 365)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare cid uuid := public.portal_client_for(p_client);
begin
  if cid is null then raise exception 'Not allowed'; end if;
  return (
    select coalesce(jsonb_agg(s.x order by s.at desc), '[]'::jsonb) from (
      select
        coalesce(l.lead_created_at, l.created_at) as at,
        jsonb_build_object(
          'id', l.id,
          'name', l.name,
          'phone', l.phone,
          'email', l.email,
          'at', coalesce(l.lead_created_at, l.created_at),
          'form', l.form_name,
          'answers', coalesce(l.answers, '[]'::jsonb),
          'address', l.address,
          'city', l.city,
          'scope', l.job_scope,
          'ad', nullif(coalesce(l.ad_info ->> 'ad', ''), ''),
          'campaign', nullif(coalesce(l.ad_info ->> 'campaign', l.ad_info ->> 'form', ''), ''),
          'status', coalesce(l.follow_status, 'new'),
          'stage', public.portal_lead_stage(l),
          'stage_at', coalesce(l.client_stage_at, l.last_attempt_at),
          'next_at', coalesce(l.client_next_at,
                       case when l.follow_status in ('site_visit', 'booked', 'consult_call') then l.booked_for end,
                       case when l.follow_status = 'call_back' then l.next_attempt_at end),
          'quote_amount', l.quote_amount,
          'quote_sent_at', l.quote_sent_at,
          'job_value', l.job_value,
          'lost_reason', l.lost_reason,
          'client_calls', l.client_calls,
          'ours', public.portal_lead_is_ours(l),
          'handed_over_at', l.handed_over_at,
          'handover_reason', l.handover_reason,
          'first_na_at', l.client_first_na_at,
          'checkin', l.checkin_at is not null and l.checkin_answered_at is null and l.handed_over_at is null,
          'checkin_deadline', case when l.checkin_answered_at is null and l.handed_over_at is null then l.checkin_deadline end,
          'seen_at', l.client_seen_at,
          'dialled_at', l.client_dialled_at,
          'notes', (select coalesce(jsonb_agg(e order by e ->> 'at'), '[]'::jsonb) from jsonb_array_elements(coalesce(l.client_log, '[]'::jsonb)) e),
          'log', (select coalesce(jsonb_agg(jsonb_build_object(
                    'at', e ->> 'at',
                    'by', case when e ->> 'by' = 'client' then 'you' else 'Mr Priceless' end,
                    'outcome', e ->> 'outcome',
                    'note', e ->> 'note',
                    'when', e ->> 'when') order by e ->> 'at'), '[]'::jsonb)
                  from jsonb_array_elements(coalesce(l.call_log, '[]'::jsonb)) e)
        ) as x
      from client_leads l
      where l.client_id = cid
        and coalesce(l.follow_status, 'new') <> 'old'
        and coalesce(l.lead_created_at, l.created_at) > now() - make_interval(days => greatest(1, least(coalesce(p_days, 365), 400)))
      order by coalesce(l.lead_created_at, l.created_at) desc
      limit 1000
    ) s
  );
end $$;

-- ───────── What the portal changes (client logins only - the team's preview is read-only) ─────────
-- Move a lead along their pipeline and/or add a note.
create or replace function public.portal_update_lead(p_lead uuid, p_stage text default null, p_note text default null, p_when timestamptz default null, p_amount numeric default null, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  l client_leads;
  cid uuid;
  note text := nullif(left(trim(coalesce(p_note, '')), 2000), '');
  reason text := nullif(left(trim(coalesce(p_reason, '')), 200), '');
  cur text;
  call_out text;
  pending boolean;
  open_fs boolean;
begin
  if not public.is_portal_user() then raise exception 'Only clients can update leads here'; end if;
  select * into l from client_leads where id = p_lead for update;
  if not found then raise exception 'Not allowed'; end if;
  cid := public.portal_client_for(l.client_id);
  if cid is null or cid <> l.client_id then raise exception 'Not allowed'; end if;
  if p_stage is null and note is null then raise exception 'Nothing to save'; end if;
  if p_stage is not null and p_stage not in ('new', 'no_answer', 'call_scheduled', 'site_visit', 'quote_to_send', 'quote_sent', 'won', 'lost', 'not_qualified') then
    raise exception 'Unknown stage';
  end if;
  if p_stage = 'call_scheduled' and p_when is null then raise exception 'Pick when to call them'; end if;
  if p_amount is not null and (p_amount < 0 or p_amount > 100000000) then raise exception 'That amount doesn''t look right'; end if;

  cur := public.portal_lead_stage(l);
  pending := l.checkin_at is not null and l.checkin_answered_at is null and l.handed_over_at is null;
  open_fs := coalesce(l.follow_status, 'new') in ('new', 'no_answer', 'call_back', 'qualified');
  call_out := case p_stage
    when 'no_answer' then 'no_answer'
    when 'call_scheduled' then 'call_back'
    when 'site_visit' then 'site_visit'
    when 'not_qualified' then 'disqualified'
    when 'lost' then case when open_fs then 'not_interested' end
    end;

  update client_leads set
    client_log = coalesce(client_log, '[]'::jsonb) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'at', now(), 'stage', p_stage, 'from', case when p_stage is not null then cur end,
      'note', note, 'when', p_when, 'amount', p_amount, 'reason', reason))),
    call_log = case when call_out is not null
      then coalesce(call_log, '[]'::jsonb) || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'at', now(), 'by', 'client', 'outcome', call_out, 'note', coalesce(note, ''), 'when', p_when)))
      else call_log end,
    client_stage = coalesce(p_stage, client_stage),
    client_stage_at = case when p_stage is not null then now() else client_stage_at end,
    client_seen_at = coalesce(client_seen_at, now()),
    client_first_na_at = case when p_stage = 'no_answer' then coalesce(client_first_na_at, now()) else client_first_na_at end,
    client_next_at = case when p_stage in ('call_scheduled', 'site_visit') then p_when when p_stage is not null then null else client_next_at end,
    quote_amount = case when p_stage = 'quote_sent' and p_amount is not null then p_amount else quote_amount end,
    quote_sent_at = case when p_stage = 'quote_sent' then now() else quote_sent_at end,
    quote_chased_at = case when p_stage = 'quote_sent' then null else quote_chased_at end,
    job_value = case when p_stage = 'won' then coalesce(p_amount, quote_amount) else job_value end,
    lost_reason = case when p_stage in ('lost', 'not_qualified') then reason else lost_reason end,
    last_attempt_at = case when call_out is not null then now() else last_attempt_at end,
    follow_notes = case when note is not null and call_out is not null then note else follow_notes end,
    follow_status = case
      when p_stage = 'no_answer' then case when coalesce(follow_status, 'new') = 'new' then 'no_answer' else follow_status end
      when p_stage = 'call_scheduled' then case when open_fs then 'call_back' else follow_status end
      when p_stage = 'site_visit' then 'site_visit'
      when p_stage in ('quote_to_send', 'quote_sent', 'won') then case when open_fs then 'booked' else follow_status end
      when p_stage = 'lost' then case when open_fs then 'not_interested' else follow_status end
      when p_stage = 'not_qualified' then case when open_fs then 'disqualified' else follow_status end
      else follow_status end,
    next_attempt_at = case
      when p_stage = 'call_scheduled' then case when open_fs then p_when else next_attempt_at end
      when p_stage in ('site_visit', 'quote_to_send', 'quote_sent', 'won', 'lost', 'not_qualified') then null
      else next_attempt_at end,
    booked_for = case when p_stage = 'site_visit' then p_when else booked_for end,
    -- The 24-hour check-in: picking where it's at answers it, "Didn't answer" again means "No".
    checkin_answered_at = case when pending and p_stage is not null then now() else checkin_answered_at end,
    handed_over_at = case when pending and p_stage = 'no_answer' then now() else handed_over_at end,
    handover_reason = case when pending and p_stage = 'no_answer' then 'client_no' else handover_reason end,
    updated_at = now()
  where id = l.id;
  return jsonb_build_object('ok', true);
end $$;

-- Kept for portal pages opened before the pipeline (older call outcomes).
create or replace function public.portal_log_call(p_lead uuid, p_outcome text, p_note text default null, p_when timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare l client_leads; cid uuid;
begin
  if not public.is_portal_user() then raise exception 'Only clients can save calls here'; end if;
  select * into l from client_leads where id = p_lead;
  if not found then raise exception 'Not allowed'; end if;
  cid := public.portal_client_for(l.client_id);
  if cid is null or cid <> l.client_id then raise exception 'Not allowed'; end if;
  if p_outcome = 'seen' then
    update client_leads set client_seen_at = coalesce(client_seen_at, now()) where id = l.id;
    return jsonb_build_object('ok', true);
  end if;
  if p_outcome = 'dialled' then
    update client_leads set client_dialled_at = now(), client_seen_at = coalesce(client_seen_at, now()) where id = l.id;
    return jsonb_build_object('ok', true);
  end if;
  return public.portal_update_lead(p_lead, case p_outcome
    when 'booked' then 'site_visit' when 'call_back' then 'call_scheduled' when 'no_answer' then 'no_answer'
    when 'not_interested' then 'lost' when 'disqualified' then 'not_qualified' when 'wrong_number' then 'not_qualified'
    else null end, p_note, p_when, null, case when p_outcome = 'wrong_number' then 'Wrong number' end);
end $$;

-- The check-in's "No - pass them to Mr Priceless", from the portal.
create or replace function public.portal_checkin(p_lead uuid, p_answer text)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare l client_leads; cid uuid;
begin
  if not public.is_portal_user() then raise exception 'Only clients can answer this'; end if;
  if p_answer <> 'no' then raise exception 'Pick where the lead is at instead'; end if;
  select * into l from client_leads where id = p_lead for update;
  if not found then raise exception 'Not allowed'; end if;
  cid := public.portal_client_for(l.client_id);
  if cid is null or cid <> l.client_id then raise exception 'Not allowed'; end if;
  if l.handed_over_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  update client_leads set
    handed_over_at = now(), handover_reason = 'client_no', checkin_answered_at = coalesce(checkin_answered_at, now()),
    client_log = coalesce(client_log, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'note', 'Passed to Mr Priceless to follow up')),
    updated_at = now()
  where id = l.id;
  return jsonb_build_object('ok', true);
end $$;

-- The same "No" from the link in the text / email, without signing in. The
-- link carries the lead's one-off check-in token; all it can do is hand that
-- one lead to our team.
create or replace function public.portal_checkin_link(p_token text, p_answer text default 'no')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare l client_leads;
begin
  if coalesce(length(p_token), 0) < 32 or p_answer <> 'no' then raise exception 'That link isn''t right'; end if;
  select * into l from client_leads where checkin_token = p_token for update;
  if not found then raise exception 'That link isn''t right'; end if;
  if l.handed_over_at is null and l.checkin_answered_at is null then
    update client_leads set
      handed_over_at = now(), handover_reason = 'client_no', checkin_answered_at = now(),
      client_log = coalesce(client_log, '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', now(), 'note', 'Passed to Mr Priceless to follow up')),
      updated_at = now()
    where id = l.id;
    return jsonb_build_object('ok', true, 'first', split_part(trim(coalesce(l.name, '')), ' ', 1));
  end if;
  return jsonb_build_object('ok', true, 'already', true, 'first', split_part(trim(coalesce(l.name, '')), ' ', 1));
end $$;

-- Phone alerts: save this device (a browser push subscription) for the login.
create or replace function public.portal_save_push(p_sub jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare me text := (select lower(email) from auth.users where id = auth.uid());
begin
  if not public.is_portal_user() then raise exception 'Only clients can turn on alerts here'; end if;
  if coalesce(p_sub ->> 'endpoint', '') !~ '^https://' or coalesce(p_sub #>> '{keys,p256dh}', '') = '' or coalesce(p_sub #>> '{keys,auth}', '') = '' then
    raise exception 'That device can''t take alerts';
  end if;
  insert into portal_push_subs (email, endpoint, p256dh, auth, user_agent)
  values (me, p_sub ->> 'endpoint', p_sub #>> '{keys,p256dh}', p_sub #>> '{keys,auth}', left(p_sub ->> 'ua', 300))
  on conflict (endpoint) do update set email = excluded.email, p256dh = excluded.p256dh, auth = excluded.auth,
    user_agent = excluded.user_agent, failures = 0;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.portal_set_settings(p_notify boolean default null, p_phone text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare ph text := nullif(left(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), 20), '');
begin
  if not public.is_portal_user() then raise exception 'Not allowed'; end if;
  update client_portal_users p set
    notify_new_leads = coalesce(p_notify, p.notify_new_leads),
    phone = case when p_phone is null then p.phone else ph end
  from auth.users u where u.id = auth.uid() and lower(p.email) = lower(u.email);
  return jsonb_build_object('ok', true);
end $$;

do $$
declare f text;
begin
  foreach f in array array['portal_leads(uuid, integer)', 'portal_update_lead(uuid, text, text, timestamptz, numeric, text)',
    'portal_log_call(uuid, text, text, timestamptz)', 'portal_checkin(uuid, text)', 'portal_save_push(jsonb)',
    'portal_set_settings(boolean, text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
revoke all on function public.portal_checkin_link(text, text) from public;
grant execute on function public.portal_checkin_link(text, text) to anon, authenticated;
revoke all on function public.portal_queue(uuid, uuid, text, text, text, text, text, jsonb) from public;
revoke all on function public.portal_kick() from public;

-- ───────── Every 5 minutes: hand-overs, the check-in, reminders ─────────
create or replace function public.portal_tick()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  base text := 'https://rocky-toky.github.io/mr-priceless-crm/portal/';
  first text;
  biz text;
  tok text;
  dl timestamptz;
  n_not_called int := 0; n_checkin int := 0; n_no_reply int := 0; n_other int := 0;
  nz_now timestamp := now() at time zone 'Pacific/Auckland';
begin
  -- 1. Never rung by the client 24 hours after it came in: ours.
  for r in
    select l.* from client_leads l
    where l.client_calls and l.handed_over_at is null
      and coalesce(l.follow_status, 'new') = 'new' and public.portal_lead_stage(l) = 'new'
      and l.client_dialled_at is null
      and not exists (select 1 from jsonb_array_elements(coalesce(l.call_log, '[]'::jsonb)) e)
      and coalesce(l.lead_created_at, l.created_at) <= now() - interval '24 hours'
    for update skip locked
  loop
    update client_leads set handed_over_at = now(), handover_reason = 'not_called', updated_at = now() where id = r.id;
    first := coalesce(nullif(split_part(trim(coalesce(r.name, '')), ' ', 1), ''), 'them');
    perform public.portal_queue(r.client_id, r.id, 'handed_over', 'We''re calling ' || first || ' for you',
      first || ' hadn''t been rung 24 hours after they enquired, so the Mr Priceless team is following them up.', base || '?lead=' || r.id);
    n_not_called := n_not_called + 1;
  end loop;

  -- 2. 24 hours after the client's first no-answer (or a call they never
  --    said the outcome of): "Did they get back to you?"
  for r in
    select l.* from client_leads l
    where l.client_calls and l.handed_over_at is null and l.checkin_at is null
      and coalesce(l.follow_status, 'new') in ('new', 'no_answer')
      and public.portal_lead_stage(l) in ('new', 'no_answer')
      and coalesce(l.client_first_na_at, l.client_dialled_at) <= now() - interval '24 hours'
      and not exists (select 1 from jsonb_array_elements(coalesce(l.call_log, '[]'::jsonb)) e where coalesce(e ->> 'by', '') <> 'client')
    for update skip locked
  loop
    tok := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
    dl := public.portal_checkin_deadline(now());
    update client_leads set checkin_at = now(), checkin_deadline = dl, checkin_token = tok, updated_at = now() where id = r.id;
    first := coalesce(nullif(split_part(trim(coalesce(r.name, '')), ' ', 1), ''), 'them');
    select name into biz from clients where id = r.client_id;
    perform public.portal_queue(r.client_id, r.id, 'checkin', 'Did ' || first || ' get back to you?',
      'Tap to say where ' || first || ' is at. Not yet? We''ll follow them up for you from ' || to_char(dl at time zone 'Pacific/Auckland', 'FMHH12am Dy') || '.',
      base || '?lead=' || r.id, 'sms,email',
      jsonb_build_object('token', tok,
        'sms', 'Mr Priceless: did ' || coalesce(nullif(trim(r.name), ''), 'your lead') || ' get back to you? Update them: ' || base || '?lead=' || r.id
          || ' - Not yet? Tap to pass them to our team: ' || base || '?checkin=' || tok,
        'email_subject', 'Did ' || coalesce(nullif(trim(r.name), ''), 'your lead') || ' get back to you?',
        'email_body', 'Hi,' || chr(10) || chr(10) || 'You couldn''t get hold of ' || coalesce(nullif(trim(r.name), ''), 'a lead') || ' (' || coalesce(biz, 'your business') || ') yesterday.' || chr(10) || chr(10)
          || 'Did they get back to you? Update them here: ' || base || '?lead=' || r.id || chr(10) || chr(10)
          || 'Not yet? Tap here and our team will follow them up for you: ' || base || '?checkin=' || tok || chr(10) || chr(10)
          || 'If we don''t hear from you by ' || to_char(dl at time zone 'Pacific/Auckland', 'FMHH12am Day') || ', we''ll follow them up anyway.' || chr(10) || chr(10)
          || 'Mr Priceless'));
    n_checkin := n_checkin + 1;
  end loop;

  -- 3. No answer to the check-in by the deadline: ours.
  for r in
    select l.* from client_leads l
    where l.client_calls and l.handed_over_at is null and l.checkin_at is not null and l.checkin_answered_at is null
      and l.checkin_deadline <= now()
    for update skip locked
  loop
    update client_leads set handed_over_at = now(), handover_reason = 'no_reply', updated_at = now() where id = r.id;
    first := coalesce(nullif(split_part(trim(coalesce(r.name, '')), ' ', 1), ''), 'them');
    perform public.portal_queue(r.client_id, r.id, 'handed_over', 'We''re following up ' || first || ' for you',
      'The Mr Priceless team will give ' || first || ' a call. If they do get back to you, just update them in the app.', base || '?lead=' || r.id);
    n_no_reply := n_no_reply + 1;
  end loop;

  -- 4. Quote sent 3 days ago and nothing since: a nudge to chase it.
  for r in
    select l.* from client_leads l
    where l.client_stage = 'quote_sent' and l.quote_sent_at <= now() - interval '3 days' and l.quote_chased_at is null
    for update skip locked
  loop
    update client_leads set quote_chased_at = now() where id = r.id;
    first := coalesce(nullif(split_part(trim(coalesce(r.name, '')), ' ', 1), ''), 'them');
    perform public.portal_queue(r.client_id, r.id, 'quote_chase', 'Chase your quote to ' || first,
      'You sent it 3 days ago. A quick call now wins a lot more jobs.', base || '?lead=' || r.id);
    n_other := n_other + 1;
  end loop;

  -- 5. A call they booked in is due.
  for r in
    select l.* from client_leads l
    where l.client_stage = 'call_scheduled' and l.client_next_at between now() - interval '30 minutes' and now() + interval '10 minutes'
      and l.call_reminded_for is distinct from l.client_next_at
    for update skip locked
  loop
    update client_leads set call_reminded_for = r.client_next_at where id = r.id;
    first := coalesce(nullif(split_part(trim(coalesce(r.name, '')), ' ', 1), ''), 'them');
    perform public.portal_queue(r.client_id, r.id, 'call_due', 'Time to call ' || first,
      'You said you''d ring at ' || to_char(r.client_next_at at time zone 'Pacific/Auckland', 'FMHH12:MIam') || '. Tap to call.', base || '?lead=' || r.id);
    n_other := n_other + 1;
  end loop;

  -- 6. Site visit today (from 7am NZ).
  if extract(hour from nz_now) >= 7 then
    for r in
      select l.*, coalesce(l.client_next_at, l.booked_for) as visit_at from client_leads l
      where public.portal_lead_stage(l) = 'site_visit'
        and coalesce(l.client_next_at, l.booked_for) > now()
        and (coalesce(l.client_next_at, l.booked_for) at time zone 'Pacific/Auckland')::date = nz_now::date
        and l.visit_reminded_for is distinct from coalesce(l.client_next_at, l.booked_for)
      for update skip locked
    loop
      update client_leads set visit_reminded_for = r.visit_at where id = r.id;
      first := coalesce(nullif(split_part(trim(coalesce(r.name, '')), ' ', 1), ''), 'them');
      perform public.portal_queue(r.client_id, r.id, 'visit_today', 'Site visit today: ' || coalesce(nullif(trim(r.name), ''), 'a lead'),
        to_char(r.visit_at at time zone 'Pacific/Auckland', 'FMHH12:MIam') || coalesce(' · ' || nullif(coalesce(r.address, r.city), ''), ''), base || '?lead=' || r.id);
      n_other := n_other + 1;
    end loop;
  end if;

  if exists (select 1 from portal_notifications where status = 'pending')
     or not exists (select 1 from app_secrets where name = 'push_vapid') then
    perform public.portal_kick();
  end if;
  return jsonb_build_object('not_called', n_not_called, 'checkins', n_checkin, 'no_reply', n_no_reply, 'reminders', n_other);
end $$;
revoke all on function public.portal_tick() from public;

create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;
select cron.unschedule('portal-tick') where exists (select 1 from cron.job where jobname = 'portal-tick');
select cron.schedule('portal-tick', '*/5 * * * *', $$ select public.portal_tick(); $$);

-- New tables refuse client logins too (sql/112).
select public.portal_lock_tables() as tables_closed_to_client_logins;

-- Run it once now (counts only in the deploy log); this also makes the
-- phone-alert keys straight away the first time.
select public.portal_tick() as portal_tick;
