-- Mr Priceless CRM - each client's rough margin on a job (a %, e.g. 35),
-- asked at onboarding and used for rough profit on their finance report;
-- and whether a creative is a video (shown as a still with a Video label).
-- Run after 062. Safe to re-run.

alter table clients add column if not exists margin numeric;
alter table client_ad_creatives add column if not exists media_type text;
