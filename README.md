# Mr Priceless - CRM

A simple, shared CRM for you and your business partner: Dashboard, Cold Calls, Deals (pipeline), Contacts, Notes, and Team. Black / white / gold branding, no clutter.

It's a plain static site (HTML/CSS/JS - no build tools needed) backed by [Supabase](https://supabase.com) for a real shared database, live sync, and sign-in. Sign-in is "Sign in with Google" only - that one click also connects each person's own Google Calendar, so cold-call follow-ups can be synced with one click. Only emails you've explicitly invited can get in.

Right now it opens in **demo mode** with sample data (nothing saves). Setup takes about 20–30 minutes the first time - most of it is Google Cloud Console - and everything used here is free for a team of two.

## 1. Create a Supabase project

1. Go to [supabase.com](https://supabase.com) and sign up / log in (free).
2. Click **New project**. Pick a name (e.g. "mr-priceless-crm") and a database password (save it somewhere safe), choose a region close to NZ (e.g. Sydney).
3. Wait ~2 minutes for it to finish provisioning.

## 2. Create the database tables

1. In your project, open **SQL Editor** (left sidebar) → **New query**.
2. Open [`sql/schema.sql`](sql/schema.sql), copy the whole file, paste it into the editor, and click **Run**. This creates `contacts`, `cold_calls`, `deals`, `notes`, and turns on realtime sync.
3. Open [`sql/002_invites_and_calendar.sql`](sql/002_invites_and_calendar.sql). Before running it, **edit the line near the top**:
   ```sql
   insert into allowlist (email, invited_by)
   values ('YOUR-EMAIL@example.com', 'setup')
   ```
   Replace `YOUR-EMAIL@example.com` with the Gmail/Google Workspace address you'll sign in with. This is what lets you into the app the first time - after that, you invite your partner from inside the app itself.
4. Paste the edited file into a new query and click **Run**. This adds the `allowlist` table (who's allowed in), the `google_tokens` table (each person's calendar connection), and re-locks `contacts`/`cold_calls`/`deals`/`notes` so only allowlisted people can touch them.

## 3. Connect the app to your project

1. In Supabase, go to **Project Settings → API**.
2. Copy the **Project URL** and the **anon public** key.
3. Open [`js/config.js`](js/config.js) and paste them in:

```js
window.CRM_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...",
};
```

4. Save the file. Reloading the app now shows a real "Sign in with Google" screen instead of the demo banner - but Google sign-in itself won't work yet until step 4 below.

## 4. Set up Google sign-in + Calendar access

This is the fiddly part - Google requires its own project, separate from Supabase.

**A. Create a Google Cloud project & OAuth credentials**
1. Go to the [Google Cloud Console](https://console.cloud.google.com/) → create a new project (e.g. "Mr Priceless CRM").
2. Go to **APIs & Services → Library**, search for **Google Calendar API**, and click **Enable**.
3. Go to **APIs & Services → OAuth consent screen**. Choose **External**, fill in the app name/support email, and add yourself and your partner as **Test users** (this keeps it free and private - no Google verification review needed for just the two of you).
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**. Application type: **Web application**.
5. You'll need Supabase's callback URL for the **Authorized redirect URIs** field. In Supabase, go to **Authentication → Providers → Google** to find it - it looks like `https://xxxxxxxx.supabase.co/auth/v1/callback`. Paste that into Google's redirect URIs and save.
6. Copy the **Client ID** and **Client Secret** Google gives you.

**B. Add Google as a sign-in provider in Supabase**
1. Back in Supabase: **Authentication → Providers → Google** → toggle it on.
2. Paste in the Client ID and Client Secret from step A. Save.

You don't need to put the Google Client ID anywhere in this app's code - Supabase handles the whole OAuth flow.

## 5. Deploy the two backend functions

Two small server-side functions live in [`supabase/functions/`](supabase/functions/): one sends invite emails, the other refreshes Google Calendar access. Both need the Supabase **service role key** and (for calendar) your Google **client secret** - sensitive values that must never go in front-end code, which is why they run as functions instead of living in `app.js`.

1. Install the Supabase CLI (macOS): `brew install supabase/tap/supabase`
2. From inside this `mr-priceless-crm` folder, run:
   ```
   supabase login
   supabase link --project-ref xxxxxxxx
   ```
   (Your project ref is the `xxxxxxxx` part of your Supabase project URL.)
3. Set the secrets the functions need (find the service role key at **Project Settings → API**, the Google values from step 4A):
   ```
   supabase secrets set SUPABASE_URL=https://xxxxxxxx.supabase.co
   supabase secrets set SUPABASE_ANON_KEY=eyJ...
   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=eyJ...
   supabase secrets set GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
   supabase secrets set GOOGLE_CLIENT_SECRET=xxxxx
   ```
4. Deploy both functions:
   ```
   supabase functions deploy invite-user
   supabase functions deploy refresh-google-token
   ```

## 6. Sign in for the first time

1. Reload the app and click **Sign in with Google**, using the email you put in the allowlist in step 2.
2. Google will ask you to confirm calendar access - accept it (this is what lets follow-ups sync to your calendar).
3. You're in. Go to the **Team** page and invite your business partner by email - they'll get an invite email, and once they sign in with Google using that same address, they're in too.

## 7. Deploy it so you can both access it from anywhere

This is a static folder, so any static host works.

**Netlify Drop (simplest, no account needed)**
1. Go to [app.netlify.com/drop](https://app.netlify.com/drop).
2. Drag the whole `mr-priceless-crm` folder onto the page.
3. You'll get a live URL immediately. Bookmark it and share it with your partner.

**Cloudflare Pages / GitHub Pages** also work if you'd prefer a custom domain later.

One extra step after deploying: add your live URL to Google Cloud Console under **OAuth consent screen → Authorized domains**, and add `https://your-live-url/` to Supabase's **Authentication → URL Configuration → Redirect URLs** - otherwise Google sign-in will only work on localhost.

## 8. Set up automated Meta Ads client reporting (optional)

The **Reporting** page can pull each client's ad performance straight from their Meta ad account and email it to them - either on demand ("Send Now") or fully automatically on a schedule (weekly/monthly, set per client). The database side of this is already live (columns on `clients`, the `client_reports` table, and a daily cron check are all set up). What's left is entirely on Meta's and Resend's side - things only you can do, since they involve your accounts.

**A. Create a Meta System User (this is what makes automation possible)**

A normal "Login with Facebook" token expires every ~60 days and needs a human to re-approve it, which defeats "fully automated." A **System User** token, created inside Business Manager, doesn't expire that way - it's Meta's own recommended approach for agency/unattended use.

1. Go to [business.facebook.com/settings](https://business.facebook.com/settings) → **Users → System Users**.
2. Click **Add**, give it a name (e.g. "Mr Priceless Reporting"), role **Admin** (or Employee - Admin is simpler for assigning assets).
3. Click **Add Assets**, select each client's ad account, and grant it at least **View performance** access.
4. Click **Generate New Token** on the System User. Select your Meta app (create one first in step B if you haven't), tick the **`ads_read`** permission, and set the expiration to **Never**.
5. Copy the token now - Meta only shows it once.

**B. Create a Meta App with the Marketing API**

1. Go to [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create App** → choose type **Business**.
2. Add the **Marketing API** product to the app.
3. This is the app you select when generating the System User token in step A.4 above.
4. For `ads_read` on ad accounts your own Business Manager already owns, this typically works without Meta's formal **App Review** - App Review is only required if you need access to ad accounts *outside* your own Business Manager. If a client's ad account isn't already shared into your Business Manager, add it as an asset first (client can do this from their end, or add your Business Manager as a partner).

**C. Sign up for Resend (sends the report emails)**

1. Go to [resend.com](https://resend.com) and create a free account.
2. **Domains** → add and verify a sending domain you control (e.g. `launchagency.co.nz`) by adding the DNS records Resend gives you - this avoids emails landing in spam.
3. **API Keys** → create a new key.

**D. Set the secrets and deploy the function**

From inside this `mr-priceless-crm` folder (same Supabase CLI setup as step 5):

```
supabase secrets set META_SYSTEM_USER_TOKEN=xxxxx
supabase secrets set RESEND_API_KEY=re_xxxxx
supabase secrets set REPORT_FROM_EMAIL="Mr Priceless <reports@yourdomain.co.nz>"
supabase secrets set REPORT_CRON_SECRET=xxxxx
```

`REPORT_CRON_SECRET` just needs to be any long random string - it's how the daily scheduled check authenticates itself to the function (it's already stored on the database side in Supabase Vault; use that same value here). Generate one with `openssl rand -hex 32` if you need a fresh one, but if you already have one saved from setup, reuse it.

Then deploy the function:

```
supabase functions deploy generate-client-reports
```

**E. Turn it on per client**

In the CRM, open a client → **Edit Client**, and fill in:
- **Meta Ad Account ID** (looks like `act_1234567890` - find it in Meta Ads Manager, top left)
- **Report Frequency** (weekly, monthly, or off)
- **Report Email** (where the client wants reports sent)

Once saved, that client shows up on the **Reporting** page. Reports send automatically once a day when they're due, or you can click **Send Now** any time for an ad-hoc report.

## 9. Set up real outbound calling in the Dialer (optional)

The **Dialer**'s "Call" button places a real phone call straight from the browser (your mic and speakers) to the prospect's number, using [Twilio](https://www.twilio.com) Voice. No SQL migration is needed for this - it reuses the existing `dial_prospects` fields. Two things need setting up: a Twilio phone number, and two Supabase secrets/functions.

**A. Twilio account, number, and TwiML App**

1. Sign up at [twilio.com/try-twilio](https://www.twilio.com/try-twilio) (or use an existing Twilio account/number if you already have one).
2. **Phone Numbers → Manage → Buy a number** - pick a number with **Voice** capability in whichever country you'll mostly be calling.
3. **Voice → Manage → TwiML Apps → Create new TwiML App**. Name it anything, and set the **Voice Request URL** to:
   ```
   https://xxxxxxxx.supabase.co/functions/v1/voice-twiml
   ```
   (replace `xxxxxxxx` with your Supabase project ref). Method: HTTP POST.
4. Go back to your phone number's settings (**Phone Numbers → Manage → Active Numbers** → click the number) and under **Voice Configuration**, set "A call comes in" to **TwiML App**, and select the app you just created.
5. **Account → API keys & tokens → Create API key**. Type: **Standard**. Copy the **SID** and **Secret** immediately - the secret is only shown once.
6. Note down your **Account SID** (Account → General settings), the **API Key SID + Secret**, the **TwiML App SID**, and the phone number you bought.

**B. Set the secrets and deploy the two functions**

```
supabase secrets set TWILIO_ACCOUNT_SID=ACxxxxx
supabase secrets set TWILIO_API_KEY_SID=SKxxxxx
supabase secrets set TWILIO_API_KEY_SECRET=xxxxx
supabase secrets set TWILIO_TWIML_APP_SID=APxxxxx
supabase secrets set TWILIO_CALLER_ID=+61xxxxxxxxx
supabase functions deploy voice-token
supabase functions deploy voice-twiml
```

`voice-token` mints a short-lived access token for whoever's signed in when they click Call - it never touches the browser without going through the allowlist check first. `voice-twiml` is what Twilio calls the instant a call connects, telling it which real number to dial and which of your numbers to show as caller ID - it's not a page anyone visits directly.

Once deployed, the Dialer's Call button starts making real calls immediately - no further app changes needed.

## How the pieces fit together

- **Login & access control**: sign-in is Google-only. The `allowlist` table is the actual gatekeeper - anyone can technically click "Sign in with Google," but the app checks their email against `allowlist` and shows a "not authorized" screen if they're not on it. Every table's Row Level Security policy re-checks the same allowlist, so even a signed-in-but-uninvited account can't read or write data.
- **Inviting people**: the Team page calls the `invite-user` Edge Function, which (a) adds the email to `allowlist` and (b) sends Supabase's built-in invite email - using the service role key, which only that function ever touches.
- **Calendar sync**: when you sign in, Google hands back a short-lived access token (used immediately) and a refresh token (saved to `google_tokens`, write-only from the browser). Clicking the calendar icon next to a cold call's follow-up date creates an event on *your own* Google Calendar. If your access token has expired, the app calls `refresh-google-token` to get a new one automatically.
- No build step, no npm - just `index.html`, `css/style.css`, and plain `js/*.js` files, talking to Supabase via its JS client loaded from a CDN.
