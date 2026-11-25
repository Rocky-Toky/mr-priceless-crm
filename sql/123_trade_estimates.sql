-- Mr Priceless CRM - Priceless estimates (Rocky, 26 Nov 2026).
-- Built from a Priceless trade lead in the CRM, sent as a private link
-- (estimate/?t=<token>) the customer opens on their phone, reads, and signs
-- with their finger. Signing marks the lead Won and texts Rocky.
-- The link's token is the only key: the public functions below only ever
-- return / change the one estimate it belongs to. Run after 122. Safe to re-run.

create sequence if not exists trade_estimate_no start 1001;

create table if not exists trade_estimates (
  id uuid primary key default gen_random_uuid(),
  number int not null default nextval('trade_estimate_no'),
  token text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  lead_id uuid,
  business text not null default 'plastering',
  status text not null default 'draft',   -- draft, sent, viewed, signed, declined
  customer_name text,
  customer_phone text,
  customer_email text,
  site_address text,
  title text,                               -- e.g. "Lounge and kitchen plastering"
  intro text,                               -- the scope of work in plain words
  items jsonb not null default '[]',        -- [{ desc, detail, qty, unit, price }] prices before GST
  exclusions text,
  terms text,
  gst_rate numeric not null default 0.15,
  subtotal numeric not null default 0,
  gst numeric not null default 0,
  total numeric not null default 0,
  valid_until date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by text,
  sent_at timestamptz,
  viewed_at timestamptz,
  view_count int not null default 0,
  signed_at timestamptz,
  signed_name text,
  signature text,                           -- the drawn signature (PNG data URL)
  declined_at timestamptz,
  decline_reason text
);
create index if not exists trade_estimates_lead_idx on trade_estimates (lead_id);

do $$
declare p record;
begin
  alter table public.trade_estimates enable row level security;
  for p in select policyname from pg_policies where schemaname = 'public' and tablename = 'trade_estimates' loop
    execute format('drop policy %I on public.trade_estimates', p.policyname);
  end loop;
  create policy "team only" on public.trade_estimates for all using (public.is_allowlisted()) with check (public.is_allowlisted());
end $$;

-- What the customer's link shows: the estimate plus the business's details.
-- Opening it marks it viewed (the CRM shows "Viewed").
create or replace function public.estimate_view(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare e trade_estimates; b trade_businesses;
begin
  if p_token is null or length(p_token) < 32 then return null; end if;
  select * into e from trade_estimates where token = p_token and status <> 'draft';
  if not found then return null; end if;
  update trade_estimates set view_count = view_count + 1,
    viewed_at = coalesce(viewed_at, now()),
    status = case when status = 'sent' then 'viewed' else status end
  where id = e.id;
  select * into b from trade_businesses where key = e.business;
  return jsonb_build_object(
    'number', e.number, 'status', case when e.status = 'sent' then 'viewed' else e.status end,
    'customer_name', e.customer_name, 'site_address', e.site_address,
    'title', e.title, 'intro', e.intro, 'items', e.items, 'exclusions', e.exclusions, 'terms', e.terms,
    'gst_rate', e.gst_rate, 'subtotal', e.subtotal, 'gst', e.gst, 'total', e.total,
    'date', coalesce(e.sent_at, e.created_at), 'valid_until', e.valid_until,
    'expired', e.valid_until is not null and e.valid_until < (now() at time zone 'Pacific/Auckland')::date and e.status not in ('signed', 'declined'),
    'signed_at', e.signed_at, 'signed_name', e.signed_name, 'signature', e.signature,
    'declined_at', e.declined_at,
    'business', jsonb_build_object('name', coalesce(b.name, 'Priceless'), 'legal_name', b.legal_name, 'gst_number', b.gst_number,
      'phone', b.phone, 'email', b.email, 'website', b.website, 'address', b.address)
  );
end $$;

-- The customer accepts: their name and drawn signature. Marks the lead Won
-- and texts Rocky.
create or replace function public.estimate_sign(p_token text, p_name text, p_signature text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare e trade_estimates; v_name text := left(btrim(coalesce(p_name, '')), 100); s record;
begin
  select * into e from trade_estimates where token = p_token and length(coalesce(p_token, '')) >= 32;
  if not found then return jsonb_build_object('ok', false, 'error', 'This estimate link isn''t valid.'); end if;
  if e.status = 'signed' then return jsonb_build_object('ok', true, 'already', true); end if;
  if e.status not in ('sent', 'viewed') then return jsonb_build_object('ok', false, 'error', 'This estimate can''t be signed.'); end if;
  if e.valid_until is not null and e.valid_until < (now() at time zone 'Pacific/Auckland')::date then
    return jsonb_build_object('ok', false, 'error', 'This estimate has expired - please get in touch for an updated one.');
  end if;
  if length(v_name) < 2 then return jsonb_build_object('ok', false, 'error', 'Please type your name.'); end if;
  if p_signature is null or p_signature not like 'data:image/png;base64,%' or length(p_signature) > 300000 then
    return jsonb_build_object('ok', false, 'error', 'Please sign in the box.');
  end if;
  update trade_estimates set status = 'signed', signed_at = now(), signed_name = v_name, signature = p_signature, updated_at = now() where id = e.id;
  if e.lead_id is not null then
    update plastering_leads set status = 'won', updated_at = now(), updated_by = 'Signed the estimate' where id = e.lead_id;
  end if;
  select alert_phone, alerts_on into s from trade_settings where id = 1;
  if s.alert_phone is not null and btrim(s.alert_phone) <> '' and s.alerts_on then
    insert into trade_alerts (lead_id, to_phone, body) values (e.lead_id, s.alert_phone,
      left(v_name || ' just signed estimate #' || e.number || ' (' || coalesce(e.title, 'the job') || ', $'
        || to_char(e.total, 'FM999,999,990.00') || ' incl GST). Open: https://rocky-toky.github.io/mr-priceless-crm/', 600));
    begin
      if exists (select 1 from pg_proc where proname = 'portal_kick') then perform public.portal_kick(); end if;
    exception when others then null;
    end;
  end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.estimate_decline(p_token text, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare e trade_estimates;
begin
  select * into e from trade_estimates where token = p_token and length(coalesce(p_token, '')) >= 32;
  if not found or e.status not in ('sent', 'viewed') then return jsonb_build_object('ok', false); end if;
  update trade_estimates set status = 'declined', declined_at = now(), decline_reason = left(btrim(coalesce(p_reason, '')), 500), updated_at = now() where id = e.id;
  return jsonb_build_object('ok', true);
end $$;

do $$
declare f text;
begin
  foreach f in array array['estimate_view(text)', 'estimate_sign(text, text, text)', 'estimate_decline(text, text)'] loop
    execute format('revoke all on function public.%s from public', f);
    execute format('grant execute on function public.%s to anon, authenticated', f);
  end loop;
end $$;

-- Live updates, so "Viewed" / "Signed" show straight away on an open CRM.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'trade_estimates') then
    alter publication supabase_realtime add table public.trade_estimates;
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_proc where proname = 'portal_lock_tables') then perform public.portal_lock_tables(); end if;
end $$;

select count(*) as estimates, count(*) filter (where status = 'signed') as signed from trade_estimates;
