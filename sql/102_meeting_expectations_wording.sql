-- Mr Priceless CRM - Meeting Structure: a shorter "Set the expectations"
-- (Rocky's wording, 30 Oct 2026). Swaps just that section of the saved
-- playbook, once (it stops matching after the change). Run after 101.
-- Safe to re-run.
update playbooks
set content = regexp_replace(
      content,
      '(## 2\. Set the expectations[^\n]*\n).*?(\n## 3\. )',
      $new$\1This is what takes the pressure off. Say it plainly:
> "Look, we can keep our catch up pretty short and sharp. Keen to just show you what we're doing for some of our other guys, go through the numbers a little bit, and just see if this kind of marketing even makes sense for you - 'cause some guys I speak to run like a 4% margin, and it's just not gonna be worth running ads if that's where you're at. So yeah, look, if at any point I don't reckon it's a fit, I'll be pretty straight up, and feel free to do the same on your end as well - I'll be more than happy to point you in the right direction."
\2$new$
    ),
    updated_at = now()
where title ilike 'meeting structure'
  and content ilike '%## 2. Set the expectations%'
  and content not ilike '%run like a 4\% margin%';
