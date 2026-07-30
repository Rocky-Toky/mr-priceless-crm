-- Mr Priceless CRM - Client lifecycle stages (retention/customer journey)
-- Run after 018. Safe to re-run.

alter table clients add column if not exists stage text not null default 'onboarding';
alter table clients add column if not exists stage_changed_at timestamptz not null default now();

create index if not exists clients_stage_idx on clients(stage);
