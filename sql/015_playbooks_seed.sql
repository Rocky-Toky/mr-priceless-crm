-- Mr Priceless CRM - seed the four core playbooks.
-- Run after 014. Safe to re-run - replaces any existing rows with these exact
-- titles so re-running doesn't create duplicates.

delete from playbooks where title in ('Cold Calling Script', 'Meetings to Close', 'Onboarding Process', 'Service Delivery - Ads');

insert into playbooks (title, content, sort_order) values
('Cold Calling Script', $pb1$## Goal
Book a qualified meeting - not sell on the phone.

## Opening (First 10 Seconds)
1. Introduce yourself and the business in one breath.
2. State the reason for the call - be direct, not salesy.
3. Ask a permission-based question to keep them on the line.

## The Script
"Hi [Name], this is [Your Name] calling from [Business]. The reason for my call - we help [industry] businesses [core outcome]. Do you have 30 seconds while I explain why I'm calling?"

## Qualifying Questions
- Are you currently running any paid ads or marketing?
- What's working, and what isn't?
- Who handles this for you right now?

## Handling Objections
**"I'm not interested"** - Totally understand, most people say that before they've heard what it actually is. Can I take 20 seconds to explain, then you can tell me to get lost?

**"Send me an email"** - Happy to, but most people don't get round to reading it. Can we lock in 10 minutes so I can walk you through it properly instead?

**"We already have someone doing this"** - Good to hear - out of curiosity, are you happy with the results, or open to a second opinion?

## Closing for the Meeting
1. Suggest two specific times ("Would Tuesday 10am or Wednesday 2pm work better?").
2. Confirm the best contact number and email.
3. Send the calendar invite immediately after the call, while they're still warm.

## After the Call
- Log the outcome in the Dialer straight away.
- If no answer, schedule a follow-up call for 2-3 days later.$pb1$, 0),

('Meetings to Close', $pb2$## Goal
Turn the booked meeting into a signed client - not just a nice chat.

## Before the Meeting
- Check their website, socials, and current ads (if any).
- Note 2-3 specific things you'd improve for them.
- Have pricing and case studies ready to share.

## Meeting Agenda
1. Rapport (2 min) - light, genuine, not scripted small talk.
2. Context (3 min) - confirm what you already know about their business.
3. Discovery (10 min) - uncover their real pain points.
4. Present the offer (10 min) - tailored to what you just heard, not a generic pitch.
5. Handle objections (5 min).
6. Close (5 min) - ask for the business directly.

## Discovery Questions
- What's your biggest bottleneck for growth right now?
- What have you tried before, and how did it go?
- If this problem was solved, what would that be worth to you?
- What's stopping you from doing this already?

## Presenting the Offer
- Anchor to the pain point they just told you about - not a generic feature list.
- Show 1-2 relevant results or case studies.
- Present pricing clearly and confidently - don't apologise for the price.

## Handling Objections
**"It's too expensive"** - Compared to what? Let's look at what it's costing you to not solve this.

**"I need to think about it"** - Of course - what specifically do you need to think through? Let's talk it through now while it's fresh.

**"I need to check with my partner/team"** - Makes sense. Can we get them on a quick call before we finish up today?

## Closing
1. Ask directly - "Does this make sense to move forward with?"
2. If yes, send the contract or invoice before the call ends if possible.
3. If not yet, agree a specific next step and date, not a vague "I'll follow up."

## After the Meeting
- Send a follow-up summary within 1 hour, even if they said yes.
- Log the outcome and next step in Deals.
- If they went cold, add a follow-up task for 3-5 days later.$pb2$, 1),

('Onboarding Process', $pb3$## Goal
Get a new client from "signed" to "fully set up and confident in us" as fast as possible.

## Day 1 - Immediately After Signing
1. Send a welcome email confirming what happens next and the rough timeline.
2. Send the contract/invoice if not already done.
3. Add them to Clients in the CRM with all their details.
4. Create a shared folder/doc for assets (logos, brand guide, login details).

## Week 1 - Collect What You Need
- Business logo, brand colours, and brand guidelines (if any).
- Access to ad accounts (Meta Business Manager, Google Ads) or invite as admin.
- Access to website/CMS if content changes are needed.
- Existing customer testimonials, photos, or video assets.
- Key selling points, offers, and target customer description.

## Week 1 - Kickoff Call
1. Confirm goals and what success looks like for them.
2. Walk through the reporting cadence and what they'll receive.
3. Set expectations on timelines (first ads live, first results visible).
4. Confirm main point of contact on both sides.

## Setup
- Set up ad accounts, tracking (pixel/conversion tracking), and campaigns.
- Build the first round of ad creative based on brand assets collected.
- Set up their entry in Clients with a cost-per-lead target and report frequency.

## Week 2 - Launch
1. Get final sign-off on ad creative and targeting before launching.
2. Launch campaigns.
3. Send confirmation that campaigns are live, with what to expect over the next 7 days.

## Ongoing
- Confirm reporting cadence is firing correctly.
- Schedule a 2-week check-in call to review early results.
- Add any open items to Tasks so nothing gets missed.$pb3$, 2),

('Service Delivery - Ads', $pb4$## Goal
A single reference for everything needed to run and manage a client's ads properly.

## Access Checklist
- Meta Business Manager - added as Partner/Admin on the ad account.
- Google Ads - added as Manager/Standard access.
- Pixel/conversion tracking installed and verified on their website.
- Access to their brand assets (logo, colours, fonts, photos/video).

## Campaign Setup Basics
- Objective matches their actual goal (leads, calls, bookings - not just "awareness").
- Budget matches their cost-per-lead target from Clients.
- Location/audience targeting matches their real service area.
- Tracking is confirmed working with a test conversion before spending real budget.

## Creative Guidelines
- Lead with the outcome/benefit, not the business name.
- Always include a clear call to action (Call Now, Book Now, Get a Quote).
- Use real photos/video where possible - avoid generic stock imagery.
- Keep it on-brand: their colours, tone, and logo where relevant.
- Test at least 2-3 creative variations per campaign.

## Copy Checklist
- Headline states the outcome clearly in under 6 words if possible.
- Primary text addresses a specific pain point or objection.
- Include social proof (reviews, results, "trusted by X clients") where available.
- Always end with a direct, low-friction call to action.

## Ongoing Management
- Check performance at least every 2-3 days for the first 2 weeks of a new campaign.
- Pause underperforming ads early - don't wait a full week if something isn't working.
- Log ad results in Ad Creatives (winner/testing/killed) so history is tracked.
- Never let a campaign run untouched for more than 7 days.

## Reporting
- Confirm report frequency and format matches what's set in Clients.
- Reports should always include spend, results, cost-per-result, and a plain-English summary.
- Flag any issues (rising costs, tracking problems) proactively - don't wait to be asked.$pb4$, 3);
