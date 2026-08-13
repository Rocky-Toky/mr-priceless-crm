-- Onboarding checklist switched from position-based progress keys ("0_3",
-- "3_1_answer", etc - see the old ONBOARDING_SECTIONS comment in app.js) to
-- stable, explicit keys per step, so the list can be freely reordered without
-- silently un-ticking anyone's progress. This remaps the 3 real clients that
-- had saved progress at the time of the switch (checked live via SQL editor
-- on 2026-08-13) from old keys to their new equivalents. Safe to run once;
-- re-running is a no-op since it replaces onboarding_progress wholesale for
-- exactly these 3 rows.

update clients set onboarding_progress = '{
  "meta_ad_account_id": true,
  "welcome_email": true,
  "fb_page_access": true,
  "launch_creatives": true,
  "open_energy_1": true,
  "open_energy_2": true,
  "honest_expect_1": true,
  "honest_expect_2": true,
  "good_lead_1": true,
  "good_lead_2": true,
  "good_lead_3": true,
  "good_lead_4": true,
  "good_lead_5": true,
  "halfway_ring": true,
  "good_lead_1_answer": "He will every and any job as work is fairly quiet for them right now.",
  "good_lead_2_answer": "Want''s them to have atleast some sort of budget and be somewhat realistic",
  "good_lead_3_answer": "Broad will take on any work now Showers are $5-6k",
  "good_lead_4_answer": "Anything",
  "good_lead_5_answer": "Said the region was on Meta but Basically just Hawkes Bay"
}'::jsonb
where id = 'e2e31826-b4d2-4391-86f0-1b845842d9c7'; -- BB Build

update clients set onboarding_progress = '{
  "book_call": true,
  "welcome_email": true,
  "open_energy_1": true,
  "open_energy_2": true,
  "honest_expect_1": true,
  "honest_expect_2": true,
  "good_lead_1": true,
  "good_lead_2": true,
  "good_lead_3": true,
  "good_lead_4": true,
  "good_lead_5": true,
  "good_lead_6": true,
  "cal_download": true,
  "cal_block_slots": true,
  "demo_1": true,
  "demo_2": true,
  "demo_3": true,
  "demo_4": true,
  "demo_5": true,
  "demo_6": true,
  "crm_login": true,
  "crm_auto_text": true,
  "meta_partner_access": true,
  "cadence_catchup": true,
  "close_1": true,
  "close_2": true
}'::jsonb
where id = 'd5b4866e-c688-4e1d-81b0-f071a3a82cfa'; -- Timber Tech Homes

update clients set onboarding_progress = '{
  "book_call": true,
  "ghl_template": true,
  "welcome_email": true,
  "open_energy_1": true,
  "open_energy_2": true,
  "honest_expect_1": true,
  "honest_expect_2": true,
  "good_lead_1": true,
  "good_lead_2": true,
  "good_lead_3": true,
  "good_lead_4": true,
  "good_lead_5": true,
  "good_lead_6": true,
  "cal_download": true,
  "cal_block_slots": true,
  "demo_1": true,
  "demo_2": true,
  "demo_3": true,
  "demo_4": true,
  "demo_5": true,
  "demo_6": true,
  "crm_login": true,
  "crm_auto_text": true,
  "meta_partner_access": true,
  "cadence_catchup": true,
  "close_1": true,
  "close_2": true
}'::jsonb
where id = '2ab7f562-6d4b-49ab-aaed-272c17b3d5f9'; -- Rubios Pro
