/* Mr Priceless CRM - email templates that ship with the app.
   app.js adds any of these to the shared Email Templates table the first
   time a signed-in user loads the CRM and a template with that title isn't
   there yet. Once added they're ordinary templates: edit them in the app.
   Titles are "Group · Name" - the Email Templates page groups by the part
   before the dot. [Square brackets] and a lone X (their first name) are
   the yellow blanks filled in on the page before copying. */
window.MP_BUILTIN_EMAIL_TEMPLATES = [

/* ───────── Pre-onboarding: signed, before the onboarding meeting ───────── */
{ title: "Pre-onboarding · Welcome and onboarding prep", kind: "onboarding_pre", sort_order: 100,
  subject: "Welcome to Mr Priceless, X - see you on [onboarding day and time]",
  body: `Hey X,

Great to catch up earlier mate.

Stoked to have you on board; I look forward to catching up [onboarding day and time].

I've attached 2 documents for you prior to our onboarding meeting. The welcome pack I would recommend reading through, just so you'd have everything you need. No need to go through the company intro, it's just a bit more info on us you might find handy.

Will work on getting all the backend technical setup ready for you now, and the CRM live and tailored to [Business].

Main things we will cover:

- Recruitment strategy
- Creative / ad strategy
- Removing your time spent on sales and marketing, so you can focus on service constraints
- Alignment for brand representation

Cheers,
[Your name]` },

/* ───────── Sales: after the first meeting ───────── */
{ title: "First meeting · Wrap up", kind: "sales", sort_order: 200,
  subject: "Great to meet you, X - the numbers from today",
  body: `Hey X,

Great to learn more about what you do. [Their close rate] close rate is very impressive. Let's put that to use by booking qualified quotes straight into your calendar every month. I've attached more info on who we are.

YOU ONLY PAY IF WE DELIVER
We charge our fee only if we get you 10 qualified quotes in the first month. 9, and you pay us $0. Payment is at month's end, so you see results first.

YOUR INVESTMENT
- Ad spend: [ad spend per day]/day (~[ad spend per month]/month)
- Our fee: [our fee] + GST, paid end of month

THE NUMBERS (10 quotes, [average job value] average job, [their margin] margin)
- At 20% conversion: 2 projects = [sales from 2 jobs] in sales, ~[profit from 2 jobs] profit
- At 50% conversion: 5 projects = [sales from 5 jobs] in sales, ~[profit from 5 jobs] profit

WHAT YOU GET
- Data-driven ad creation and ongoing management
- In-person content shoot led by our creative director
- Every lead called within 3 minutes by our NZ-based sales rep (5+ years in trade sales) and booked as a quote
- A CRM system, provided by us
- Fortnightly catch-ups and a monthly consulting workshop

Looking forward to [next meeting day and time]. If anything's unclear before then, give us a call. We want you deciding with all the info.

Cheers,
[Your name]` },

];

/* The 6-month lead nurture sequence for ghosted / closed-lost deals. These
   aren't on the Email Templates page any more (Rocky cleared it out on
   30 Oct 2026); nurtureSteps() in app.js reads them from here unless saved
   "Lead nurture · N." templates exist. */
window.MP_NURTURE_EMAILS = [

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

];
