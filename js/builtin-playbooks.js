/* Mr Priceless CRM - playbooks that ship with the app.
   app.js adds any of these to the shared Playbooks table the first time a
   signed-in user loads the CRM and it isn't there yet (matched by title), so
   new docs go live without anyone pasting SQL. Once added they're ordinary
   playbooks: edit them in the app like any other.
   Lines starting "> " show as a script line - the words to actually say. */
window.MP_BUILTIN_PLAYBOOKS = [
{
  title: "Meeting Structure",
  sort_order: 2,
  content: `## What this meeting is for
We're not here to pitch. We're here to work out, together, whether we'd actually be a good fit for their business. If we run it properly, they'll end up selling themselves on it - or we'll both find out early that it's not right, which is fine too.

## The mindset
- **We're the ones deciding if they're a fit**, not the other way round. Not needy, not desperate - genuinely curious.
- **Soft to deep.** Questions start easy and slowly get deeper as they get comfortable. Nobody gets asked how growing the business would help them provide for their family two minutes in.
- **Context before every question.** Say why you're asking, so it feels like a conversation and not an interview or a sales pitch.
- **They talk, we listen.** Aim for them talking 70% of the time. Take notes - you'll use their exact words later.
- **Be happy to walk away.** If it's not a fit, say so. That honesty is what builds the trust and authority.

## The flow at a glance
1. Intro and light rapport (2-3 min)
2. Set expectations (1 min)
3. Quick intro on us (1 min)
4. Discovery - low, mid, then high trust (15-20 min)
5. Demo - a relevant ad account, then the CRM (5-8 min)
6. Sum it back and decide if it's a fit (2 min)
7. Into the offer - see the Meetings to Close playbook

## 1. Intro and light rapport (2-3 min)
Keep it light and genuine. Match their energy - a laid-back tradie doesn't want corporate talk.
- How's the week been, flat out or a bit quieter?
- Are you on the tools today or in the office?
- Where are you calling in from? (Comment on the area if you know it.)
- Saw that job on your Facebook / website - the [deck / bathroom / extension], that looked mean. Was that a recent one?
- Saw you've got a heap of good Google reviews - that's not easy to get.
- How'd you end up getting into [trade] in the first place?

## 2. Set the expectations (1 min)
This is what takes the pressure off. Say it plainly:
> "So the way I usually like to run these - I'll give you a quick bit about us, then I'd love to ask you a few questions about the business, just to see if what we do would actually make sense for you."
> "And look, if at any point you don't feel like it's a fit, feel free to be straight up with me about it. I'll do the same - if I don't think it's right for you, I'll tell you, and I'm more than happy to point you in the right direction elsewhere. Sound fair?"

## 3. Quick intro on us (1 min)
Keep it short. Fill in the numbers before the call.
> "Quick little intro on us, man. I'm [Name], one of the co-founders here. We work with [X] businesses in [their industry] at the moment, and we've got [X result - e.g. 'one builder from 4 to 11 quotes a month']."
> "We specialise in working with tradies. Paid marketing's our core focus, so your Google and Meta ads, but there's also a sales component to what we do, and we run consulting workshops for our clients as well."
> "I was gonna say, unless you've got any burning questions, I can go into a bit more detail in a bit - but it'd be good to just see if this obviously makes sense for you first."

## 4. Discovery
Start soft, earn the right to go deeper. Before each new layer, give a little context ("The reason I ask is..."). You won't ask every question - pick the ones that fit the conversation.

## Strong opening question
> "So have you guys tried anything around marketing before?"
**If no:**
> "Awesome, yeah. Whenever we look for someone to partner with, the guys that have built themselves off word of mouth are usually the ones we like - because if you've grown purely on word of mouth, you're doing the right kind of work and people are coming to you. I've still got to figure a few things out though..."
**If yes:**
- What did you try? Was that Facebook, Google, an agency, doing it yourself?
- How'd it go? Did it bring in the right kind of jobs, or mostly tyre-kickers?
- What did you like about it, and what drove you nuts?
- How long did you give it before you pulled the pin?
- Was it the leads that were bad, or more the follow-up side of things?
- What would you need to see different this time to give it another go?

## Low trust - the business (easy, factual)
These are easy to answer and get them talking.
- What tends to be your guys' bread and butter for work?
- How long have you guys been going for?
- How many of you are there - is it just you, or have you got a team?
- Are you mostly residential, commercial, or a bit of both?
- What area do you cover? Happy to travel, or keep it local?
- Where does most of your work come from right now - word of mouth, repeat clients, builders, Builders Crack?
- What does a typical job look like for you, size-wise?
- Is there a type of job you love doing more than others?
- And is there a type of job you'd happily never do again?
- How's work looking at the moment - booked out, or got some gaps coming up?
- Do you find it's pretty seasonal, or fairly steady through the year?
- Who handles the quoting - is that you?
- When an enquiry comes in, who picks up the phone?

## Mid trust - where they're heading (goals and numbers)
Give context first, e.g. "The reason I'm asking is so I can figure out whether more leads would actually be the thing that helps, or if it's something else."
- Cool man, so do you sort of have a goal of where you're trying to get this thing - like a revenue goal, or?
- Where are you at roughly now, ballpark? No need to be exact.
- If you had more work coming in, could you take it on right now - or would you need to hire first?
- How many more jobs a month would you want, realistically?
- What's your average job worth, roughly?
- And what sort of margin are you working on?
- How many quotes do you send in a typical month? And how many of those do you win?
- What happens to the quotes you don't win - do you follow those up?
- How quickly do you usually get back to a new enquiry?
- What's held you back from getting there already?
- Is the goal more about growing the team, or more about you working less?
- Have you got the systems for more work - quoting, scheduling, a CRM - or is it all in your head and on your phone?

## High trust - the why (only once they're comfortable)
Only go here once they're opening up - usually 10+ minutes in, after the numbers. Soften it: "Can I ask you something a bit more personal?"
- What made you want to start doing something about it now, rather than six months ago?
- If this year went perfectly, what would look different for you in 12 months?
- What would hitting that goal actually change for you, outside of work?
- What are you doing at the moment that you'd love to stop doing?
- How many hours are you working a week? Is that sustainable?
- How does the family feel about how much you're working?
- What happens if nothing changes and next year looks exactly like this one?
- Is there a reason that number matters to you - something you're working towards?
- What would it mean for you to not have to stress about where the next job's coming from?
- On a scale of 1 to 10, how important is it to sort this out this year?
- What's the one thing that would make you say this was worth it?

## The playful disqualify
This is one of the strongest tools you've got. It shows we're not desperate and we genuinely care whether it works for them. Use it once, on a number, and keep it light.
**Example - margin:** they say 25%. You say:
> "Oh yeah, 5% margin - honestly, I'm not sure this would really make sense for you, just because at 5% the marketing investment probably wouldn't pay for itself."
They'll jump in: "No, no, 25%!" Now they're the one making the case for why it works.
**Other ways to use it:**
- **Job value:** they say $15k average job. "Ah, $1,500 average job - that's tricky, the numbers can get tight at that size."
- **Capacity:** "So you're pretty booked out for the next six months anyway - would more work even help right now?"
- **Area:** "You mentioned you only really cover a couple of suburbs - is there enough work in that patch to make ads worth it?"
- **Commitment:** "Honestly, if you're only keen to try it for a month, I'd almost say don't - it takes a bit longer than that to get dialled in."
**If it genuinely isn't a fit, say so** - point them somewhere better. That honesty goes around.

## Lines to give context before a question
- "The reason I ask is..."
- "Just so I can figure out if we'd actually be able to help..."
- "A lot of the guys we work with run into [X] - is that something you've noticed?"
- "No right or wrong answer here, I'm just trying to get a picture of the business."
- "Feel free to tell me to mind my own business, but..."
- "Ballpark is totally fine."

## Reading the room
- **Short answers and crossed arms?** Stay in low trust longer. Ask about the work they love.
- **Opening up and telling stories?** That's your cue to move a layer deeper.
- **They ask about price early?** "Happy to get to that - I just want to make sure it'd actually make sense for you first, otherwise any number's the wrong number."
- **They're sceptical about marketing?** Agree with them. "Yeah, fair - most of it's rubbish. That's honestly why we're quite picky about who we work with."

## 5. Demo - their kind of ads, then the CRM (5-8 min)
Show, don't tell. Pull up a client in their trade (or the closest one), then the CRM their leads would land in. Keep it about them - "this is what yours would look like."
**Show a relevant ad account:**
> "Let me quickly show you one of our [trade] guys, so you can see what this actually looks like."
- Open a client's ad account in the same trade - the ads running, the cost per lead, the leads coming in.
- Point at one ad that's working and why it works - the hook, the photo, the offer.
- Keep the numbers simple: enquiries this month and what each one cost.
> "So that's [X] enquiries this month at about $[Y] each, for a [trade] in [area]."
**Demo the CRM:**
> "And this is where every one of those leads lands - the bit most agencies don't give you."
- A new lead comes in, they get a text straight away, and we call the lead within minutes.
- Drag leads through the stages - site visit, quoted, won - so we can see which ads bring real jobs.
- Quotes book straight into their calendar, with a reminder text an hour before.
- Every quote that goes quiet gets followed up.
> "How would something like that fit with how you're handling enquiries at the moment?"

## 6. Sum it back and decide
> "So if I've got this right - you're doing about [X], want to get to [Y], your average job's around [Z], and the main thing holding you back is [their words]. Is that about it?"
> "From what you've told me, I think this could actually make a lot of sense - want me to walk you through how we'd go about it?"
If it's not a fit, say that instead and point them in the right direction.

## Red flags - it might not be a fit
- Margins too thin to cover the investment.
- Fully booked with no way to take on more work.
- Won't follow up leads or quotes.
- Wants guaranteed results in a few weeks.
- Only shopping on price.

## Don'ts
- Don't jump to deep, personal questions early.
- Don't pitch during discovery - save it for after you've summed it back.
- Don't fill silences - let them think.
- Don't fire questions back to back. React to what they said first.
- Don't argue with an answer - get curious about it.

## After the meeting
- [ ] Log the outcome and next step in Deals
- [ ] Note their goal, average job value and margin on the deal
- [ ] Send a follow-up summary within the hour, using their words
- [ ] Book the next step in the calendar before you hang up`
},
{
  title: "Meeting Sit Rate Process",
  sort_order: 3,
  content: `## What this is for
Turn a booked meeting into a committed one before the call ends. They should leave knowing what the session is worth to them, having shaped the agenda, and with the invite accepted.

## When
Straight after the meeting time is agreed, while you're still on the call.

## 1. Run the commercials
Go over the numbers that show what the extra work is worth to them. Assume the figures rather than asking - people are quick to correct a wrong number, but slow to volunteer one. Write down whatever they confirm or correct, because it feeds into the session.
**Close rate on quotes:**
> "Roughly how many of the quotes you send out do you win?"
**Average job value - assume it:**
> "I'd guess your average job's around $[X]. Is that about right?"
**Average margin - assume it:**
> "And you'd be running a margin of around [X]%?"

## 2. Connect the profit to their goals
Ask pain-based questions, or dig into how the extra profit moves them towards their next target. The aim is for them to tie the meeting to something they personally want, not just "marketing".
- What's the biggest thing holding the business back right now?
- If you picked up an extra [X] jobs a month at that margin, what would that let you do?
- What's the next big target for the business, and what's standing between you and it?

## 3. Let them shape the agenda
A meeting they helped plan is one they're more likely to turn up to.
> "What else would be helpful to cover off in the session?"
- Add whatever they say to the invite notes.

## 4. Confirm the invite live
Don't end the call until the invite shows as accepted.
- [ ] Send the calendar invite while you're still on the call.
- [ ] Ask them to check it's landed in their inbox.
- [ ] Have them press Yes to accept it before you hang up.`
},
];
