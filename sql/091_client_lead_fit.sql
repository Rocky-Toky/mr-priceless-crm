-- Mr Priceless CRM - Lead Follow Up: "Check it's a fit" per client. Rocky and
-- Max write what makes a good job for each client (one point per line), and
-- Carmen sees it on every lead for that client. Run after 090. Safe to re-run.

alter table clients add column if not exists lead_fit jsonb not null default '[]'::jsonb;
