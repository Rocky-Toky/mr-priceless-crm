-- Client's own business website - shown alongside phone/email on the client
-- detail page, and used as a derived Onboarding step (see ONBOARDING_SECTIONS
-- in app.js) so entering it here auto-ticks the "add website" checklist item.
alter table clients add column if not exists website text;
