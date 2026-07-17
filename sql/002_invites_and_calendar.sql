-- Mr Priceless CRM — invites + Google Calendar sync
-- Run this in the SQL Editor AFTER schema.sql. Safe to run once.

-- ───────── Allowlist: who is allowed to use the CRM ─────────
-- Sign-in itself is "anyone with a Google account", so this table is what
-- actually gates access to your data. Seed it with your own email below.
create table if not exists allowlist (
  email text primary key,
  invited_by text,
  created_at timestamptz not null default now()
);

alter table allowlist enable row level security;

-- Anyone already on the allowlist can see who else is on it, and add new rows
-- (the invite-user Edge Function is what actually gets called from the app —
-- this policy just means the function's own allowlist check works, and lets
-- the Team page list current teammates).
create policy "allowlisted can read allowlist" on allowlist
  for select using (exists (
    select 1 from allowlist a where a.email = auth.jwt() ->> 'email'
  ));

-- IMPORTANT: put your own email here so you can sign in the first time.
-- Add more rows later from inside the app (Team page) instead of SQL.
insert into allowlist (email, invited_by)
values ('YOUR-EMAIL@example.com', 'setup')
on conflict (email) do nothing;

-- ───────── Re-scope existing tables to allowlisted users only ─────────
drop policy if exists "authenticated full access" on contacts;
drop policy if exists "authenticated full access" on cold_calls;
drop policy if exists "authenticated full access" on deals;
drop policy if exists "authenticated full access" on notes;

create policy "allowlisted full access" on contacts
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

create policy "allowlisted full access" on cold_calls
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

create policy "allowlisted full access" on deals
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

create policy "allowlisted full access" on notes
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

-- ───────── Google Calendar tokens (one per user) ─────────
-- Holds each person's Google refresh token so the app can mint fresh access
-- tokens later without asking them to sign in again. Client can write its own
-- row but can never read tokens back out — only the refresh-google-token
-- Edge Function (using the service_role key) can read this table.
create table if not exists google_tokens (
  user_id uuid primary key references auth.users(id) on delete cascade,
  refresh_token text not null,
  connected_at timestamptz not null default now()
);

alter table google_tokens enable row level security;

create policy "users can store their own google token" on google_tokens
  for insert with check (auth.uid() = user_id);

create policy "users can update their own google token" on google_tokens
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- No select policy on purpose — the client should never read tokens back.

-- ───────── Track which cold-call follow-ups are already on a calendar ─────────
alter table cold_calls add column if not exists calendar_event_id text;
