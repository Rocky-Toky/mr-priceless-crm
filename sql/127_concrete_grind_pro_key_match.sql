-- Mr Priceless CRM - Concrete Grind Pro web form key, wider name match (Rocky, 27 Nov 2026).
-- sql/126 found no client named "Concrete Grind Pro", so this matches any one
-- client whose name contains "grind" (e.g. "Concrete Grindpro", "Jay - Grind Pro").
-- Safe to re-run: only sets the key when exactly one client matches, it has no
-- key yet, and no other client uses it.

update clients set web_form_key = 'concrete-grind-pro'
where id = (select id from clients where name ilike '%grind%' limit 1)
  and (select count(*) from clients where name ilike '%grind%') = 1
  and web_form_key is null
  and not exists (select 1 from clients where web_form_key = 'concrete-grind-pro');

-- How many clients matched (a count only, no names), and the clients with a key.
select (select count(*) from clients where name ilike '%grind%') as grind_matches,
       (select json_agg(json_build_object('name', name, 'key', web_form_key)) from clients where web_form_key is not null) as keyed;
