-- Mr Priceless CRM - per-client Onboarding tracker (replaces the old
-- shared, localStorage-only "Onboarding Process" playbook checklist).
-- Run after 021. Safe to re-run.

alter table clients add column if not exists onboarding_progress jsonb not null default '{}'::jsonb;

-- The generic onboarding checklist now lives as its own top-level nav
-- section, tracked per-client, so the old shared playbook doc is redundant.
delete from playbooks where title = 'Onboarding Process';
