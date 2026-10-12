-- Mr Priceless CRM - 6-month nurture for lost/ghosted deals, and Jarvis.
-- Run after 056. Safe to re-run.

-- Nurture: when a deal goes Closed Lost or Ghosted, the CRM records when,
-- which nurture email is next, and when to re-engage (6 months on).
alter table deals add column if not exists stage_changed_at timestamptz;
alter table deals add column if not exists nurture jsonb not null default '{}'::jsonb;

-- Jarvis: what he's learned (facts, preferences, what worked), shared by
-- the whole team, and each person's conversation with him.
create table if not exists jarvis_memory (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  kind text not null default 'note', -- note | preference | learning
  created_by text,
  created_at timestamptz not null default now()
);
create table if not exists jarvis_messages (
  id uuid primary key default gen_random_uuid(),
  user_email text not null,
  role text not null, -- user | assistant
  content text not null,
  created_at timestamptz not null default now()
);
create index if not exists jarvis_messages_user_idx on jarvis_messages (user_email, created_at);

alter table jarvis_memory enable row level security;
alter table jarvis_messages enable row level security;

drop policy if exists "allowlisted full access" on jarvis_memory;
create policy "allowlisted full access" on jarvis_memory
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));

-- Everyone sees only their own conversation.
drop policy if exists "own messages" on jarvis_messages;
create policy "own messages" on jarvis_messages
  for all
  using (user_email = auth.jwt() ->> 'email')
  with check (user_email = auth.jwt() ->> 'email');
