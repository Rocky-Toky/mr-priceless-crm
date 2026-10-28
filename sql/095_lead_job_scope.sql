-- Mr Priceless CRM - Lead Follow Up: the scope of work Carmen writes when she
-- books a site visit or consultation call. It's also sent to the client's
-- GoHighLevel "Scope of work" custom field. Run after 094. Safe to re-run.

alter table client_leads add column if not exists job_scope text;
