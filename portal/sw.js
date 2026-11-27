/* Mr Priceless client portal - phone alerts (web push).
   The client-portal function sends an encrypted message to each device that
   turned alerts on; this shows it, and opens the lead when it's tapped. The
   "Did they get back to you?" alert gets Yes / No buttons where the phone
   supports them (Android, computers): No passes the lead to our team using
   the alert's one-off token, without opening the app. */
self.window = self; // js/config.js sets window.CRM_CONFIG
try { importScripts("../js/config.js"); } catch (e) {}
const CFG = self.CRM_CONFIG || {};

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// Opening the app: always the latest page from the network, with a plain
// "you're offline" page if there's no signal. Having a real fetch handler is
// also what lets Android offer the one-tap "Install app" prompt.
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui;background:#09090a;color:#f5efe0;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center;padding:24px"><div><h1 style="font-size:22px">You\'re offline</h1><p>Your leads will show again as soon as you have signal.</p></div>',
    { headers: { "Content-Type": "text/html" } })));
});

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: "Mr Priceless", body: e.data ? e.data.text() : "" }; }
  const opts = {
    body: d.body || "",
    icon: "icon-192.png",
    badge: "icon-192.png",
    tag: d.tag || undefined,
    renotify: !!d.tag,
    requireInteraction: d.kind === "checkin" || d.kind === "new_lead",
    data: { url: d.url || "./", lead: d.lead || null, kind: d.kind || null, token: d.token || null },
  };
  if (d.kind === "checkin" && d.token) opts.actions = [{ action: "yes", title: "Yes - update it" }, { action: "no", title: "No - pass to us" }];
  e.waitUntil(self.registration.showNotification(d.title || "Mr Priceless", opts));
});

async function openApp(data) {
  const scope = self.registration.scope;
  const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  for (const w of wins) {
    if (w.url.startsWith(scope)) {
      await w.focus();
      w.postMessage({ lead: data.lead, kind: data.kind });
      return;
    }
  }
  await self.clients.openWindow(new URL(data.url || "./", scope).href);
}

self.addEventListener("notificationclick", (e) => {
  const data = e.notification.data || {};
  e.notification.close();
  if (e.action === "no" && data.token && CFG.SUPABASE_URL) {
    e.waitUntil(fetch(CFG.SUPABASE_URL + "/rest/v1/rpc/portal_checkin_link", {
      method: "POST",
      headers: { apikey: CFG.SUPABASE_ANON_KEY, Authorization: "Bearer " + CFG.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ p_token: data.token, p_answer: "no" }),
    }).then((r) => {
      if (!r.ok) throw new Error("not saved");
      return self.registration.showNotification("Passed to Mr Priceless", { body: "Our team will follow them up for you.", icon: "icon-192.png", tag: "passed" });
    }).catch(() => self.clients.openWindow(new URL("./?checkin=" + encodeURIComponent(data.token), self.registration.scope).href)));
    return;
  }
  e.waitUntil(openApp(data));
});
