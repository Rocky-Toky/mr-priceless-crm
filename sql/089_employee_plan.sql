-- Mr Priceless CRM - Performance review: each employee's 30-60-90 day plan
-- and week-by-week onboarding plan, with what they've ticked off. Kept on the
-- employee's row as { weeks, phases, done: { itemId: isoDate } }; weeks and
-- phases are only stored once Rocky or Max edit them - until then the CRM's
-- built-in plan is used. Run after 088. Safe to re-run.

alter table employees add column if not exists plan jsonb not null default '{}'::jsonb;
