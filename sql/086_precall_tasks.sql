-- Mr Priceless CRM - pre-call nurture, phase 4: the setter's and closer's
-- tasks for each meeting (booking text, follow-up text and call, one-hour
-- reminder call, late-joiner text and call, record the outcome). The CRM
-- works the tasks out from the meeting itself (its time, when it was booked
-- or last moved, whether it's confirmed), so they move and disappear on
-- their own; what's been done is kept in task_log. Run after 085. Safe to
-- re-run.

alter table meetings add column if not exists task_log jsonb not null default '{}'::jsonb; -- { A: {status, result, note, at, by}, ... }
alter table meetings add column if not exists tasks_from timestamptz;          -- booked, or last moved: the tasks are timed from here
alter table meetings add column if not exists onehour_noanswer_at timestamptz; -- one-hour call went unanswered (GHL tag precall-onehour-noanswer)
alter table meetings add column if not exists prospect_joined_at timestamptz;
alter table meetings add column if not exists outcome_by text;
alter table meetings add column if not exists outcome_alerted_at timestamptz;  -- "no outcome yet" email sent

update meetings set tasks_from = booked_at where tasks_from is null;
