-- Mr Priceless CRM - Client website leads: the quote forms on the landing
-- pages we build for clients post straight into that client's leads (Rocky,
-- 26 Nov 2026: "quotes should always go into the client portal"). Each client
-- with a landing page gets a web_form_key; the page sends it with the form and
-- submit_client_lead adds the lead to their Call now, which fires the usual
-- new-lead text, email and app alert. First one: A and B Concrete.
-- Run after 123. Safe to re-run.

alter table clients add column if not exists web_form_key text;
create unique index if not exists clients_web_form_key_idx on clients (web_form_key) where web_form_key is not null;

-- A and B Concrete's landing page (ab-concrete.netlify.app). Only set while
-- no client has the key yet, so a later change in the CRM is kept.
update clients set web_form_key = 'ab-concrete'
where id = (select id from clients where name ilike 'a and b concrete%' order by created_at limit 1)
  and web_form_key is null
  and not exists (select 1 from clients where web_form_key = 'ab-concrete');

-- The landing pages call this with the publishable (anon) key.
--   p: { key, name, phone, email, suburb, job, message, page, gclid, fbclid }
create or replace function public.submit_client_lead(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_key text := lower(left(btrim(coalesce(p->>'key', '')), 60));
  v_name text := left(btrim(coalesce(p->>'name', '')), 100);
  v_phone text := left(btrim(coalesce(p->>'phone', '')), 40);
  v_email text := lower(left(btrim(coalesce(p->>'email', '')), 120));
  v_suburb text := nullif(left(btrim(coalesce(p->>'suburb', '')), 80), '');
  v_job text := nullif(left(btrim(coalesce(p->>'job', '')), 80), '');
  v_message text := nullif(left(btrim(coalesce(p->>'message', '')), 2000), '');
  v_page text := nullif(left(btrim(coalesce(p->>'page', '')), 300), '');
  v_gclid text := nullif(left(btrim(coalesce(p->>'gclid', '')), 200), '');
  v_fbclid text := nullif(left(btrim(coalesce(p->>'fbclid', '')), 300), '');
  v_client uuid;
  v_id uuid;
  v_answers jsonb := '[]'::jsonb;
begin
  if v_key = '' then return jsonb_build_object('ok', false, 'error', 'unknown form'); end if;
  select id into v_client from clients where web_form_key = v_key;
  if v_client is null then return jsonb_build_object('ok', false, 'error', 'unknown form'); end if;
  if length(v_name) < 2 or length(regexp_replace(v_phone, '\D', '', 'g')) < 7 then
    return jsonb_build_object('ok', false, 'error', 'name and phone are required');
  end if;
  -- Same person sending twice: keep the first.
  select id into v_id from client_leads
   where client_id = v_client and source = 'website'
     and right(regexp_replace(phone, '\D', '', 'g'), 9) = right(regexp_replace(v_phone, '\D', '', 'g'), 9)
     and created_at > now() - interval '10 minutes'
   limit 1;
  if v_id is not null then return jsonb_build_object('ok', true, 'duplicate', true); end if;
  if (select count(*) from client_leads where client_id = v_client and source = 'website'
       and created_at > now() - interval '1 hour') >= 30 then
    return jsonb_build_object('ok', false, 'error', 'too many leads this hour');
  end if;
  if v_job is not null then v_answers := v_answers || jsonb_build_array(jsonb_build_object('q', 'What job', 'a', v_job)); end if;
  if v_suburb is not null then v_answers := v_answers || jsonb_build_array(jsonb_build_object('q', 'Suburb', 'a', v_suburb)); end if;
  if v_message is not null then v_answers := v_answers || jsonb_build_array(jsonb_build_object('q', 'Anything else', 'a', v_message)); end if;
  v_id := gen_random_uuid();
  insert into client_leads (id, client_id, external_lead_id, source, name, phone, email, status, form_name,
                            answers, city, job_scope, ad_info, details_at, lead_created_at, follow_status)
  values (v_id, v_client, 'web:' || v_id, 'website', v_name, v_phone, case when v_email like '%@%' then v_email else '' end,
          'New lead', 'Website quote form', v_answers, v_suburb, v_job,
          jsonb_strip_nulls(jsonb_build_object('source', case when v_gclid is not null then 'google' when v_fbclid is not null then 'meta' else 'website' end,
                                               'page', v_page, 'gclid', v_gclid, 'fbclid', v_fbclid)),
          now(), now(), 'new');
  return jsonb_build_object('ok', true);
end $$;
revoke all on function public.submit_client_lead(jsonb) from public;
grant execute on function public.submit_client_lead(jsonb) to anon, authenticated;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'portal_lock_tables') then perform public.portal_lock_tables(); end if;
end $$;

select name, web_form_key from clients where web_form_key is not null;
