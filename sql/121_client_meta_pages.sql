-- 121: which client Facebook Pages we can read leads from directly (step one
-- of taking GoHighLevel out, 25 Nov 2026). Filled by sync-meta-leads
-- action "client_check": for each client with a Meta ad account, the Page(s)
-- their ads run under, whether our Meta token can read that Page's lead forms,
-- how many forms, and how many leads Meta has had in the last 30 days (to
-- compare with what reached the CRM). Team can read; written by the function.
-- Safe to re-run.
create table if not exists client_meta_pages (
  client_id uuid not null references clients(id) on delete cascade,
  page_id text not null default '',        -- '' = no Page found for their ads
  page_name text,
  can_read boolean not null default false,
  forms int,
  meta_leads_30d int,
  error text,
  checked_at timestamptz not null default now(),
  primary key (client_id, page_id)
);
alter table client_meta_pages enable row level security;
drop policy if exists "team can see" on client_meta_pages;
create policy "team can see" on client_meta_pages for select using (public.is_allowlisted());
select public.portal_lock_tables() as tables_closed_to_client_logins;
