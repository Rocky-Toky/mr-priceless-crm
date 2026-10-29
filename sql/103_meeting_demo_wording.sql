-- Mr Priceless CRM - Meeting Structure, Demo the CRM: drop "the bit most
-- agencies don't give you" (too salesy) and say we follow up every lead
-- within 3 minutes (Rocky, 30 Oct 2026). Swaps just those two lines in the
-- saved playbook; does nothing once they're changed. Run after 102. Safe to
-- re-run.
update playbooks
set content = replace(replace(content,
      $a$> "And this is where every one of those leads lands - the bit most agencies don't give you."$a$,
      $b$> "And this is where every one of those leads lands."$b$),
      $c$- A new lead comes in, they get a text straight away, and we call the lead within minutes.$c$,
      $d$- A new lead comes in, they get a text straight away, and we follow up every lead within 3 minutes - that's what turns the most of them into booked jobs.$d$),
    updated_at = now()
where title ilike 'meeting structure'
  and (content like $e$%the bit most agencies don't give you%$e$ or content like $f$%call the lead within minutes%$f$);
