-- Mr Priceless CRM - Paradise Painting landing page quote form (Rocky, 27 Nov 2026).
-- Gives Paradise Painting the web_form_key 'paradise-painting' so their landing page
-- (paradise-painting.netlify.app) posts enquiries into their leads through
-- submit_client_lead (sql/124). Run after 124. Safe to re-run: only sets the key
-- when exactly one client is named like "Paradise Painting", it has no key yet,
-- and no other client uses it.

update clients set web_form_key = 'paradise-painting'
where id = (select id from clients where name ilike '%paradise painting%' limit 1)
  and (select count(*) from clients where name ilike '%paradise painting%') = 1
  and web_form_key is null
  and not exists (select 1 from clients where web_form_key = 'paradise-painting');

select (select count(*) from clients where name ilike '%paradise painting%') as paradise_matches,
       (select json_agg(json_build_object('name', name, 'key', web_form_key)) from clients where web_form_key is not null) as keyed;
