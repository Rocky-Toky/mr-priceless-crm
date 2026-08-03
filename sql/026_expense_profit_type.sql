-- Mr Priceless CRM - track profit-share income from won jobs alongside
-- expenses, so the Expenses page shows money in as well as money out.
-- Run after 025. Safe to re-run.

alter table expenses add column if not exists type text not null default 'expense';
alter table expenses drop constraint if exists expenses_type_check;
alter table expenses add constraint expenses_type_check check (type in ('expense','profit'));

alter table expenses add column if not exists deal_id uuid references deals(id) on delete set null;
