-- Mr Priceless CRM - track quotes sent to a client
-- Run after 011. Safe to re-run.

alter table clients add column if not exists quotes_sent integer not null default 0;
