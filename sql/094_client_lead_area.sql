-- Mr Priceless CRM - Lead Follow Up: "{client} covers" on the call screen.
-- Rocky / Max write where each client takes jobs (e.g. "Wellington, Lower
-- Hutt and Porirua - not Upper Hutt"); Carmen sees it on every lead for that
-- client. It no longer comes from the onboarding answers. Run after 093.
-- Safe to re-run.

alter table clients add column if not exists lead_area text;
