-- Mr Priceless CRM - Sit Rate Process step 3 wording. Run after 069. Safe to re-run.
update playbooks
set content = replace(content,
      'Apart from what we''ve talked about, is there anything else that would be helpful to cover off in the session?',
      'What else would be helpful to cover off in the session?'),
    updated_at = now()
where title ilike 'meeting sit rate process'
  and content like '%Apart from what we''ve talked about, is there anything else%';
