-- Mr Priceless CRM — simplify meeting qualification
-- Run after 003. Safe to re-run.

-- Column now holds every attendee on the meeting (not just "external" ones) —
-- the human now decides Yes / Internal Meeting / No instead of the automation
-- pre-filtering by email domain.
alter table meeting_reviews rename column external_emails to attendees;

-- "disqualified" is renamed "not_qualified" to match the new 3-way answer
-- (Yes / Internal Meeting / No). Existing rows (if any) are updated to match.
update meeting_reviews set status = 'not_qualified' where status = 'disqualified';
update deals set stage = 'not_qualified' where stage = 'disqualified';
