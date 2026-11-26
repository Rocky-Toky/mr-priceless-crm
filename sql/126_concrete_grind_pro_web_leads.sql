-- Mr Priceless CRM - Concrete Grind Pro landing page quote forms (Rocky, 27 Nov 2026).
-- Gives Concrete Grind Pro the web_form_key 'concrete-grind-pro' so both their
-- landing pages (concrete-grind-pro-polishing.netlify.app and
-- concrete-grind-pro-grind-seal.netlify.app) post enquiries into their leads
-- through submit_client_lead (sql/124). Run after 124. Safe to re-run: only sets
-- the key when exactly one client is called Concrete Grind Pro (or Grindpro),
-- that client has no key yet, and no other client uses it.

update clients set web_form_key = 'concrete-grind-pro'
where id = (select id from clients
             where name ilike 'concrete grind%pro%' or name ilike 'concrete grindpro%'
             order by created_at limit 1)
  and (select count(*) from clients
        where name ilike 'concrete grind%pro%' or name ilike 'concrete grindpro%') = 1
  and web_form_key is null
  and not exists (select 1 from clients where web_form_key = 'concrete-grind-pro');

select name, web_form_key from clients where web_form_key is not null;
