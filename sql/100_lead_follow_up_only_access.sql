-- Mr Priceless CRM - Lead Follow Up only logins. Someone whose allowlist row
-- has access = 'leads' (Carmen) can sign in and use the Lead Follow Up
-- pages, and nothing else: is_allowlisted() leaves them out (sql/066), and
-- this gives them back only what calling needs.
--   read and change: client_leads, lead_tasks
--   read only:       clients, client_ad_creatives, client_campaigns,
--                    lead_sync_status, aircall_calls, aircall_sync_status,
--                    employees, and their own allowlist row
-- Every other table stays team only. Run after 099. Runs after every other migration (the
-- earlier ones re-make their policies on each deploy). Safe to re-run.

alter table public.allowlist add column if not exists access text not null default 'full';

create or replace function public.is_lead_caller()
returns boolean
language sql
stable
security definer
set search_path = public, auth
as $$
  select exists (
    select 1
    from auth.users u
    join public.allowlist a on lower(a.email) = lower(u.email)
    where u.id = auth.uid()
      and u.email_confirmed_at is not null
      and a.access = 'leads'
  );
$$;
revoke all on function public.is_lead_caller() from public;
grant execute on function public.is_lead_caller() to authenticated, anon;

do $$
declare t text;
begin
  foreach t in array array['client_leads', 'lead_tasks'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists "lead callers" on public.%I', t);
    execute format('create policy "lead callers" on public.%I for all using (public.is_lead_caller()) with check (public.is_lead_caller())', t);
  end loop;
  foreach t in array array['clients', 'client_ad_creatives', 'client_campaigns', 'lead_sync_status', 'aircall_calls', 'aircall_sync_status', 'employees'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists "lead callers read" on public.%I', t);
    execute format('create policy "lead callers read" on public.%I for select using (public.is_lead_caller())', t);
  end loop;
  drop policy if exists "lead callers see themselves" on public.allowlist;
  create policy "lead callers see themselves" on public.allowlist for select
    using (public.is_lead_caller() and lower(email) = lower(auth.jwt() ->> 'email'));
end $$;

-- Carmen: Lead Follow Up only.
insert into public.allowlist (email, invited_by, access)
values ('carmen.noche@gmail.com', 'rocky', 'leads')
on conflict (email) do update set access = 'leads';
