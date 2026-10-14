-- Mr Priceless CRM - October tidy-up. Run after 059. Safe to re-run.
--
-- 1. Prospecting ticks: make sure the completed_verticals table (sql/054)
--    exists on the live project, so ticking a region or vertical saves.
create table if not exists completed_verticals (
  id uuid primary key default gen_random_uuid(),
  region text not null,
  industry text not null,
  completed_at timestamptz not null default now(),
  completed_by text,
  unique(region, industry)
);
alter table completed_verticals enable row level security;
drop policy if exists "allowlisted full access" on completed_verticals;
create policy "allowlisted full access" on completed_verticals
  for all
  using (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'))
  with check (exists (select 1 from allowlist a where a.email = auth.jwt() ->> 'email'));
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'completed_verticals') then
    alter publication supabase_realtime add table completed_verticals;
  end if;
end $$;

-- 2. Email templates are split into Sales and Delivery.
alter table email_templates add column if not exists kind text;

-- 3. One-off: every deal sitting in Meeting Booked or No Show is set to
--    $1500. Runs once only, so values changed by hand later are kept.
create table if not exists crm_migrations (key text primary key, ran_at timestamptz not null default now());
alter table crm_migrations enable row level security;
do $$ begin
  if not exists (select 1 from crm_migrations where key = '060_meeting_deal_values') then
    update deals set value = 1500 where stage in ('qualified', 'no_show');
    insert into crm_migrations (key) values ('060_meeting_deal_values');
  end if;
end $$;

-- 4. Thor, Gabriel and Randy can no longer sign in. Only their allowlist
--    rows go - their names, calls, deals and notes all stay.
delete from allowlist
where lower(email) in (
  'thrkamhadi810@gmail.com',
  'gabriel.irvan@mrpriceless.com',
  'raheem.raza.khawaja@gmail.com'
)
returning email;
