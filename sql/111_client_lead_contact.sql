-- Mr Priceless CRM - Lead Follow Up: the first name of the person who runs
-- each client's business (clients.lead_contact), shown to Carmen on the call
-- screen ("Calling for BB Build · Brett") and written by Rocky / Max from
-- there. Fills in the two Max gave (6 Nov 2026) for clients that don't have
-- one yet, so changes made in the CRM are never overwritten.
-- Run after 110. Safe to re-run.

alter table clients add column if not exists lead_contact text;

update clients set lead_contact = v.who
from (values
  ('%ritchie building%', 'Mac'),
  ('%bb build%', 'Brett')
) as v(pattern, who)
where clients.name ilike v.pattern and clients.lead_contact is null;
