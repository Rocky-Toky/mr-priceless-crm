-- Mr Priceless CRM - the client portal test client. NOT a migration: it only
-- runs when someone runs the deploy workflow by hand with
-- seed_test_client=yes (remove deletes it).
--
-- Makes (or resets) "TEST - Portal demo client": a live client that calls its
-- own leads, exactly like a real one, with fake leads at every pipeline stage,
-- times set relative to now (so the 24-hour countdowns, the "Did they get back
-- to you?" check-in, calls due, site visits and quotes to chase are all live),
-- plus a few fake ads. clients.is_test keeps it out of Today, the fortnightly
-- report reminders and our Lead Follow Up call queue. Everything else - the
-- portal, phone alerts, the 5-minute hand-over job - treats it like any client.
-- Running it again wipes its leads and makes fresh ones. Portal logins on it
-- are kept. Fake phone numbers: don't actually ring them.

alter table clients add column if not exists is_test boolean not null default false;

insert into clients (id, name, stage, is_test, lead_client_calls, onboarding_progress, services, website, lead_region,
                     ad_start_date, stage_changed_at, created_at, updated_at, notes)
values ('7e57c11e-0000-4000-8000-000000000001', 'TEST - Portal demo client', 'live', true, true,
        '{"owner": "max"}'::jsonb,
        'Facebook and Instagram ads for driveways and concreting, plus fortnightly reports.',
        'example.com', 'Auckland',
        (now() - interval '60 days')::date, now() - interval '60 days', now() - interval '75 days', now(),
        'Test client for trying the client portal. Fake leads - safe to play with. Reset or remove it from the deploy workflow (seed_test_client).')
on conflict (id) do update set
  name = excluded.name, stage = 'live', is_test = true, lead_client_calls = true,
  onboarding_progress = coalesce(clients.onboarding_progress, '{}'::jsonb) || '{"owner": "max"}'::jsonb,
  services = excluded.services, website = excluded.website, lead_region = excluded.lead_region,
  ad_start_date = excluded.ad_start_date, notes = excluded.notes, updated_at = now();

-- Fresh fake leads (and their alerts).
delete from client_leads where client_id = '7e57c11e-0000-4000-8000-000000000001';
delete from portal_notifications where client_id = '7e57c11e-0000-4000-8000-000000000001' and status = 'pending';

-- Fake ads for the Ads tab.
delete from client_ad_creatives where client_id = '7e57c11e-0000-4000-8000-000000000001';
delete from client_campaigns where client_id = '7e57c11e-0000-4000-8000-000000000001';
insert into client_campaigns (id, client_id, name, platform, status) values
  ('7e57c11e-0000-4000-8000-0000000000c1', '7e57c11e-0000-4000-8000-000000000001', 'Driveways - Auckland', 'Meta', 'active'),
  ('7e57c11e-0000-4000-8000-0000000000c2', '7e57c11e-0000-4000-8000-000000000001', 'Patios & paths', 'Meta', 'paused');
insert into client_ad_creatives (client_id, campaign_id, name, delivery_status, media_type, spend, results, cost_per_result, impressions, clicks, insights_updated_at, meta_ad_id, result) values
  ('7e57c11e-0000-4000-8000-000000000001', '7e57c11e-0000-4000-8000-0000000000c1', 'Driveway before/after - video', 'active', 'video', 1284.50, 46, 27.92, 61200, 1830, now() - interval '5 hours', 'test-ad-1', 'testing'),
  ('7e57c11e-0000-4000-8000-000000000001', '7e57c11e-0000-4000-8000-0000000000c1', 'Exposed aggregate - static', 'learning', 'image', 512.00, 15, 34.13, 22800, 610, now() - interval '5 hours', 'test-ad-2', 'testing'),
  ('7e57c11e-0000-4000-8000-000000000001', '7e57c11e-0000-4000-8000-0000000000c2', 'Patio offer - static', 'paused', 'image', 305.20, 6, 50.87, 14100, 240, now() - interval '5 hours', 'test-ad-3', 'testing');

-- The leads. Answers are shaped the way GoHighLevel sends them.
insert into client_leads (client_id, external_lead_id, source, name, phone, email, form_name, city, address, lead_created_at, created_at,
  answers, ad_info, follow_status, attempts, last_attempt_at, next_attempt_at, booked_for, call_log,
  client_stage, client_stage_at, client_next_at, client_log, quote_amount, quote_sent_at, job_value, lost_reason,
  client_first_na_at, checkin_at, checkin_deadline, checkin_token, handed_over_at, handover_reason, client_seen_at, details_at)
select '7e57c11e-0000-4000-8000-000000000001', 'test-' || x.n, 'test', x.name, x.phone, x.email, x.form, x.city, x.address, x.came, x.came,
  x.answers, x.ad_info, x.fs, x.attempts, x.last_try, x.next_try, x.booked, x.call_log,
  x.stage, x.stage_at, x.next_at, x.client_log, x.quote, x.quote_at, x.job, x.reason,
  x.first_na, x.checkin_at, x.deadline, x.token, x.handed, x.handed_why, x.seen, x.came
from (values
  -- 1. Brand new, hot: call now.
  (1, 'Hemi Walker', '021 000 0101', 'hemi@example.com', 'Driveway quote', 'Albany, Auckland', '12 Kauri Road, Albany', now() - interval '4 minutes',
   '[{"q":"what_type_of_work_do_you_need","a":"Whole driveway replaced"},{"q":"how_big_is_the_area_m2","a":"About 60m2"},{"q":"what_is_your_budget","a":"$15,000 - $20,000"},{"q":"when_are_you_looking_to_start","a":"asap"},{"q":"do_you_own_the_property","a":"Yes"}]'::jsonb,
   '{"ad_id":"test-ad-1","ad":"Driveway before/after - video","campaign":"Driveways - Auckland"}'::jsonb,
   'new', 0, null::timestamptz, null::timestamptz, null::timestamptz, '[]'::jsonb,
   null::text, null::timestamptz, null::timestamptz, '[]'::jsonb, null::numeric, null::timestamptz, null::numeric, null::text,
   null::timestamptz, null::timestamptz, null::timestamptz, null::text, null::timestamptz, null::text, null::timestamptz),
  -- 2. New, warmer timing.
  (2, 'Sarah Lin', '021 000 0102', '', 'Patio enquiry', 'Hamilton East', null, now() - interval '40 minutes',
   '[{"q":"what_type_of_work_do_you_need","a":"New patio out the back"},{"q":"what_is_your_budget","a":"Not sure"},{"q":"when_are_you_looking_to_start","a":"3-6_months"}]'::jsonb,
   '{"ad_id":"test-ad-3","ad":"Patio offer - static","campaign":"Patios & paths"}'::jsonb,
   'new', 0, null, null, null, '[]'::jsonb, null, null, null, '[]'::jsonb, null, null, null, null,
   null, null, null, null, null, null, now() - interval '30 minutes'),
  -- 3. New, came in 20 hours ago: about 4 hours before it goes to Mr Priceless.
  (3, 'Ben Carter', '021 000 0103', 'ben@example.com', 'Driveway quote', 'Takapuna', null, now() - interval '20 hours',
   '[{"q":"what_type_of_work_do_you_need","a":"Resurface the existing driveway"},{"q":"how_big_is_the_area_m2","a":"40m2"},{"q":"what_is_your_budget","a":"$8,000 - $10,000"},{"q":"when_are_you_looking_to_start","a":"Within a month"},{"q":"do_you_own_the_property","a":"Yes"}]'::jsonb,
   '{"ad_id":"test-ad-2","ad":"Exposed aggregate - static"}'::jsonb,
   'new', 0, null, null, null, '[]'::jsonb, null, null, null, '[]'::jsonb, null, null, null, null,
   null, null, null, null, null, null, now() - interval '19 hours'),
  -- 4. Didn't answer 6 hours ago: 18 hours until the check-in.
  (4, 'Jade Kerr', '021 000 0104', '', 'Driveway quote', 'Birkenhead', null, now() - interval '7 hours',
   '[{"q":"what_type_of_work_do_you_need","a":"Driveway and a path to the front door"},{"q":"what_is_your_budget","a":"$15k"},{"q":"when_are_you_looking_to_start","a":"asap"}]'::jsonb,
   '{"ad_id":"test-ad-1","ad":"Driveway before/after - video"}'::jsonb,
   'no_answer', 0, now() - interval '6 hours', null, null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '6 hours', 'by', 'client', 'outcome', 'no_answer', 'note', 'Left a voicemail')),
   'no_answer', now() - interval '6 hours', null, jsonb_build_array(jsonb_build_object('at', now() - interval '6 hours', 'stage', 'no_answer', 'from', 'new', 'note', 'Left a voicemail')),
   null, null, null, null, now() - interval '6 hours', null, null, null, null, null, now() - interval '6 hours'),
  -- 5. Didn't answer 26 hours ago: "Did they get back to you?" is open.
  (5, 'Tom Fraser', '021 000 0105', 'tom@example.com', 'Retaining wall', 'Te Atatu', null, now() - interval '28 hours',
   '[{"q":"what_type_of_work_do_you_need","a":"Retaining wall, about 12m long"},{"q":"what_is_your_budget","a":"$8k"},{"q":"when_are_you_looking_to_start","a":"Next month"}]'::jsonb,
   '{}'::jsonb,
   'no_answer', 0, now() - interval '26 hours', null, null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '26 hours', 'by', 'client', 'outcome', 'no_answer', 'note', '')),
   'no_answer', now() - interval '26 hours', null, jsonb_build_array(jsonb_build_object('at', now() - interval '26 hours', 'stage', 'no_answer', 'from', 'new')),
   null, null, null, null, now() - interval '26 hours', now() - interval '1 hour', now() + interval '5 hours',
   replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), null, null, now() - interval '26 hours'),
  -- 6. Passed to Mr Priceless (they said No to the check-in).
  (6, 'Aroha Pene', '021 000 0106', '', 'Driveway quote', 'Howick', null, now() - interval '2 days',
   '[{"q":"what_type_of_work_do_you_need","a":"New driveway"},{"q":"when_are_you_looking_to_start","a":"Next month"}]'::jsonb,
   '{}'::jsonb,
   'no_answer', 0, now() - interval '47 hours', null, null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '47 hours', 'by', 'client', 'outcome', 'no_answer', 'note', '')),
   'no_answer', now() - interval '47 hours', null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '47 hours', 'stage', 'no_answer', 'from', 'new'), jsonb_build_object('at', now() - interval '3 hours', 'note', 'Passed to Mr Priceless to follow up')),
   null, null, null, null, now() - interval '47 hours', now() - interval '23 hours', now() - interval '3 hours', null, now() - interval '3 hours', 'client_no', now() - interval '47 hours'),
  -- 7. Call scheduled in 40 minutes (shows under Call now, call-due alert).
  (7, 'Liam Brooks', '021 000 0107', '', 'Driveway quote', 'Glenfield', null, now() - interval '5 hours',
   '[{"q":"what_type_of_work_do_you_need","a":"Double driveway, exposed aggregate"},{"q":"what_is_your_budget","a":"$20,000+"},{"q":"when_are_you_looking_to_start","a":"Within a month"}]'::jsonb,
   '{"ad_id":"test-ad-2","ad":"Exposed aggregate - static"}'::jsonb,
   'call_back', 0, now() - interval '4 hours', now() + interval '40 minutes', null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '4 hours', 'by', 'client', 'outcome', 'call_back', 'note', 'At work, ring after lunch', 'when', now() + interval '40 minutes')),
   'call_scheduled', now() - interval '4 hours', now() + interval '40 minutes',
   jsonb_build_array(jsonb_build_object('at', now() - interval '4 hours', 'stage', 'call_scheduled', 'from', 'new', 'note', 'At work, ring after lunch', 'when', now() + interval '40 minutes')),
   null, null, null, null, null, null, null, null, null, null, now() - interval '4 hours'),
  -- 8. Call scheduled tomorrow.
  (8, 'Priya Nair', '021 000 0108', '', 'Paths', 'Mt Albert', null, now() - interval '1 day',
   '[{"q":"what_type_of_work_do_you_need","a":"Concrete path around the house"},{"q":"how_big_is_the_area_m2","a":"25m2"}]'::jsonb,
   '{}'::jsonb,
   'call_back', 0, now() - interval '20 hours', (((now() at time zone 'Pacific/Auckland')::date + 1) + time '10:00') at time zone 'Pacific/Auckland', null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '20 hours', 'by', 'client', 'outcome', 'call_back', 'note', 'Wants to talk to her partner first')),
   'call_scheduled', now() - interval '20 hours', (((now() at time zone 'Pacific/Auckland')::date + 1) + time '10:00') at time zone 'Pacific/Auckland',
   jsonb_build_array(jsonb_build_object('at', now() - interval '20 hours', 'stage', 'call_scheduled', 'from', 'new', 'note', 'Wants to talk to her partner first')),
   null, null, null, null, null, null, null, null, null, null, now() - interval '20 hours'),
  -- 9. Site visit tomorrow.
  (9, 'Mike Doyle', '021 000 0109', 'mike@example.com', 'Driveway quote', 'Albany', '4 Rata Street, Albany', now() - interval '2 days',
   '[{"q":"what_type_of_work_do_you_need","a":"Driveway replacement"},{"q":"how_big_is_the_area_m2","a":"40m2"},{"q":"what_is_your_budget","a":"$12k"}]'::jsonb,
   '{"ad_id":"test-ad-1","ad":"Driveway before/after - video"}'::jsonb,
   'site_visit', 0, now() - interval '47 hours', null, (((now() at time zone 'Pacific/Auckland')::date + 1) + time '14:00') at time zone 'Pacific/Auckland',
   jsonb_build_array(jsonb_build_object('at', now() - interval '47 hours', 'by', 'client', 'outcome', 'site_visit', 'note', 'Wants exposed aggregate', 'when', (((now() at time zone 'Pacific/Auckland')::date + 1) + time '14:00') at time zone 'Pacific/Auckland')),
   'site_visit', now() - interval '47 hours', (((now() at time zone 'Pacific/Auckland')::date + 1) + time '14:00') at time zone 'Pacific/Auckland',
   jsonb_build_array(jsonb_build_object('at', now() - interval '47 hours', 'stage', 'site_visit', 'from', 'new', 'note', 'Wants exposed aggregate', 'when', (((now() at time zone 'Pacific/Auckland')::date + 1) + time '14:00') at time zone 'Pacific/Auckland')),
   null, null, null, null, null, null, null, null, null, null, now() - interval '47 hours'),
  -- 10. Site visit done 2 days ago: quote them.
  (10, 'Grace Tane', '021 000 0110', '', 'Driveway quote', 'Remuera', '18 Victoria Avenue, Remuera', now() - interval '6 days',
   '[{"q":"what_type_of_work_do_you_need","a":"Driveway plus a parking pad"},{"q":"what_is_your_budget","a":"$25,000"}]'::jsonb,
   '{}'::jsonb,
   'site_visit', 0, now() - interval '5 days', null, now() - interval '2 days',
   jsonb_build_array(jsonb_build_object('at', now() - interval '5 days', 'by', 'client', 'outcome', 'site_visit', 'note', '', 'when', now() - interval '2 days')),
   'site_visit', now() - interval '5 days', now() - interval '2 days',
   jsonb_build_array(jsonb_build_object('at', now() - interval '5 days', 'stage', 'site_visit', 'from', 'new', 'when', now() - interval '2 days')),
   null, null, null, null, null, null, null, null, null, null, now() - interval '5 days'),
  -- 11. Quote to send.
  (11, 'Kate Moore', '021 000 0111', 'kate@example.com', 'Driveway quote', 'Glenfield', null, now() - interval '8 days',
   '[{"q":"what_type_of_work_do_you_need","a":"Driveway and turning bay"},{"q":"what_is_your_budget","a":"$20,000+"}]'::jsonb,
   '{}'::jsonb,
   'booked', 0, now() - interval '7 days', null, now() - interval '3 days', '[]'::jsonb,
   'quote_to_send', now() - interval '2 days', null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '7 days', 'stage', 'site_visit', 'from', 'new'), jsonb_build_object('at', now() - interval '2 days', 'stage', 'quote_to_send', 'from', 'site_visit')),
   null, null, null, null, null, null, null, null, null, null, now() - interval '7 days'),
  -- 12. Quote sent 4 days ago, nothing since: chase it.
  (12, 'Raj Patel', '021 000 0112', '', 'Patio enquiry', 'Takapuna', null, now() - interval '10 days',
   '[{"q":"what_type_of_work_do_you_need","a":"Patio and steps"},{"q":"what_is_your_budget","a":"$10k"}]'::jsonb,
   '{"ad_id":"test-ad-3","ad":"Patio offer - static"}'::jsonb,
   'booked', 0, now() - interval '9 days', null, now() - interval '7 days', '[]'::jsonb,
   'quote_sent', now() - interval '4 days', null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '9 days', 'stage', 'site_visit', 'from', 'new'), jsonb_build_object('at', now() - interval '4 days', 'stage', 'quote_sent', 'from', 'site_visit', 'amount', 12400)),
   12400, now() - interval '4 days', null, null, null, null, null, null, null, null, now() - interval '9 days'),
  -- 13. Quote sent yesterday.
  (13, 'Emma Walsh', '021 000 0113', 'emma@example.com', 'Driveway quote', 'Ponsonby', null, now() - interval '9 days',
   '[{"q":"what_type_of_work_do_you_need","a":"Small driveway"},{"q":"what_is_your_budget","a":"$8,000 - $10,000"}]'::jsonb,
   '{}'::jsonb,
   'booked', 0, now() - interval '8 days', null, now() - interval '5 days', '[]'::jsonb,
   'quote_sent', now() - interval '1 day', null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '8 days', 'stage', 'site_visit', 'from', 'new'), jsonb_build_object('at', now() - interval '1 day', 'stage', 'quote_sent', 'from', 'site_visit', 'amount', 8900)),
   8900, now() - interval '1 day', null, null, null, null, null, null, null, null, now() - interval '8 days'),
  -- 14. Job won this month.
  (14, 'Lisa Brown', '021 000 0114', '', 'Driveway quote', 'Albany', null, now() - interval '12 days',
   '[{"q":"what_type_of_work_do_you_need","a":"Driveway"},{"q":"what_is_your_budget","a":"$15k"}]'::jsonb,
   '{"ad_id":"test-ad-1","ad":"Driveway before/after - video"}'::jsonb,
   'booked', 0, now() - interval '11 days', null, now() - interval '9 days', '[]'::jsonb,
   'won', now() - interval '2 days', null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '11 days', 'stage', 'site_visit', 'from', 'new'), jsonb_build_object('at', now() - interval '7 days', 'stage', 'quote_sent', 'from', 'site_visit', 'amount', 14200), jsonb_build_object('at', now() - interval '2 days', 'stage', 'won', 'from', 'quote_sent', 'amount', 14200)),
   14200, now() - interval '7 days', 14200, null, null, null, null, null, null, null, now() - interval '11 days'),
  -- 15. Job won last month.
  (15, 'Sam Ruiz', '021 000 0115', '', 'Paths', 'Devonport', null, now() - interval '35 days',
   '[{"q":"what_type_of_work_do_you_need","a":"Garden paths"}]'::jsonb,
   '{}'::jsonb,
   'booked', 0, now() - interval '34 days', null, now() - interval '32 days', '[]'::jsonb,
   'won', now() - interval '25 days', null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '34 days', 'stage', 'site_visit', 'from', 'new'), jsonb_build_object('at', now() - interval '25 days', 'stage', 'won', 'from', 'quote_sent', 'amount', 6500)),
   6500, now() - interval '30 days', 6500, null, null, null, null, null, null, null, now() - interval '34 days'),
  -- 16. Job lost.
  (16, 'Grant Ellis', '021 000 0116', '', 'Patio enquiry', 'Mt Eden', null, now() - interval '14 days',
   '[{"q":"what_type_of_work_do_you_need","a":"Patio"},{"q":"what_is_your_budget","a":"$5k"}]'::jsonb,
   '{}'::jsonb,
   'booked', 0, now() - interval '13 days', null, null, '[]'::jsonb,
   'lost', now() - interval '3 days', null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '10 days', 'stage', 'quote_sent', 'from', 'site_visit', 'amount', 5600), jsonb_build_object('at', now() - interval '3 days', 'stage', 'lost', 'from', 'quote_sent', 'reason', 'Went with someone else')),
   5600, now() - interval '10 days', null, 'Went with someone else', null, null, null, null, null, null, now() - interval '13 days'),
  -- 17. Not qualified.
  (17, 'Chris Hall', '021 000 0117', '', 'Driveway quote', 'Whangarei', null, now() - interval '4 days',
   '[{"q":"what_type_of_work_do_you_need","a":"Fix a crack in the driveway"},{"q":"what_is_your_budget","a":"$500"}]'::jsonb,
   '{}'::jsonb,
   'disqualified', 0, now() - interval '4 days', null, null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '4 days', 'by', 'client', 'outcome', 'disqualified', 'note', 'Too small, and out of our area')),
   'not_qualified', now() - interval '4 days', null,
   jsonb_build_array(jsonb_build_object('at', now() - interval '4 days', 'stage', 'not_qualified', 'from', 'new', 'reason', 'Out of our area', 'note', 'Too small, and out of our area')),
   null, null, null, 'Out of our area', null, null, null, null, null, null, now() - interval '4 days')
) as x(n, name, phone, email, form, city, address, came, answers, ad_info, fs, attempts, last_try, next_try, booked, call_log,
       stage, stage_at, next_at, client_log, quote, quote_at, job, reason, first_na, checkin_at, deadline, token, handed, handed_why, seen);

-- For the log: how many fake leads at each stage (no names).
select coalesce(client_stage, 'new') as stage, count(*) from client_leads
where client_id = '7e57c11e-0000-4000-8000-000000000001' group by 1 order by 1;
