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
- `supabase/functions/*`: Edge Functions. The workflow deploys `sync-client-ads`, `ghl-report-data`, `jarvis`, `send-scheduled-emails`, `sync-client-inbox` and `sync-ghl-leads` (with `--no-verify-jwt`; each checks its own caller).

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
  - Client emails go into `client_emails`; replies are detected from the Gmail thread; there's a 2-hour reminder email.
- **Receipts / billing:**
  - Due dates come from `rcNextDue`, and are stored in `clients.onboarding_progress.billing` / `.invoices`.
  - Payment reminder emails are queued in `scheduled_emails` (kind `billing_reminder`) by the browser and sent by `send-scheduled-emails`.
- **Meeting structure and Sit Rate pages:** rendered from the playbooks above.
- **Lead Follow Up workspace** (Carmen calls every client lead):
  - `sync-ghl-leads` pulls new opportunities from each client's GoHighLevel every 5 minutes (sql/078 cron) into `client_leads`.
  - Calling state lives on `client_leads`: `follow_status`, `attempts`, `next_attempt_at`, `call_log`, `booked_for`.
  - The queue and results pages are in `js/app.js` (search for "Lead Follow Up").
  - Workspaces are `sales`, `delivery`, `employees` and `leads`. The last two are in `SOLO_WORKSPACES`, so shared menu items are hidden there.

## Testing before you push
- `node --check js/app.js`
- Functions: `deno check supabase/functions/<name>/index.ts` (download Deno from GitHub releases if missing).
- SQL: run it twice against a throwaway local Postgres (`initdb` / `pg_ctl` as user `postgres`), stubbing Supabase-only bits (`is_allowlisted`, `cron`, the publication).
- UI: Playwright with Chromium at `/opt/pw-browsers` in demo mode. Serve the repo by routing `http://local/*` to files, and fulfil `config.js` with empty Supabase settings. Check desktop (1440×900) and phone (390×844), no horizontal scroll, no page errors.
