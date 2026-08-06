-- Mr Priceless CRM - Weekly creative snapshots (baseline for the Weekly Report)
-- Meta ad insights are synced as lifetime-cumulative totals, so "this week's"
-- numbers are derived by diffing against a snapshot taken at the start of the week.
-- Run after 039. Safe to re-run.

create table if not exists creative_weekly_snapshots (
  id uuid primary key default gen_random_uuid(),
  creative_id uuid not null references client_ad_creatives(id) on delete cascade,
  week_start date not null,
  spend numeric not null default 0,
  impressions bigint not null default 0,
  clicks bigint not null default 0,
  results numeric not null default 0,
  created_at timestamptz not null default now(),
  unique(creative_id, week_start)
);

alter table creative_weekly_snapshots enable row level security;

drop policy if exists "allowlisted full access" on creative_weekly_snapshots;
create policy "allowlisted full access" on creative_weekly_snapshots
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table creative_weekly_snapshots;
