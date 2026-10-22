-- Mr Priceless CRM - payment reminders. The CRM queues an email in
-- scheduled_emails the day before and the morning each client's payment is
-- due (kind 'billing_reminder', record_id '<client>:<payment>:<before|day>').
-- One row per reminder, even if two of us have the CRM open at once.
-- Run after 075. Safe to re-run.

create unique index if not exists scheduled_emails_reminder_idx
  on scheduled_emails (record_id) where kind = 'billing_reminder';
