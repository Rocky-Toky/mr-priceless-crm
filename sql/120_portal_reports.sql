-- Mr Priceless CRM - client portal Reports tab (replaces the Ads tab, Rocky 17 Nov 2026).
-- portal_reports hands a client their own fortnightly reports (the numbers saved
-- when the team made each one, client_reports kind 'mtd') plus lifetime totals
-- worked out from their leads and ads, so the portal can show cost per lead,
-- cost per quote, cost per job won and profit. Only client-safe fields: no notes,
-- no margin %, no management fee. Same access rule as portal_ads (sql/112).
-- Safe to re-run.

create or replace function public.portal_reports(p_client uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare cid uuid := public.portal_client_for(p_client);
begin
  if cid is null then raise exception 'Not allowed'; end if;
  return jsonb_build_object(
    'reports', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', r.id,
        'from', r.period_start,
        'to', r.period_end,
        'made_at', r.created_at,
        'number', r.metrics -> 'report_number',
        'enquiries', r.metrics -> 'enquiries',
        'quotes_booked', coalesce(r.metrics -> 'quoteReady', r.metrics -> 'quotesBooked'),
        'quoted', r.metrics -> 'quoted',
        'jobs', r.metrics -> 'jobsMonth',
        'revenue', r.metrics -> 'revenueMonth',
        'ad_spend', r.metrics -> 'adSpendMonth',
        'revenue_to_date', r.metrics -> 'revenueToDate',
        'invested_to_date', r.metrics -> 'investedToDate',
        'profit_to_date', r.metrics -> 'profitToDate',
        'roi_to_date', r.metrics -> 'roiToDate',
        'ad_spend_to_date', r.metrics -> 'ad_lifetime_spend',
        'summary', r.metrics ->> 'summary',
        'did', r.metrics ->> 'didText',
        'next', array_remove(array[r.metrics ->> 'next1', r.metrics ->> 'next2', r.metrics ->> 'next3'], null)
      ) order by r.period_end desc, r.created_at desc), '[]'::jsonb)
      from client_reports r
      where r.client_id = cid
        and coalesce(r.metrics ->> 'kind', '') = 'mtd'
        and coalesce(r.status, '') <> 'failed'
    ),
    'lifetime', (
      select jsonb_build_object(
        'ad_spend', (select coalesce(sum(a.spend), 0) from client_ad_creatives a where a.client_id = cid),
        'ad_leads', (select coalesce(sum(a.results), 0) from client_ad_creatives a where a.client_id = cid),
        'leads', count(*),
        'quotes', count(*) filter (where l.client_stage in ('quote_sent', 'won') or coalesce(l.quote_amount, 0) > 0),
        'jobs', count(*) filter (where l.client_stage = 'won'),
        'job_value', coalesce(sum(l.job_value) filter (where l.client_stage = 'won'), 0)
      )
      from client_leads l
      where l.client_id = cid
    )
  );
end $$;

revoke all on function public.portal_reports(uuid) from public;
grant execute on function public.portal_reports(uuid) to authenticated;
