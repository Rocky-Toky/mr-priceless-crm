-- Mr Priceless CRM - where a deal came from: 'outbound' (our cold calling)
-- or 'inbound' (they came to us). Splits sit rate and close rate on the
-- Stats page. Deals from before this count as outbound. Run after 060.
-- Safe to re-run.

alter table deals add column if not exists source text;
