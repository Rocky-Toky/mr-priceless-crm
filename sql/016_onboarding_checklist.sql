-- Mr Priceless CRM - convert Onboarding Process into a tickable checklist
-- ("- [ ] " lines render as interactive checkboxes in the app).
-- Run after 015. Safe to re-run.

update playbooks set content = $pb$## Goal
Get a new client from "signed" to "fully set up and confident in us" as fast as possible. Work through this checklist top to bottom for every new client - tick items off as you go.

## Day 1 - Immediately After Signing
- [ ] Send a welcome email confirming what happens next and the rough timeline.
- [ ] Send the contract/invoice if not already done.
- [ ] Add them to Clients in the CRM with all their details.
- [ ] Create a shared folder/doc for assets (logos, brand guide, login details).

## Week 1 - Collect What You Need
- [ ] Business logo, brand colours, and brand guidelines (if any).
- [ ] Access to ad accounts (Meta Business Manager, Google Ads) or invite as admin.
- [ ] Access to website/CMS if content changes are needed.
- [ ] Existing customer testimonials, photos, or video assets.
- [ ] Key selling points, offers, and target customer description.

## Week 1 - Kickoff Call
- [ ] Confirm goals and what success looks like for them.
- [ ] Walk through the reporting cadence and what they'll receive.
- [ ] Set expectations on timelines (first ads live, first results visible).
- [ ] Confirm main point of contact on both sides.

## Setup
- [ ] Set up ad accounts, tracking (pixel/conversion tracking), and campaigns.
- [ ] Build the first round of ad creative based on brand assets collected.
- [ ] Set up their entry in Clients with a cost-per-lead target and report frequency.

## Week 2 - Launch
- [ ] Get final sign-off on ad creative and targeting before launching.
- [ ] Launch campaigns.
- [ ] Send confirmation that campaigns are live, with what to expect over the next 7 days.

## Ongoing
- [ ] Confirm reporting cadence is firing correctly.
- [ ] Schedule a 2-week check-in call to review early results.
- [ ] Add any open items to Tasks so nothing gets missed.$pb$,
updated_at = now()
where title = 'Onboarding Process';
