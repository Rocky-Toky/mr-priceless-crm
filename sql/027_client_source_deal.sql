-- Mr Priceless CRM - track which deal auto-created a client, so a deal
-- landing on Pending Results / Closed Won only spawns one client ever
-- (even if it's dragged back and forth between those stages).
-- Run after 026. Safe to re-run.

alter table clients add column if not exists source_deal_id uuid references deals(id) on delete set null;
