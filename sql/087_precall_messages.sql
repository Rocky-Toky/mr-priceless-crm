-- Mr Priceless CRM - pre-call nurture, phase 5: the message timeline. Every
-- 5 minutes the precall-meetings Edge Function reads each recent prospect's
-- conversation in our GHL sub-account (the texts and emails GHL sent them,
-- delivery status, and any replies) into precall_messages. A reply comes in
-- unread until someone opens that prospect's timeline. Texts and calls from
-- the setter's own phone are logged by hand (meeting_events kind "manual").
-- Run after 086. Safe to re-run.

create table if not exists precall_messages (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid references meetings(id) on delete cascade,
  ghl_contact_id text,
  ghl_message_id text not null unique,
  channel text not null default 'other',     -- sms | email | call | other
  direction text not null default 'outbound', -- inbound | outbound
  subject text,
  body text,
  status text,                               -- delivered | sent | failed | undelivered | read ...
  error text,
  at timestamptz not null,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists precall_messages_meeting_idx on precall_messages (meeting_id, at);
create index if not exists precall_messages_unread_idx on precall_messages (meeting_id) where direction = 'inbound' and read_at is null;

alter table meetings add column if not exists ghl_conversation_id text;
alter table meetings add column if not exists messages_synced_at timestamptz;

do $$
declare p record;
begin
  alter table public.precall_messages enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'precall_messages' loop
    execute format('drop policy %I on public.precall_messages', p.policyname);
  end loop;
  create policy "team only" on public.precall_messages for all using (public.is_allowlisted()) with check (public.is_allowlisted());
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'precall_messages') then
    alter publication supabase_realtime add table public.precall_messages;
  end if;
end $$;
