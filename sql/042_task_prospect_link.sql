-- Mr Priceless CRM - link tasks back to the prospect they came from
-- (used by the Call Back -> Follow Up flow, which auto-creates a task).
-- Run after 041. Safe to re-run.

alter table tasks add column if not exists prospect_id uuid references dial_prospects(id) on delete set null;

create index if not exists tasks_prospect_id_idx on tasks(prospect_id);
