-- Mr Priceless CRM - Lead Follow Up: clients whose GoHighLevel books
-- consultation calls through the site visit stage and calendar (their
-- automation runs from that booking). For them the call screen's site visit
-- button reads "Consultation call booked" and the separate consultation button
-- is hidden. BB Build is set once; a value already set is left alone. Run
-- after 098. Safe to re-run.

alter table clients add column if not exists lead_visit_is_consult boolean;

update clients set lead_visit_is_consult = true
where lead_visit_is_consult is null and name ilike '%bb build%';
