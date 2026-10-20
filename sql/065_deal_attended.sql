-- Mr Priceless CRM - whether a deal's first meeting actually happened.
-- Asked when a deal goes Disqualified, Ghosted or Closed Lost, so the sit
-- rate knows if that meeting was sat. Null = not answered yet.
-- Run after 064. Safe to re-run.

alter table deals add column if not exists attended_meeting boolean;
