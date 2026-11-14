-- Mr Priceless CRM - which ad platforms we run for each client (Meta, Google or
-- both), picked on the client board (Rocky, 14 Nov 2026). Empty = not set yet;
-- the board then assumes Meta when the client has a Meta ad account. Safe to re-run.
alter table clients add column if not exists ad_platforms text[];
