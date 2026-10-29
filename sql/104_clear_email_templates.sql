-- Mr Priceless CRM - Email templates: Rocky cleared out every existing
-- template (30 Oct 2026) and replaced them with two of his own, which ship in
-- js/builtin-email-templates.js and are added by the app. Deletes every saved
-- template except those two, ONCE (crm_migrations), so templates made after
-- this are never touched. The 6-month lead nurture emails keep working from
-- the app's own copy (MP_NURTURE_EMAILS). Run after 103. Safe to re-run.

do $$
begin
  if not exists (select 1 from crm_migrations where key = '104_clear_email_templates') then
    delete from email_templates
    where title not in ('Pre-onboarding · Welcome and onboarding prep', 'First meeting · Wrap up');
    insert into crm_migrations (key) values ('104_clear_email_templates');
  end if;
end $$;
