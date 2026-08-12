-- Lets two people run the Aus Dialler at the same time without both landing
-- on the same prospect - see isClaimedByOther() in app.js.
alter table dial_prospects add column if not exists claimed_by text;
alter table dial_prospects add column if not exists claimed_at timestamptz;
