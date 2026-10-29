-- Mr Priceless CRM - Lead Follow Up: the region each client works in (e.g.
-- Taranaki, Hawke's Bay), set by Rocky / Max from the call screen. Shown under
-- "Where they are" with a map when the lead didn't give an address. Run after
-- 096. Safe to re-run.

alter table clients add column if not exists lead_region text;
