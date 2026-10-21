-- Mr Priceless CRM - Meeting Sit Rate Process gets step 5: fill the calendar
-- invite description with their numbers, and say we'll share screen to go
-- over what competitors are doing. Added once. Run after 071. Safe to re-run.
update playbooks
set content = rtrim(content, E'\n') || E'\n\n' || $step$## 5. Fill in the invite description
Put their numbers in the calendar description, so every time they open the invite they see what the session is worth to them.
**Paste into the invite description:**
- Quotes won: about [X] out of every 10
- Average job value: $[X]
- Average margin: [X]%
- Extra profit from [X] more jobs a month: about $[X]
- What you wanted to cover: [what they said in step 3]
- I'll share my screen to go over what your competitors are doing with their ads.$step$,
    updated_at = now()
where title ilike 'meeting sit rate process'
  and content not ilike '%## 5. Fill in the invite description%';
