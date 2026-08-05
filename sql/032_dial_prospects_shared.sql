-- Mr Priceless CRM - make dial_prospects (the cold-calling prospect list)
-- shared team-wide again, instead of private per login.
--
-- Migration 013 made dial_prospects per-user so each login only sees rows
-- it created. That's the opposite of what's needed now: Rocky is bringing
-- on 2 new cold callers, and everyone dialing off ONE shared list (with
-- visibility into who's already called who) is the whole point - otherwise
-- two callers can easily work the same lead without ever knowing it.
--
-- Run after 031. Safe to re-run.

drop policy if exists "own rows or unowned legacy rows" on dial_prospects;
create policy "allowlisted full access" on dial_prospects
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

-- Who added a prospect, and who last called them - so a shared list stays
-- coordinated instead of just being one big anonymous pile.
alter table dial_prospects add column if not exists created_by text;
alter table dial_prospects add column if not exists last_called_by text;
