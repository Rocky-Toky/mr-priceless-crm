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

## How the pieces fit together

- **Login & access control**: sign-in is Google-only. The `allowlist` table is the actual gatekeeper - anyone can technically click "Sign in with Google," but the app checks their email against `allowlist` and shows a "not authorized" screen if they're not on it. Every table's Row Level Security policy re-checks the same allowlist, so even a signed-in-but-uninvited account can't read or write data.
- **Inviting people**: the Team page calls the `invite-user` Edge Function, which (a) adds the email to `allowlist` and (b) sends Supabase's built-in invite email - using the service role key, which only that function ever touches.
- **Calendar sync**: when you sign in, Google hands back a short-lived access token (used immediately) and a refresh token (saved to `google_tokens`, write-only from the browser). Clicking the calendar icon next to a cold call's follow-up date creates an event on *your own* Google Calendar. If your access token has expired, the app calls `refresh-google-token` to get a new one automatically.
- No build step, no npm - just `index.html`, `css/style.css`, and plain `js/*.js` files, talking to Supabase via its JS client loaded from a CDN.
