-- Mr Priceless CRM - per-person "focus vertical" for the shared Prospecting
-- list.
--
-- The prospect list stays one shared pool (see 032), but a caller can be
-- assigned an industry to focus on (e.g. Max -> Landscaping) so that
-- vertical surfaces at the top of the list for them specifically, without
-- hiding anything from anyone else.
--
-- Run after 035. Safe to re-run.

create table if not exists team_focus (
  person text primary key check (person in ('rocky','max','bailey','gabriel')),
  industry text,
  updated_at timestamptz default now()
);

alter table team_focus enable row level security;

drop policy if exists "allowlisted full access" on team_focus;
create policy "allowlisted full access" on team_focus
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));
