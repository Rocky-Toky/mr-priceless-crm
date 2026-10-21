-- Mr Priceless CRM - Meeting Structure gets a 'Lock in the meeting' step
-- before the meeting starts, to lift the sit rate: what to say when you
-- book, the reminder texts, and what to do on a no-show. Adds it to the
-- saved playbook once (only if it isn't there yet), leaving other edits.
-- Run after 068. Safe to re-run.
update playbooks
set content = replace(content, '## 1. Intro and light rapport', $sit$## 0. Lock in the meeting
Get them to actually show up - most no-shows are decided before the meeting starts.
**When you book it:**
> "Perfect - I'll flick you a calendar invite now. Can you hit accept while we're on the phone, just so I know it's come through?"
> "Just so you know, it's about 30 minutes, it's just me and you, and it's not a big pitch - we'll work out if we can actually help."
- Book it within 48 hours - the sooner it is, the more likely they show.
- Confirm the day and time back out loud - "So Thursday the 23rd at 2pm."
- Check who else should be on it - a partner or business partner - and book them in too.
- Give them a reason to turn up - one thing they'll walk away with, like what jobs are costing others in their area to win.
**Before the meeting:**
- Send the confirmation text straight after you hang up, with the time and the link.
- Day before, send a short personal text: "Looking forward to tomorrow at 2, [Name]. Still good?"
- Morning of, send the link again.
- No reply to the day-before text? Give them a call.
> "Hey [Name], just checking we're still good for 2 today - I've had a look at a couple of [trade] businesses in [area] I want to show you."
**If they don't show:**
- Call within 5 minutes of the start time, then text if they don't pick up.
> "Hey [Name], no worries if something came up on site - want to grab a new time this week?"
- Rebook it on the spot, and move the deal to No Show so the follow-up kicks in.

## 1. Intro and light rapport$sit$),
    updated_at = now()
where title ilike 'meeting structure'
  and content not ilike '%## 0. Lock in the meeting%'
  and content like '%## 1. Intro and light rapport%';
