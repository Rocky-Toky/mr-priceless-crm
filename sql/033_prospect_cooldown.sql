-- Mr Priceless CRM - prospect website field + call cooldown ("snooze").
--
-- The actual anti-double-calling mechanism Rocky wants: logging a call on a
-- business hides it from the "ready to call" list for a few days, then it
-- resurfaces on its own. snoozed_until is when it becomes callable again.
--
-- Run after 032. Safe to re-run.

alter table dial_prospects add column if not exists website text;
alter table dial_prospects add column if not exists snoozed_until timestamptz;

create index if not exists dial_prospects_snoozed_until_idx on dial_prospects(snoozed_until);
