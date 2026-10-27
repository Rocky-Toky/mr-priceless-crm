-- Mr Priceless CRM - Lead Follow Up: "Call back later" moves the lead to the
-- client's Stuck stage in GoHighLevel. stuck_stage lets Rocky / Max pick a
-- different stage per client (Setup -> Stages); blank = matched by name.
-- Run after 092. Safe to re-run.

alter table lead_stage_map add column if not exists stuck_stage text;

-- What the sync found in each client's pipeline: the stage each outcome goes
-- to, and any the flow needs that are missing (shown on Setup).
alter table lead_sync_status add column if not exists stages jsonb;
