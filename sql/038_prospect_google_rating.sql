-- Mr Priceless CRM - Google Maps rating/review count per prospect.
--
-- Stored as free text (e.g. "4.8 (127)") rather than split numeric columns,
-- since scrape sources format this wildly differently and a raw string is
-- good enough to glance at before a call.
--
-- Run after 037. Safe to re-run.

alter table dial_prospects add column if not exists google_rating text;
