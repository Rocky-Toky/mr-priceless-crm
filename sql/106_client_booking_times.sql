-- Mr Priceless CRM - Lead Follow Up: when each client likes bookings, shown
-- above the outcome buttons on the call screen (clients.lead_book_times),
-- written by Rocky / Max. Fills in Rocky's list (2 Nov 2026) for clients
-- that don't have one yet, so changes made in the CRM are never overwritten.
-- Run after 105. Safe to re-run.

alter table clients add column if not exists lead_book_times text;

update clients set lead_book_times = v.times
from (values
  ('%bb build%', 'Shown on their calendar'),
  ('%paradise painting%', 'Any day except Sunday'),
  ('%ritchie building%', 'No later than 5:30pm'),
  ('%360 civils%', 'Consultation call ASAP - don''t book a time'),
  ('a and b concrete%', '11am - 12pm preferred. 4 - 5pm if needed. Weekends only if needed.'),
  ('%ejm contracting%', 'Whenever suits them')
) as v(pattern, times)
where clients.name ilike v.pattern and clients.lead_book_times is null;
