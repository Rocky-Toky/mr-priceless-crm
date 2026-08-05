-- Mr Priceless CRM - Deal assignee (Rocky / Max), so booked meetings and
-- closed deals can be attributed to a person for Team Analytics.
-- Run after 030. Safe to re-run.

alter table deals add column if not exists assignee text;

create index if not exists deals_assignee_idx on deals(assignee);
