-- Mr Priceless CRM - Objection Handling and Sales Techniques playbooks.
--
-- Written for the 2 new junior cold callers coming on board: organised into
-- short, bolded objection/response pairs and scannable bullet points so
-- they're easy to glance at mid-call, not a wall of prose.
--
-- Run after 036. Safe to re-run - replaces any existing rows with these
-- exact titles so re-running doesn't create duplicates.

delete from playbooks where title in ('Objection Handling', 'Sales Techniques');

insert into playbooks (title, content, sort_order) values
('Objection Handling', $pb5$## The Golden Rule
Never argue. Agree with the feeling first, then reframe - arguing makes people defend their position harder, agreeing gets them to lower their guard.

## How To Handle Any Objection
1. Acknowledge - "Totally get that" / "Fair enough" / "Makes sense."
2. Isolate - check it's the only thing in the way ("If we sorted that, is there anything else stopping you?").
3. Reframe - answer the real worry behind the words, not just the words themselves.
4. Confirm - ask directly if that resolves it before moving on.

## Cold Call Objections
**"I'm not interested"** - Totally understand, most people say that before they've heard what it actually is. Can I take 20 seconds to explain, then you can tell me to get lost?

**"Send me an email"** - Happy to, but most people don't get round to reading it. Can we lock in 10 minutes so I can walk you through it properly instead?

**"We already have someone doing this"** - Good to hear - out of curiosity, are you happy with the results, or open to a second opinion?

**"How did you get my number?"** - Public business listing - I do a bit of research before I call so I'm not wasting your time on a generic pitch.

**"Now's not a good time"** - No worries at all - when's better, later today or tomorrow morning?

**"We don't have a marketing budget"** - Understood - can I ask, is that because it hasn't worked before, or because it's genuinely not a priority right now?

## Meeting & Closing Objections
**"It's too expensive"** - Compared to what? Let's look at what it's actually costing you to not solve this.

**"I need to think about it"** - Of course - what specifically do you need to think through? Let's talk it through now while it's fresh.

**"I need to check with my partner/team"** - Makes sense. Can we get them on a quick call before we finish up today?

**"We tried ads before and it didn't work"** - What do you think went wrong last time? Listen first, then explain what's different about this approach.

**"Can you guarantee results?"** - Nobody can honestly guarantee outcomes, but I can guarantee the process, the effort, and full transparency along the way. What I can show you is what's happened for clients in a similar position.

**"I've been burned by an agency before"** - That's exactly why we report weekly and don't lock people into long contracts. What happened last time, so I make sure we don't repeat it?

## Timing Objections
**"Call me back next month/quarter"** - Happy to - can I ask what changes for you then that doesn't apply right now?

**"We're too busy to start something new"** - That's actually usually the best time - the busier you get without a system, the more that gap costs you. What if we set it up now and it runs in the background?

**"Let's revisit after the holidays/season"** - Sounds good - can we lock a specific date in now so it doesn't slip past both of us?

## Price & Contract Objections
**"Can you do it cheaper?"** - The price reflects what it actually takes to get you the result - if I cut corners, I'd be selling you a worse outcome. What's the real concern, budget or value?

**"What if I want to cancel?"** - Explain the actual terms honestly. The goal is you staying because it's working, not because you're locked in.

**"Why is it a monthly retainer, not a one-off?"** - Because results compound over time - one-off work gets you a short spike, ongoing work builds something that keeps growing.

## Reminders
- Silence after a rebuttal is powerful - resist the urge to fill it by talking more.
- If someone objects twice on the exact same thing, that's usually the real issue - dig one level deeper.
- Never sound rehearsed - use these as a guide for the idea, not a script to recite word for word.$pb5$, 4),

('Sales Techniques', $pb6$## Tone & Delivery
- Smile before you dial - it changes your voice, and they can hear it.
- Slow down - nervous energy speeds up your speech, and a rushed caller sounds unsure.
- Match their energy, don't fight it - a calm prospect gets a calm you, an energetic one gets energy back.

## The Assumptive Frame
- Speak like the meeting is already happening ("When we jump on Tuesday..." not "If you're interested, maybe we could...").
- Assumptive language removes the "should I even bother" decision from the prospect's side of the conversation.

## Active Listening
- Use their own words back to them when presenting the offer - it proves you were actually listening, not just waiting to talk.
- Don't interrupt to sell - let them finish the sentence, then respond to what they actually said.
- Take notes during discovery so you can reference specifics later in the call or meeting.

## Silence Is A Tool
- After asking a big question (price, close), stop talking. The first person to speak after a big ask usually loses leverage.
- A pause feels longer to you than it does to them - count to three in your head before jumping in.

## The Takeaway Technique
- If someone's stalling, it can help to gently take the offer away ("No worries if now's not right - we're pretty booked up for new clients this month anyway").
- This can flip a hesitant prospect from passive to actively wanting back in.

## Framing Price
- Always present price after value, never before.
- Use contrast - compare the investment to the cost of the problem continuing, not to "nothing."
- State the price once, clearly, then stop talking. Don't soften it by immediately discounting or apologising.

## Building Instant Rapport
- Use their name naturally, once or twice per call - more than that starts to sound scripted.
- Mirror their pace and formality - a laid-back tradie doesn't want corporate language, and a corporate client doesn't want slang.
- Find one genuine, specific thing to comment on early - something on their website, a recent review, a job you can see they've done.

## Closing Techniques
1. The Direct Close - "Does this make sense to move forward with?" Ask it plainly, then stop talking.
2. The Alternative Close - offer two positive options instead of yes/no ("Would Tuesday or Wednesday work better to get started?").
3. The Summary Close - recap the pain points and outcomes they've already agreed to before asking for the business, so the "yes" feels like the natural next step, not a big leap.

## Quick Reminders For Every Call
- Energy first, script second - a flat voice with perfect words still loses.
- You're not selling, you're finding out if it's a fit - and if it's not, that's fine too.
- Every "no" gets you closer to a "yes" - don't take a knockback personally, it's not about you.$pb6$, 5);
