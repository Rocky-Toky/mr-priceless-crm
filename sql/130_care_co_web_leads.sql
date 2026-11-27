-- Mr Priceless CRM - Care Co landing page quote form (Rocky, 28 Nov 2026).
-- Gives Care Co (Care Co Ltd, trading as Home Renovations Auckland) the
-- web_form_key 'care-co' so their landing page (care-co.netlify.app) posts
-- enquiries into their leads through submit_client_lead (sql/124). Run after 124.
-- Safe to re-run: only sets the key when exactly one client is named like
-- "Care Co" or "Home Renovations Auckland", it has no key yet, and no other
-- client uses it.

update clients set web_form_key = 'care-co'
where id = (select id from clients
             where name ilike 'care co%' or name ilike 'careco%' or name ilike '%home renovations auckland%'
             limit 1)
  and (select count(*) from clients
        where name ilike 'care co%' or name ilike 'careco%' or name ilike '%home renovations auckland%') = 1
  and web_form_key is null
  and not exists (select 1 from clients where web_form_key = 'care-co');

-- How many clients matched (a count only, no names), and the clients with a key.
select (select count(*) from clients
         where name ilike 'care co%' or name ilike 'careco%' or name ilike '%home renovations auckland%') as care_co_matches,
       (select json_agg(json_build_object('name', name, 'key', web_form_key)) from clients where web_form_key is not null) as keyed;
