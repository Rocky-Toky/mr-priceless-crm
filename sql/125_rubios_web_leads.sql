-- Mr Priceless CRM - Rubios Pro landing page quote form (Rocky, 26 Nov 2026).
-- Gives Rubios Pro the web_form_key 'rubios-pro' so their landing page
-- (rubios-pro.netlify.app) posts enquiries into their leads through
-- submit_client_lead (sql/124). Run after 124. Safe to re-run: only sets the
-- key while the client has none and no other client uses it.

update clients set web_form_key = 'rubios-pro'
where id = '2ab7f562-6d4b-49ab-aaed-272c17b3d5f9' -- Rubios Pro
  and web_form_key is null
  and not exists (select 1 from clients where web_form_key = 'rubios-pro');

select name, web_form_key from clients where web_form_key is not null;
