-- Mr Priceless CRM - Lead Follow Up: each team member's working day, shown on
-- the Schedule page and changed there by Rocky / Max. { blocks: [{ id, from,
-- to, kind, text, note }] }; empty means the standard day built into the CRM.
-- Run after 095. Safe to re-run.

alter table employees add column if not exists schedule jsonb not null default '{}'::jsonb;
