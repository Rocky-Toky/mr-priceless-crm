// Thin wrapper around the Supabase JS client (loaded from CDN in index.html).
// Falls back to an in-memory demo dataset when no project has been configured yet,
// so the app is fully browsable before you finish Supabase setup.

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.CRM_CONFIG;
const IS_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let supabaseClient = null;
if (IS_CONFIGURED) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

window.CRM_DB = { supabase: supabaseClient, IS_CONFIGURED };
