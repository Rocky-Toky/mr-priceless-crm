-- Mr Priceless CRM - every stage a deal moves through, with when, so the
-- Stats page can learn each stage's chance of ending Closed Won.
-- Run after 063. Safe to re-run.

alter table deals add column if not exists stage_history jsonb not null default '[]'::jsonb;
