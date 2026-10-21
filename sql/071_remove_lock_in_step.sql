-- Mr Priceless CRM - take the 'Lock in the meeting' step back out of
-- Meeting Structure (it lives in the Meeting Sit Rate Process tab instead).
-- Leaves the rest of the playbook untouched. Run after 070. Safe to re-run.
update playbooks
set content = regexp_replace(content, '## 0\. Lock in the meeting.*?(## 1\. Intro and light rapport)', '\1'),
    updated_at = now()
where title ilike 'meeting structure'
  and content ilike '%## 0. Lock in the meeting%';
