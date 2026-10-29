-- Mr Priceless CRM - Lead Follow Up: what each client's GoHighLevel key is
-- allowed to read ({ contacts, forms, custom_fields, calendars, checked_at }),
-- checked on every lead sync and when a key is saved. Lead calling setup uses
-- it to say which permissions a key is missing. Run after 097. Safe to re-run.

alter table lead_sync_status add column if not exists access jsonb;
