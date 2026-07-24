-- Mr Priceless CRM - make Meetings Booked, To Do, Dialer, and Tasks per-login
-- instead of shared. Deals, Dashboard, Clients, Reporting, Contacts, and
-- Prospecting stay shared as-is - nothing changes for those.
-- Run after 012. Safe to re-run.

-- Generic per-user JSON blob storage. Meetings Booked and To Do are both
-- self-contained client-side widgets (daily/weekly goal trackers with their
-- own history + activity log) that used to live only in localStorage - this
-- lets them sync to the cloud per-login instead, without rewriting their
-- internal game logic.
create table if not exists user_widget_state (
  user_id uuid not null references auth.users(id) on delete cascade,
  widget text not null,
  data jsonb not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (user_id, widget)
);

alter table user_widget_state enable row level security;

drop policy if exists "users manage own widget state" on user_widget_state;
create policy "users manage own widget state" on user_widget_state
  for all
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

alter publication supabase_realtime add table user_widget_state;

-- Dialer and Tasks become per-user. The user_id column is nullable on
-- purpose: existing rows (added before this migration) have no recorded
-- owner, so they stay visible/editable by everyone rather than disappearing
-- for whoever didn't happen to create them. Only rows added from here on
-- (which the app always stamps with the creator's user_id) become private.
alter table dial_prospects add column if not exists user_id uuid references auth.users(id) on delete set null;
alter table tasks add column if not exists user_id uuid references auth.users(id) on delete set null;

drop policy if exists "allowlisted full access" on dial_prospects;
create policy "own rows or unowned legacy rows" on dial_prospects
  for all
  using (user_id = auth.uid() or user_id is null)
  with check (user_id = auth.uid() or user_id is null);

drop policy if exists "allowlisted full access" on tasks;
create policy "own rows or unowned legacy rows" on tasks
  for all
  using (user_id = auth.uid() or user_id is null)
  with check (user_id = auth.uid() or user_id is null);
