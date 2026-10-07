-- Mr Priceless CRM - GHL connections for fortnightly finance reports.
-- One row per client: their GHL sub-account (location) ID and a Private
-- Integration key. Row level security is on with NO policies, so the browser
-- can never read the keys - only the ghl-report-data Edge Function (which
-- uses the service role) can. Run after 055. Safe to re-run.

create table if not exists client_ghl (
  client_id uuid primary key references clients(id) on delete cascade,
  location_id text not null,
  token text not null,
  location_name text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table client_ghl enable row level security;
-- Deliberately no policies: service role only.
