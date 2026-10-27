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
  - Each person connects their Gmail with an Apps Script copied from the Client inbox page. The script runs every minute (Apps Script only allows 1/5/10/15/30), only looks at threads changed since its last run, and posts to `sync-client-inbox` with a per-user key (stored hashed in `app_secrets`).
  - Once per key it also catches up on the last 60 days of the inbox (`BACKFILL_QUERY`), 50 threads a page, tracked by `app_secrets` `inbox_backfill:<user>` (cleared when a new script is copied). Caught-up emails older than 2 hours don't trigger reminders.
  - The script searches what the server's `senders` reply says (`INBOX_QUERY`: recent Primary-tab mail, plus known client senders), so search changes don't need a new script. `push` keeps only client emails: from a client's address/domain, or (`aboutAClient`) naming a live client's company name or website, and then only from a real person (no bulk/automated senders, big-company domains (`COMPANY_DOMAINS`) or job applications). Rocky wants nothing else in there. The page and reminders ignore rows without a `client_id`. Matching also uses every address in `email`/`report_email`/`key_contacts`, the website, name variants (plural, and the name without trade words via `TRADE_WORDS`), and a sender domain that contains the client's name (`ownDomainClient`). Saved rows without a client are re-matched on each push. Bump `BACKFILL_VERSION` to make every Gmail re-scan its inbox. Manual workflow run `check_inbox=yes` prints inbox health (counts only).
  - Client emails go into `client_emails`; replies are detected from the Gmail thread; there's a 2-hour reminder email.
  - Service Delivery workspace only (nav item `data-workspace="delivery"`); the count, tab title, alert bar and notifications only show there (`inboxHere`).
  - Page (`renderClientInbox`, ib-* styles) fits the screen (in `FIT_PAGES`; the two panels scroll inside themselves): title + 3 stats, "Waiting on a reply" with a client dropdown, and a "Done" panel with a dropdown, plus fold-outs for Gmail status and clients missing an email. Rocky wants it simple enough for a kid or a senior: no page scrolling, dropdowns over rows of buttons, big buttons. The Gmail setup panel only shows when your Gmail isn't connected or has stopped checking in; there's no Reconnect button.
- **Receipts / billing:**
  - Due dates come from `rcNextDue`, and are stored in `clients.onboarding_progress.billing` / `.invoices`.
  - Payment reminder emails are queued in `scheduled_emails` (kind `billing_reminder`) by the browser and sent by `send-scheduled-emails`.
- **Email templates (Sales Emails / Delivery Emails):** `renderEmailTemplateList` / `etViewHtml`. Pick an email (list + type dropdown on desktop, a dropdown on phones), fill the yellow blanks once (`etBlanks`: any `[placeholder]` or a lone X for their name; "Your name" defaults to the logged-in person; values are remembered in localStorage `mp_et_fills`), then "Copy the email" (`etCopyRich`, copies HTML + plain text so paragraphs paste into Gmail), click the subject to copy it, or Open in Gmail. Copy buttons use `data-etx`, not `data-action` (the global handler re-renders in demo mode).
- **Meeting structure and Sit Rate pages:** rendered from the playbooks above.
- **Employees workspace:** one menu item per current employee (`empNavRender`, `.nav-emp-list`), opening their page with their responsibilities (`employees.responsibilities`, sql/084) above the tabs. The team is Rocky (Appointment Setting & Running Ads), Max (Closing & Process Improvement) and Carmen (Lead Follow Up); people set to "Left" sit under Past employees.
- **Lead Follow Up workspace** (Carmen calls every client lead):
  - `sync-ghl-leads` pulls new opportunities from each client's GoHighLevel every 5 minutes (sql/078 cron) into `client_leads`.
  - Calling state lives on `client_leads`: `follow_status`, `attempts`, `next_attempt_at`, `call_log`, `booked_for`.
  - The queue and results pages are in `js/app.js` (search for "Lead Follow Up").
  - Queue order: fresh uncalled enquiries (goal: called within 3 minutes, `LQ_FAST_MS`), then due retries / call-backs, then older leads sitting in Rep to contact or Stuck (the sync pulls those in at any age). Longest waiting first within each.
  - No-answers come back in alternating waves (`lqNextTry`): morning wave 9am, afternoon wave 2pm, 5 calls in all, then "No answer" in GHL.
  - Follow-ups page (`renderFollowUps`, fu-* styles, `#page-lead-followups`, in `FIT_PAGES`): Carmen's to-dos in `lead_tasks` (sql/088: kind call/text/email/other, title, note, due_at, done_at), shown with call-backs from `client_leads` in three groups (Do now / Later today / Coming up). Big buttons: Call/Text/Email, Done, Open, Move to tomorrow. New follow-up form: 4 steps (what, who via dropdown, when via quick buttons or day+time, note). The call screen has a "Set a follow-up" link and shows the lead's next follow-up. A toast/notification fires when one comes due (`fuRemind`, every minute).
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
  - GHL sync (sql/085): every booking change upserts the prospect into our own GHL sub-account (secrets `GHL_PRECALL_TOKEN`, `GHL_PRECALL_LOCATION_ID`), sets the 11 custom fields (created by the function if missing; manual `setup_ghl` run) and leaves exactly one `precall-*` tag. GHL's workflows send the SMS/emails from those tags. Result on `meetings.ghl_status` / `ghl_error`; failures retry every 5 minutes, up to 8 times. Test mode only syncs @mrpriceless.com and the test list.
  - Tasks (sql/086): `pmTasks(m)` in app.js works out each meeting's setter/closer tasks A-G (booking text, follow-up text/call, one-hour call, late-joiner text/call, record outcome) from `starts_at`, `tasks_from` (booked or last moved) and confirmation state, with calls/texts kept to 8am-6pm NZ. Done/skipped is stored in `meetings.task_log` via the function's `task` action, which also handles side effects (one-hour no answer -> `precall-onehour-noanswer` tag; outcome -> `outcome`, deal `attended_meeting`, tag). A reschedule resets the tasks. The 5-minute check emails closer and setter if there's no outcome 20 minutes in. "Your to-do" sits at the top of Upcoming Meetings; the booking form shows the booking text live with a Copy button, then a "Booked" pop-up to copy / mark it sent.
  - Messages (sql/087): the 5-minute check also reads each recent prospect's GHL conversation (token's View Conversations) into `precall_messages` (channel, direction, status, body); replies are unread until the prospect's Timeline is opened. Most replies go to the setter's own phone, so the Timeline has quick buttons that log them by hand (`log` action -> `meeting_events` kind `manual`). `pmGhlSchedule(m)` shows the next automated GHL message (case study / prep / FAQ / day-before / morning-of) from the brief's rules; it's display only. "Unread replies" sits at the top of Upcoming Meetings.
  - Report (Upcoming Meetings → Report tab, `pmReportHtml`): worked out in the browser from `meetings`. Booked / rescheduled / cancelled count meetings booked in the date range; show rates (overall, by booking window, confirmed or not, one-hour call answered or not) count meetings due in the range with an outcome; late joiners saved = showed after task E or F was done. Filters: dates, setter, closer, leave out test-mode bookings.

## Testing before you push
- `node --check js/app.js`
- Functions: `deno check supabase/functions/<name>/index.ts` (download Deno from GitHub releases if missing).
- SQL: run it twice against a throwaway local Postgres (`initdb` / `pg_ctl` as user `postgres`), stubbing Supabase-only bits (`is_allowlisted`, `cron`, the publication).
- UI: Playwright with Chromium at `/opt/pw-browsers` in demo mode. Serve the repo by routing `http://local/*` to files, and fulfil `config.js` with empty Supabase settings. Check desktop (1440×900) and phone (390×844), no horizontal scroll, no page errors.
