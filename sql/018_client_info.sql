-- Mr Priceless CRM - Client Info (retention / customer journey fields)
-- Run after 017. Safe to re-run.

alter table clients add column if not exists services text;
alter table clients add column if not exists client_rules text;
alter table clients add column if not exists qualified_lead_structure text;
alter table clients add column if not exists branding_expectations text;
alter table clients add column if not exists key_contacts text;
alter table clients add column if not exists communication_preferences text;
alter table clients add column if not exists renewal_date date;
