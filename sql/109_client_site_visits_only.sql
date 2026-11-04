-- Mr Priceless CRM - Lead Follow Up: clients that only do site visits, so the
-- call screen hides the Consultation call button for their leads
-- (clients.lead_site_visits_only). Rocky set A and B Concrete, EJM
-- Contracting and Paradise Painting (4 Nov 2026); only filled where it's
-- still blank, so a change made later is kept. Run after 108. Safe to re-run.

alter table clients add column if not exists lead_site_visits_only boolean;

update clients set lead_site_visits_only = true
where lead_site_visits_only is null
  and (name ilike 'a and b concrete%' or name ilike '%ejm contracting%' or name ilike '%paradise painting%');
