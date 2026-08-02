-- Mr Priceless CRM - Task assignee (Rocky / Max)
-- Run after 020. Safe to re-run.

alter table tasks add column if not exists assignee text;

create index if not exists tasks_assignee_idx on tasks(assignee);
