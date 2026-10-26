# Mr Priceless CRM - notes for Claude

Read this before changing anything. The repo is **public**, so nothing secret
belongs in code, commits, PRs or logs.

## What this is
The CRM for Mr Priceless, a marketing agency for tradies in NZ and AU.
- Live site: https://rocky-toky.github.io/mr-priceless-crm/ (GitHub Pages, deployed from `main` by `.github/workflows/pages.yml`)
- Backend: Supabase project `chaexdenosljtdwuyjnw` (Postgres, auth, Edge Functions, pg_cron)
- People: Rocky (owner; CRM logins `rockyoneill02@gmail.com` and `rocky.oneill@mrpriceless.com`), Max (`maximus.smith@mrpriceless.com`), plus sales staff. See `EMAIL_TO_ASSIGNEE` in `js/app.js`.

## How Rocky wants changes shipped
Rocky isn't a developer. "Do it on the live CRM" is a standing instruction, so every change goes all the way to live without asking:
1. Branch from the latest `origin/main`.
2. Make the change. Bump the cache version in `index.html` (every `?v=NNN` goes up by one, all occurrences).
3. Test it (see below).
4. Commit, push, open a PR into `Rocky-Toky/mr-priceless-crm`, and squash-merge it.
5. Wait for both workflows on the merge commit to go green ("Deploy to GitHub Pages" and, if triggered, "Deploy Supabase functions"), and check the logs when SQL or functions changed.
6. Tell Rocky in plain English what changed and anything he needs to do. No jargon, short.

Never: commit API keys or passwords, print client data or secrets in logs, bulk-edit live client data without asking first, or put model names in commits or PRs.

## Code layout
- `index.html`: every page's markup (sections `#page-<name>`, nav items `data-page` / `data-group`, `data-workspace="sales|delivery|both"`).
- `js/app.js`: the whole app, one big IIFE (~12k lines, vanilla JS, no build step). Key pieces:
  - `DataLayer` loads every table into `state` (`_fetchAllNow` / `_apply` are positional - keep them in step), with realtime in `subscribeRealtime()`.
  - `RENDERERS` maps render functions to pages; `PAGE_GROUPS` holds tabbed menu groups; `FIT_PAGES` holds no-scroll pages.
  - Demo mode (no Supabase config) seeds fake data via `seedDemo()`, which is how pages are tested.
- `js/builtin-playbooks.js`: built-in playbooks (Meeting Structure, Meeting Sit Rate Process). These are only seeded into the DB when the title is missing, so changes to an existing playbook also need a guarded SQL `update`.
- `css/style.css`: tokens on `:root`, gold/black theme.
- `sql/NNN_*.sql`: migrations. They must be safe to re-run. **New ones are added to `.github/workflows/supabase-functions.yml` in two places** (the `paths:` list and the `for f in` loop), and every one in that loop re-runs on each deploy.
- `supabase/functions/*`: Edge Functions. The workflow deploys `sync-client-ads`, `ghl-report-data`, `jarvis`, `send-scheduled-emails`, `sync-client-inbox`, `sync-ghl-leads` and `precall-meetings` (with `--no-verify-jwt`; each checks its own caller).

## Access the workflow already has (no keys needed in chat)
GitHub repo secrets: `SUPABASE_ACCESS_TOKEN`, `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_REPLY_TO` (+ optional AI keys). `supabase-functions.yml` uses them to:
- run the SQL migrations through the Supabase Management API
- lock down auth (sign-ups off)
- set function secrets
- deploy functions

It can also be run by hand (`workflow_dispatch`):
- `test_email`: sends a test email through the scheduled-email sender.
- `create_login`: adds an email to the allowlist, creates a confirmed account, and emails a set-password link.

A Claude session can't reach `*.supabase.co` directly (the sandbox proxy blocks it), so anything touching the live database or auth goes through this workflow.

## Security model
- Only allowlisted, email-confirmed users get data: `public.is_allowlisted()`, and every table has a team-only RLS policy (`sql/066`).
- Server-only tables have RLS on with no policies: `app_secrets`, `client_ghl`, `crm_migrations`.
- Sign-in is email + password. Google sign-in has no working Google Cloud project behind it, so don't build on it.

## Features worth knowing
- **Client inbox:**
  - Each person connects their Gmail with an Apps Script copied from the Client inbox page. The script runs every 5 minutes and posts to `sync-client-inbox` with a per-user key (stored hashed in `app_secrets`).
  - The script searches what the server's `senders` reply says (`INBOX_QUERY`: recent Primary-tab mail, plus known client senders), so search changes don't need a new script. `push` keeps clients' emails plus any real person's, dropping bulk/automated senders, big-company domains (`COMPANY_DOMAINS`) and job applications.
  - Client emails go into `client_emails`; replies are detected from the Gmail thread; there's a 2-hour reminder email.
- **Receipts / billing:**
  - Due dates come from `rcNextDue`, and are stored in `clients.onboarding_progress.billing` / `.invoices`.
  - Payment reminder emails are queued in `scheduled_emails` (kind `billing_reminder`) by the browser and sent by `send-scheduled-emails`.
- **Meeting structure and Sit Rate pages:** rendered from the playbooks above.
- **Employees workspace:** one menu item per current employee (`empNavRender`, `.nav-emp-list`), opening their page with their responsibilities (`employees.responsibilities`, sql/084) above the tabs. The team is Rocky (Appointment Setting & Running Ads), Max (Closing & Process Improvement) and Carmen (Lead Follow Up); people set to "Left" sit under Past employees.
- **Lead Follow Up workspace** (Carmen calls every client lead):
  - `sync-ghl-leads` pulls new opportunities from each client's GoHighLevel every 5 minutes (sql/078 cron) into `client_leads`.
  - Calling state lives on `client_leads`: `follow_status`, `attempts`, `next_attempt_at`, `call_log`, `booked_for`.
  - The queue and results pages are in `js/app.js` (search for "Lead Follow Up").
  - Queue order: fresh uncalled enquiries (goal: called within 3 minutes, `LQ_FAST_MS`), then due retries / call-backs, then older leads sitting in Rep to contact or Stuck (the sync pulls those in at any age). Longest waiting first within each.
  - No-answers come back in alternating waves (`lqNextTry`): morning wave 9am, afternoon wave 2pm, 5 calls in all, then "No answer" in GHL.
  - The KPI's page (`renderLeadKpis`, `#page-lead-kpis`) shows the 3-minute response score and the calling process. Keep that out of the call queue page: Rocky wants the queue uncluttered.
  - Outcomes go back into the client's GoHighLevel via `sync-ghl-leads` action `outcome`: site visit / consultation call move the opportunity to that stage and book the client's calendar; not interested / not a fit / wrong number move to Disqualified; 5 unanswered calls move to No answer. Stages and calendars are matched by name unless set per client in `lead_stage_map` (Results → Stages). What happened is recorded on `client_leads.ghl_sync`.
  - GHL keys need: View Contacts, Edit Contacts, View/Edit Opportunities, View Forms, View Custom Fields, View Calendars, Edit Calendar Events.
  - Workspaces are `sales`, `delivery`, `employees` and `leads`. The last two are in `SOLO_WORKSPACES`, so shared menu items are hidden there.

- **Pre-call nurture (Sales → Upcoming Meetings):**
  - The Book Meeting form (every entry point: Upcoming Meetings, Meetings Booked, Dialler) calls the `precall-meetings` Edge Function, which saves to `meetings` and puts a 15-minute Google Meet invite plus a private 30-minute buffer on the closer's calendar. It acts as the closer through a Workspace service account with domain-wide delegation (repo secret `GOOGLE_SERVICE_ACCOUNT_JSON`, passed on base64-encoded). Invite title: "{prospect} x {closer}" (Max shows as Maximus).
  - Reschedule / cancel / confirm / flag actions also go through that function. History is in `meeting_events`.
  - pg_cron (sql/083) calls it every 5 minutes (`action: "poll"`): an accept confirms; a decline, or a move/delete in Google, sets `calendar_flag` and emails the setter via `scheduled_emails` (kind `precall_alert`). It never changes the meeting by itself.
  - Test mode (`precall_settings.test_mode`, toggled on the page) only invites @mrpriceless.com and the test list.
  - The workflow's manual `check_calendar` (an email) and `check_meetings` (yes) runs check Google access and how meetings, the watch and alert emails are doing (statuses only).
  - Phases still to come: GHL sync, setter/closer task engine, message timeline, reporting.

## Testing before you push
- `node --check js/app.js`
- Functions: `deno check supabase/functions/<name>/index.ts` (download Deno from GitHub releases if missing).
- SQL: run it twice against a throwaway local Postgres (`initdb` / `pg_ctl` as user `postgres`), stubbing Supabase-only bits (`is_allowlisted`, `cron`, the publication).
- UI: Playwright with Chromium at `/opt/pw-browsers` in demo mode. Serve the repo by routing `http://local/*` to files, and fulfil `config.js` with empty Supabase settings. Check desktop (1440×900) and phone (390×844), no horizontal scroll, no page errors.
