// Thin wrapper around the Supabase JS client (assets/vendor, loaded in index.html).
// Falls back to an in-memory demo dataset when no project has been configured yet,
// so the app is fully browsable before you finish Supabase setup.

const { SUPABASE_URL, SUPABASE_ANON_KEY } = window.CRM_CONFIG;
const IS_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

let supabaseClient = null;
if (IS_CONFIGURED) {
  if (window.supabase && window.supabase.createClient) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } else {
    // Without the library nothing can sign in - say so instead of a dead button.
    document.addEventListener("DOMContentLoaded", () => {
      const box = document.getElementById("auth-error");
      if (box) { box.textContent = "Couldn't load the sign-in tools. Refresh the page, and if it keeps happening, check your internet connection."; box.classList.add("visible"); }
    });
  }
}

window.CRM_DB = { supabase: supabaseClient, IS_CONFIGURED };
