-- Mr Priceless CRM - Meeting Structure gets a Demo step after Discovery:
-- a relevant client's ad account, then the CRM. Updates the saved playbook
-- once (only if it doesn't have a Demo step yet), leaving any other edits.
-- Run after 067. Safe to re-run.
update playbooks
set content = replace(
      replace(content,
        $flow$5. Sum it back and decide if it's a fit (2 min)
6. Into the offer$flow$,
        $flow$5. Demo - a relevant ad account, then the CRM (5-8 min)
6. Sum it back and decide if it's a fit (2 min)
7. Into the offer$flow$),
      '## 5. Sum it back and decide',
      $demo$## 5. Demo - their kind of ads, then the CRM (5-8 min)
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

## 6. Sum it back and decide$demo$),
    updated_at = now()
where title ilike 'meeting structure'
  and content not ilike '%## 5. Demo%'
  and content like '%## 5. Sum it back and decide%';
