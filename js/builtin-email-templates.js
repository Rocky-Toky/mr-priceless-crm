/* Mr Priceless CRM - email templates that ship with the app.
   app.js adds any of these to the shared Email Templates table the first
   time a signed-in user loads the CRM and a template with that title isn't
   there yet. Once added they're ordinary templates: edit them in the app.
   Titles are "Group · Name" - the Email Templates page groups by the part
   before the dot. Swap the [square bracket] bits before sending. */
window.MP_BUILTIN_EMAIL_TEMPLATES = [

/* ───────── Onboarding ───────── */
{ title: "Onboarding · Welcome to Mr Priceless", kind: "onboarding_pre", sort_order: 100,
  subject: "Welcome to Mr Priceless, [First name] - here's what happens next",
  body: `Hi [First name],

Stoked to have [Business] on board. Here's exactly what happens over the next couple of weeks, so nothing's a surprise.

1. Kickoff call (this week)
We'll book a 45-minute call to get to know the business properly - the jobs you want more of, your area, your pricing and what a good lead looks like for you. Grab a time here: [booking link]

2. What we need from you before the call
- Access to your Facebook page and ad account (we'll send a quick guide)
- Some before and after photos of your best jobs, plus one of you and one of the team
- Your average job value and roughly how many jobs you can take on each month

3. Your CRM
We'll set up your CRM so every lead lands in one place, gets a call from us within minutes, and books straight into your calendar. We'll walk you through it on the call.

4. Ads go live
Once we've got the creative sorted, your ads go live - usually within 10 to 14 days of today. From there, you'll get a report from us every fortnight showing exactly what's coming in.

And remember: you're covered by our 10 Quote Guarantee. You don't pay a cent until we've delivered 10 quotes.

Your welcome pack is attached with all of this in one place. Any questions at all, just reply or give me a call on [your number].

Cheers,
[Your name]
Mr Priceless` },

/* ───────── Pre-onboarding: signed, before the kickoff call ───────── */
{ title: "Pre-onboarding · Your kickoff call is booked", kind: "onboarding_pre", sort_order: 110,
  subject: "You're booked in, [First name] - kickoff on [Date]",
  body: `Hi [First name],

You're all locked in for your kickoff call on [Date] at [Time]. Here's the link: [meeting link]

It takes about 45 minutes. We'll go through the jobs you want more of, the areas you cover, your pricing and what a good lead looks like for you - so the ads bring in the right work from day one.

If anything comes up and you need to move it, just reply here and we'll find another time.

Cheers,
[Your name]
Mr Priceless` },
{ title: "Pre-onboarding · What we need before we start", kind: "onboarding_pre", sort_order: 120,
  subject: "A few quick things before your kickoff, [First name]",
  body: `Hi [First name],

To hit the ground running on [Date], could you send these through before the call?

- Access to your Facebook page and ad account (reply and we'll send a 2-minute guide)
- 5 to 10 photos of your best jobs - before and afters are gold
- A photo of you, and one of the team if you've got one
- Your average job value and how many jobs you can take on each month
- The areas you want work from

Don't stress if you can't get it all - send what you have and we'll sort the rest on the call.

Cheers,
[Your name]
Mr Priceless` },

/* ───────── Post-onboarding: after the kickoff call ───────── */
{ title: "Post-onboarding · Recap from our kickoff call", kind: "onboarding_post", sort_order: 150,
  subject: "Recap from today, [First name] - here's the plan",
  body: `Hi [First name],

Great chatting today. Here's what we agreed, so we're on the same page:

- The jobs we're going after: [jobs]
- Areas: [areas]
- A good lead for you is: [good lead]
- Ads go live by: [Date]

What we're doing next: writing your ads, building your campaign and setting up your CRM so every lead gets a call within minutes.

What we still need from you: [anything outstanding]

Any questions in the meantime, just reply or call me on [your number].

Cheers,
[Your name]
Mr Priceless` },
{ title: "Post-onboarding · Your ads are live", kind: "onboarding_post", sort_order: 160,
  subject: "We're live, [First name]!",
  body: `Hi [First name],

Your ads went live today. Leads will start coming through over the next few days, and every one gets a call from us within minutes to book you in.

A couple of things that make a big difference:
- Pick up when we put a booking in your calendar, and turn up on time - it's what turns leads into jobs
- Let us know straight away if a lead isn't right for you, so we can tighten things up

You'll get your first report from us in two weeks showing exactly what's come in.

Cheers,
[Your name]
Mr Priceless` },
{ title: "Post-onboarding · First week check-in", kind: "onboarding_post", sort_order: 170,
  subject: "How's the first week been, [First name]?",
  body: `Hi [First name],

You've been live for a week now, so a quick check-in.

So far we've had [number] leads come through and booked [number] quotes for you.

How have they been? Are they the kind of jobs you want, in the right areas? Anything you'd like more or less of, just tell me and we'll adjust the ads.

Cheers,
[Your name]
Mr Priceless` },

/* ───────── Lead nurture: tradies who ghosted or went closed-lost ─────────
   One every ~14 days for 6 months. Short, useful, never pushy. */
{ title: "Lead nurture · 1. Day 0 - No pressure check-in", sort_order: 200,
  subject: "No pressure, [First name]",
  body: `Hi [First name],

I know things got busy after we chatted, so no stress at all.

I'll send through the odd thing that's actually useful for trade businesses over the next few months - stuff we see working for the tradies we work with. No spam, and if it's not for you, just reply "stop" and I'll leave you alone.

If anything changes and you want more quotes coming in, I'm a message away.

Cheers,
[Your name]
Mr Priceless` },

{ title: "Lead nurture · 2. Day 14 - The 3-minute rule", sort_order: 201,
  subject: "The 3-minute rule most tradies miss",
  body: `Hi [First name],

Quick one. The business that gets back to a new enquiry first wins the job most of the time. Not the cheapest - the fastest.

Calling within 3 minutes makes it far more likely you'll book the quote than calling an hour later. Trouble is, you're on the tools, so you can't.

A couple of easy fixes:
- Set an auto-text that replies to every missed call ("On a job, will call you back within the hour - what are you after?")
- Block 15 minutes at lunch and at 4pm to call every enquiry back

That's actually why we call every one of our clients' leads within 3 minutes for them.

Cheers,
[Your name]` },

{ title: "Lead nurture · 3. Day 28 - Google reviews script", sort_order: 202,
  subject: "The text that gets you 5-star reviews",
  body: `Hi [First name],

Reviews are free marketing, and most people are happy to leave one - they just need asking at the right moment.

The best time is the day you finish, while they're stoked with the job. Here's a text you can copy:

"Hi [customer name], thanks again for having us. If you're happy with how it turned out, would you mind leaving us a quick review? It really helps a small business like ours: [your Google review link]"

Send it to your last 10 happy customers this week and you'll be surprised how many come back.

Cheers,
[Your name]` },

{ title: "Lead nurture · 4. Day 42 - What changed for a builder like you", sort_order: 203,
  subject: "From 4 quotes a month to 11",
  body: `Hi [First name],

Thought you'd find this one interesting. One of the builders we work with was getting about 4 quotes a month, mostly word of mouth. Great work, but feast or famine.

What we changed:
- Ads showing his real jobs (no stock photos)
- Every lead called within 3 minutes
- Quotes booked straight into his calendar

Within 8 weeks he was on 11 quotes a month and booked out further ahead than ever.

Not saying that's guaranteed for everyone - but if steadier work sounds good, happy to show you what it'd look like for [Business].

Cheers,
[Your name]` },

{ title: "Lead nurture · 5. Day 56 - Plan for the quiet months", sort_order: 204,
  subject: "Don't let the quiet months sneak up on you",
  body: `Hi [First name],

Most trades have a slow patch every year, and the mistake is waiting until it hits before doing anything about it. Marketing takes a few weeks to build momentum, so by the time it's quiet, you're already behind.

Worth jotting down:
- Which months were slowest last year?
- What jobs could you push in those months? (maintenance, smaller jobs, repeat customers)
- Who could you get back in touch with now?

If you'd like, I can run through what that looks like for your area - no strings.

Cheers,
[Your name]` },

{ title: "Lead nurture · 6. Day 70 - The follow-up most tradies skip", sort_order: 205,
  subject: "The quotes you've already sent are worth money",
  body: `Hi [First name],

Here's one most tradies leave on the table: following up quotes.

People don't say no - they just get busy and forget. A quick follow-up 3 days after sending a quote, and again a week later, wins back a surprising number of jobs.

Something as simple as:
"Hi [name], just checking you got the quote through OK and whether you had any questions. Happy to tweak anything."

Go through your quotes from the last month this week. You might find a few jobs sitting there waiting.

Cheers,
[Your name]` },

{ title: "Lead nurture · 7. Day 84 - Photos that win jobs", sort_order: 206,
  subject: "Your phone is your best marketing tool",
  body: `Hi [First name],

The ads that work best for tradies aren't fancy - they're real photos and short videos from real jobs.

Next time you're on site, grab:
- A before and after from the same angle
- A 15-second walk-through of the finished job
- You or the team at work (people hire people)

Keep them in one album on your phone. Even if you never work with us, they'll help on your Facebook page, website and Google profile.

Cheers,
[Your name]` },

{ title: "Lead nurture · 8. Day 98 - Price with confidence", sort_order: 207,
  subject: "Are your jobs actually making you money?",
  body: `Hi [First name],

Something we see a lot: tradies flat out busy, but not much left at the end of the month. Usually it comes down to a few jobs being underpriced.

A quick check:
- What's your average job worth?
- After materials, labour and travel, what's left?
- Which type of job makes you the most per hour?

More of the right jobs beats more jobs. When we work with someone, we only push the work that's worth their time.

Cheers,
[Your name]` },

{ title: "Lead nurture · 9. Day 112 - The 10 Quote Guarantee", sort_order: 208,
  subject: "You don't pay until you get 10 quotes",
  body: `Hi [First name],

In case it got lost when we last spoke - here's how we work.

You don't pay us anything until we've delivered 10 quotes for [Business]. If we can't get you real quotes, you don't pay. Simple as that.

After that it's month to month, no lock-in contracts. If we're not earning our keep, you walk.

If that takes the risk out of it, I'd love to have another chat.

Cheers,
[Your name]` },

{ title: "Lead nurture · 10. Day 126 - Get ahead of busy season", sort_order: 209,
  subject: "Busy season is coming - are you booked?",
  body: `Hi [First name],

Busy season's not far off. The tradies who do best are the ones booked out before it starts, not scrambling once it's here.

If you want to fill the calendar early this year, now's the time to get the ads warmed up - it gives us a few weeks to find what works in your area before the rush.

Want me to pull together what we'd do for [Business]? Takes 15 minutes on the phone.

Cheers,
[Your name]` },

{ title: "Lead nurture · 11. Day 140 - One quick question", sort_order: 210,
  subject: "Quick question, [First name]",
  body: `Hi [First name],

Just one question, and a one-line reply is perfect:

What's the biggest thing holding [Business] back right now?

More work, the right kind of work, staff, time, cash flow - whatever it is. I'll send back whatever we've seen help other tradies with the same thing, no sales pitch.

Cheers,
[Your name]` },

{ title: "Lead nurture · 12. Day 154 - We've got a spot opening", sort_order: 211,
  subject: "Opening up a spot in [area]",
  body: `Hi [First name],

We only take on a couple of trade businesses per area at a time, so we're not running ads against ourselves.

A spot's opening up in [area] next month and you came to mind first. Still covered by the 10 Quote Guarantee, still no lock-in.

If you'd like it, just reply "keen" and I'll call you this week. If not, no worries at all.

Cheers,
[Your name]` },

{ title: "Lead nurture · 13. Day 168 - Six month check-in", sort_order: 212,
  subject: "Should I close your file?",
  body: `Hi [First name],

It's been about six months since we first chatted, so I'll stop filling your inbox after this one.

If more quotes are still on your radar, I'd love to help - just reply and we'll pick up where we left off. And if the timing's never right, that's completely fine too.

Either way, all the best with [Business] - keep doing good work.

Cheers,
[Your name]
Mr Priceless` },

/* ───────── For our clients to send their own past customers ─────────
   Repeat and service work from jobs they've already done. */
{ title: "Client customers · HVAC 6-month service reminder", sort_order: 300,
  subject: "Time for your heat pump's 6-month service",
  body: `Hi [Customer name],

It's been about six months since we installed your [heat pump / air con], so it's due for its first service.

A quick service keeps it running efficiently, keeps your power bill down and keeps your warranty valid. We'll clean the filters and coils, check the refrigerant and make sure everything's running as it should.

It takes about an hour and costs [price]. Just reply with a day that suits, or book here: [booking link]

Thanks again for choosing [Business].

[Name]
[Business] · [Phone]` },

{ title: "Client customers · Plumbing hot water check", sort_order: 301,
  subject: "Is your hot water cylinder due a check?",
  body: `Hi [Customer name],

Thanks again for having us at [address/suburb]. Just a quick heads up - hot water cylinders give very little warning before they fail, and a check every year or two can save a cold shower and a flooded cupboard.

We'll check the valves, element and thermostat, and let you know if anything's on its way out. [price] for the check.

Want us to pop round? Reply with a time that suits.

[Name]
[Business] · [Phone]` },

{ title: "Client customers · Electrical safety check and upgrades", sort_order: 302,
  subject: "A quick safety check for your home",
  body: `Hi [Customer name],

It's been a while since we were last out, so a friendly reminder on a few things worth checking:

- Smoke alarms tested and in date (they last about 10 years)
- Switchboard and RCD safety switches working
- Any flickering lights or warm switches

While we're there, we can also quote on LED upgrades, extra outdoor lighting or an EV charger if that's on your list.

Reply here to book a time.

[Name]
[Business] · [Phone]` },

{ title: "Client customers · Roof and gutter inspection", sort_order: 303,
  subject: "Your roof after winter",
  body: `Hi [Customer name],

After a wet winter, it's a good time for a quick roof and gutter check - blocked gutters and lifted flashings are the most common cause of leaks we see, and they're cheap to fix early.

We'll check the roof, clear the gutters and send you photos of anything that needs attention. [price].

Reply with a day that suits and we'll get you in.

[Name]
[Business] · [Phone]` },

{ title: "Client customers · Landscaping seasonal maintenance", sort_order: 304,
  subject: "Keep your garden looking like the day we finished",
  body: `Hi [Customer name],

We loved how your [garden / landscaping] turned out, and we'd hate to see it go backwards.

We offer a seasonal maintenance visit: pruning, weeding, mulch top-up and a tidy so it stays looking sharp all year. Most customers book one every [season / 3 months] - from [price].

Want me to pencil you in? Just reply.

[Name]
[Business] · [Phone]` },

{ title: "Client customers · Builders 6-month check-in", sort_order: 305,
  subject: "How's everything holding up?",
  body: `Hi [Customer name],

It's about six months since we finished your [project], so I wanted to check everything's holding up well. If anything needs a tweak, let me know and we'll sort it.

Also - if a deck re-oil, a new project or a bit of maintenance is on the horizon, we'd love to help again.

And if you know anyone thinking about building or renovating, a recommendation means the world to a business like ours.

[Name]
[Business] · [Phone]` },

{ title: "Client customers · Painting touch-up and wash", sort_order: 306,
  subject: "Keep your paint looking fresh",
  body: `Hi [Customer name],

It's been about a year since we painted your [house / interior]. A gentle house wash and a few touch-ups now will keep it looking fresh and add years to the paint.

We can do both in one visit from [price]. Reply here if you'd like a time.

[Name]
[Business] · [Phone]` },

{ title: "Client customers · Solar panel clean and health check", sort_order: 307,
  subject: "Is your solar running at full power?",
  body: `Hi [Customer name],

Dust, pollen and bird mess can quietly cut your solar output. A clean and system health check once a year keeps it producing what it should.

We'll clean the panels, check the inverter and connections, and send you a quick report. [price].

Reply to book a time that suits.

[Name]
[Business] · [Phone]` },

{ title: "Client customers · Review and referral request", sort_order: 308,
  subject: "Thanks for choosing [Business]",
  body: `Hi [Customer name],

Thanks again for having us. We hope you're loving the finished [job].

If you've got a minute, a quick Google review would really help a small local business like ours: [review link]

And if you know anyone who needs a hand with something similar, we'd be grateful for the recommendation.

[Name]
[Business] · [Phone]` },
];
