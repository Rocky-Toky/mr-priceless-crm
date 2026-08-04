-- Mr Priceless CRM - Email Templates (reusable sales emails, shared with
-- the whole team). Mirrors the Playbooks table/RLS pattern.
-- Run after 029. Safe to re-run.

create table if not exists email_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  subject text not null default '',
  body text not null default '',
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table email_templates enable row level security;

drop policy if exists "allowlisted full access" on email_templates;
create policy "allowlisted full access" on email_templates
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

alter publication supabase_realtime add table email_templates;
