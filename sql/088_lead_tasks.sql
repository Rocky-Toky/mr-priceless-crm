-- Mr Priceless CRM - Lead Follow Up: follow-ups. Simple to-dos for whoever's
-- calling leads (Carmen): "Call Sarah back Tuesday 2pm", "Text Tom the
-- quote time". Each can be tied to a lead, has a time it's due, and is
-- ticked off when done. Call-backs booked from a call show alongside these
-- on the Follow-ups page (they live on client_leads). Run after 087. Safe to
-- re-run.

create table if not exists lead_tasks (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references client_leads(id) on delete set null,
  client_id uuid references clients(id) on delete set null,
  kind text not null default 'call',  -- call, text, email, other
  title text not null,
  note text,
  due_at timestamptz not null default now(),
  done_at timestamptz,
  done_by text,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists lead_tasks_open_idx on lead_tasks (done_at, due_at);

do $$
declare p record;
begin
  alter table public.lead_tasks enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'lead_tasks' loop
    execute format('drop policy %I on public.lead_tasks', p.policyname);
  end loop;
  create policy "team only" on public.lead_tasks for all
    using (public.is_allowlisted()) with check (public.is_allowlisted());
end $$;

-- Live updates, so a follow-up added on one screen shows on the others.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lead_tasks') then
    alter publication supabase_realtime add table public.lead_tasks;
  end if;
end $$;
