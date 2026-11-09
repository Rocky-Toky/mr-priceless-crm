/* Mr Priceless - client portal (portal/).
   A separate, small app for clients: their leads (best ones first, one tap to
   call or text), their ads and their account with us. It never loads the CRM
   (js/app.js) and never touches a table directly: everything comes through
   the portal_* database functions (sql/112), which only hand back the
   signed-in client's own rows and only the fields meant for them.
   With no Supabase config it runs on made-up demo data (for testing). */
(() => {
"use strict";

const CFG = window.CRM_CONFIG || {};
const IS_CONFIGURED = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
const sb = IS_CONFIGURED && window.supabase?.createClient ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
const NZ_TZ = "Pacific/Auckland";
const HANDOVER_MS = 24 * 3600e3;
const POLL_MS = 30e3;
const MANAGERS = {
  max: { name: "Max Smith", email: "maximus.smith@mrpriceless.com" },
  rocky: { name: "Rocky O'Neill", email: "rocky.oneill@mrpriceless.com" },
};
const OUTCOMES = {
  booked: { label: "Booked in", hint: "Quote, site visit or call booked", cls: "green", when: "When is it?" },
  call_back: { label: "Call back later", hint: "They asked you to ring another time", cls: "blue", when: "When should you ring?" },
  no_answer: { label: "No answer", hint: "Try again later", cls: "amber" },
  not_interested: { label: "Not interested", hint: "They don't want it any more", cls: "grey" },
  disqualified: { label: "Not a job for us", hint: "Too small, too far, not our work", cls: "grey" },
  wrong_number: { label: "Wrong number", hint: "The number doesn't reach them", cls: "grey" },
};
const STATUS = {
  new: "New", no_answer: "No answer yet", call_back: "Call back", booked: "Booked", site_visit: "Site visit booked",
  consult_call: "Consultation booked", qualified: "Interested", not_interested: "Not interested", disqualified: "Not a fit",
  wrong_number: "Wrong number", unreachable: "Couldn't reach them", in_ghl: "Moved on",
};
const OPEN = new Set(["new", "no_answer", "call_back"]);
const BOOKED = new Set(["booked", "site_visit", "consult_call"]);

const S = {
  me: null, client: null, leads: [], ads: [], tab: "leads", filter: "call", q: "",
  preview: null, openId: null, outcomeFor: null, dialledAt: 0, known: null, loaded: false,
  saving: false, pickOutcome: null,
};

/* ───────── little helpers ───────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "them";
const telHref = (p) => "tel:" + String(p || "").replace(/[^0-9+]/g, "");
const t = (iso) => iso ? new Date(iso).getTime() : 0;
const money = (n) => n == null || isNaN(n) ? "-" : "$" + Number(n).toLocaleString("en-NZ", { maximumFractionDigits: Number(n) < 100 ? 2 : 0 });
const num = (n) => n == null || isNaN(n) ? "-" : Number(n).toLocaleString("en-NZ");
function ago(iso){
  const m = Math.max(0, Math.round((Date.now() - t(iso)) / 60000));
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr${h === 1 ? "" : "s"} ago`;
  const d = Math.floor(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}
const when = (iso) => iso ? new Date(iso).toLocaleString("en-NZ", { timeZone: NZ_TZ, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : "";
const day = (iso) => iso ? new Date(iso).toLocaleDateString("en-NZ", { timeZone: NZ_TZ, day: "numeric", month: "long", year: "numeric" }) : "";
function hoursLeft(ms){
  const h = Math.max(0, ms / 3600e3);
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.floor(h)} hr${Math.floor(h) === 1 ? "" : "s"}`;
}
const isPhone = () => matchMedia("(pointer: coarse)").matches;
const readOnly = () => S.me?.viewer === "team";
function toast(msg){
  const el = $("#pp-toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3200);
}
const store = {
  get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch(e){} },
};

/* ───────── what they put on the form ───────── */
// "when_are_you_hoping_to_complete_the_project" -> "When are you hoping to complete the project?"
function prettyQ(q){
  let s = String(q || "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return "";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[?:.]$/.test(s) && /^(what|when|how|where|are|do|does|is|which|who|why|would|can|have|will)\b/i.test(s)) s += "?";
  return s;
}
function prettyA(a){
  let s = Array.isArray(a) ? a.join(", ") : String(a ?? "");
  s = s.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (/^asap$/i.test(s)) return "ASAP";
  return s && s === s.toLowerCase() ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
const answers = (l) => (Array.isArray(l.answers) ? l.answers : [])
  .map(x => ({ q: prettyQ(x.q ?? x.question ?? x.label), a: prettyA(x.a ?? x.answer ?? x.value) }))
  .filter(x => x.q && x.a);

// How good a lead looks, from what they told us and how fresh it is. Plain
// reasons go with it so the client can see why one's at the top.
function rate(l){
  let score = 0;
  const why = [], warn = [];
  const age = Date.now() - t(l.at);
  if (age < 3600e3){ score += 3; why.push("Just came in"); }
  else if (age < 24 * 3600e3) score += 2;
  else if (age < 72 * 3600e3) score += 1;
  const qa = answers(l);
  const find = (re) => qa.find(x => re.test(x.q));
  const timing = find(/when|time ?frame|timing|start|complete|how soon|hoping/i);
  if (timing){
    const a = timing.a.toLowerCase();
    if (/asap|a\.s\.a\.p|immediate|urgent|right away|straight away|now|this week|next week|within (a|1|one|2|two) (week|month)|0.?1 month|1 month|less than|under (a|1|one) month|next month|soon/.test(a)){ score += 3; why.push("Wants it done soon"); }
    else if (/1.?3 month|2.?3 month|1.?2 month|few weeks|couple of months|within 3/.test(a)){ score += 2; why.push("Within a few months"); }
    else if (/3.?6|6.?12|6\+|6 months|over 6|later|next year|not sure|unsure|just (looking|browsing|researching)|no rush|planning/.test(a)){ score -= 1; warn.push("Not in a hurry"); }
  }
  const budget = find(/budget|invest|spend|price range|how much/i);
  if (budget){
    const nums = (budget.a.toLowerCase().match(/\d[\d,.]*\s*k?/g) || []).map(s => { const k = /k/.test(s); const v = parseFloat(s.replace(/[^\d.]/g, "")); return k ? v * 1000 : v; }).filter(v => !isNaN(v));
    const top = nums.length ? Math.max(...nums) : null;
    if (top != null){
      if (top >= 20000){ score += 3; why.push(`Budget ${budget.a}`); }
      else if (top >= 10000){ score += 2; why.push(`Budget ${budget.a}`); }
      else if (top >= 3000){ score += 1; why.push(`Budget ${budget.a}`); }
      else if (top > 0 && top < 1500){ score -= 1; warn.push(`Small budget (${budget.a})`); }
    } else if (/not sure|unsure|don.?t know/i.test(budget.a)) {}
    else { score += 1; why.push(`Budget: ${budget.a}`); }
  }
  const own = find(/own|homeowner|owner/i);
  if (own){
    if (/^y|yes|own/i.test(own.a)){ score += 1; why.push("Owns the property"); }
    else if (/^n|no|rent|tenant/i.test(own.a)){ score -= 2; warn.push("Doesn't own the property"); }
  }
  if (find(/size|how big|m2|m²|square|metre|meter|length|area of/i)){ score += 1; why.push("Gave the size"); }
  if (qa.length >= 3){ score += 1; if (why.length < 3) why.push("Filled in the whole form"); }
  if (l.address || l.city) score += 1;
  if (!l.phone){ score -= 5; warn.push("No phone number"); }
  const tier = score >= 7 ? "hot" : score >= 4 ? "warm" : "cool";
  return { score, tier, label: { hot: "Hot", warm: "Warm", cool: "Cool" }[tier], why, warn };
}

/* ───────── which list a lead is in ───────── */
const isOpen = (l) => OPEN.has(l.status || "new");
const handover = (l) => l.client_calls && !l.ours && isOpen(l) ? t(l.at) + HANDOVER_MS : null;
const myTries = (l) => (l.log || []).filter(x => x.by === "you" && x.outcome === "no_answer").length;
function buckets(){
  const q = S.q.trim().toLowerCase();
  const match = (l) => !q || [l.name, l.phone, l.email, l.city, l.address, l.form, ...answers(l).map(x => x.a)].join(" ").toLowerCase().includes(q);
  const all = S.leads.filter(match);
  const byRank = (a, b) => rate(b).score - rate(a).score || t(b.at) - t(a.at);
  const call = all.filter(l => isOpen(l) && (l.status !== "call_back" || !l.call_back_at || t(l.call_back_at) <= Date.now() + 3600e3))
    .sort((a, b) => ((a.status || "new") === "new" ? 0 : 1) - ((b.status || "new") === "new" ? 0 : 1) || byRank(a, b));
  const later = all.filter(l => isOpen(l) && !call.includes(l)).sort((a, b) => t(a.call_back_at) - t(b.call_back_at));
  const booked = all.filter(l => BOOKED.has(l.status)).sort((a, b) => t(b.booked_for || b.at) - t(a.booked_for || a.at));
  return { all, call, later, booked };
}

/* ───────── data ───────── */
async function rpc(fn, args){
  if (!sb) return demoRpc(fn, args);
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw error;
  return data;
}
const clientArg = () => ({ p_client: S.preview || null });

async function loadAll(first){
  const me = await rpc("portal_me", clientArg());
  S.me = me; S.client = me.client;
  if (me.viewer === "team" && !S.preview) S.preview = me.client.id;
  const [leads, ads] = await Promise.all([rpc("portal_leads", { ...clientArg(), p_days: 120 }), rpc("portal_ads", clientArg())]);
  noticeNew(leads || [], first);
  S.leads = leads || []; S.ads = ads || [];
  S.loaded = true;
  render();
}
async function refreshLeads(){
  if (!S.loaded || document.hidden) return;
  try {
    const leads = await rpc("portal_leads", { ...clientArg(), p_days: 120 });
    noticeNew(leads || [], false);
    S.leads = leads || [];
    render();
  } catch(e){ console.warn(e); }
}

// A new lead while the portal's open: a chime, a flashing tab and (if they
// said yes) a phone/desktop notification.
function noticeNew(leads, first){
  const ids = new Set(leads.map(l => l.id));
  if (first || !S.known){ S.known = ids; return; }
  const fresh = leads.filter(l => !S.known.has(l.id) && Date.now() - t(l.at) < 6 * 3600e3);
  S.known = ids;
  if (!fresh.length || readOnly()) return;
  chime();
  flashTitle(`New lead: ${fresh[0].name || "someone"}`);
  if ("Notification" in window && Notification.permission === "granted"){
    try {
      const n = new Notification(`New lead: ${fresh[0].name || "someone"}`, { body: `Call ${firstName(fresh[0].name)} now - tap to open.`, icon: "icon-192.png", tag: fresh[0].id });
      n.onclick = () => { window.focus(); openLead(fresh[0].id); n.close(); };
    } catch(e){}
  }
}
function chime(){
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [880, 1320].forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
      const at = ctx.currentTime + i * 0.18;
      g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.25, at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      o.start(at); o.stop(at + 0.4);
    });
  } catch(e){}
}
let titleTimer = null;
function flashTitle(msg){
  const base = "Mr Priceless - Client portal";
  clearInterval(titleTimer);
  let on = false;
  titleTimer = setInterval(() => { document.title = (on = !on) ? msg : base; }, 1000);
  const stop = () => { if (!document.hidden){ clearInterval(titleTimer); document.title = base; } };
  setTimeout(stop, 3000);
  document.addEventListener("visibilitychange", stop, { once: true });
}

/* ───────── render ───────── */
function render(){
  if (!S.client) return;
  $("#pp-biz").textContent = S.client.name;
  document.title = "Mr Priceless - Client portal";
  const b = buckets();
  const toCall = S.leads.filter(l => isOpen(l) && (l.status || "new") === "new").length;
  const c = $("#pp-count"); c.hidden = !toCall; c.textContent = toCall;
  $$("#pp-tabs [data-tab]").forEach(x => x.classList.toggle("active", x.dataset.tab === S.tab));
  $$("[data-pane]").forEach(p => { p.hidden = p.dataset.pane !== S.tab; });
  renderPreview();
  if (S.tab === "leads") renderLeads(b);
  if (S.tab === "ads") renderAds();
  if (S.tab === "account") renderAccount();
  if (S.openId) renderSheet();
}

// The team sees any client's portal read-only; a client with more than one
// business can switch between them.
function renderPreview(){
  const el = $("#pp-preview"), list = S.me.clients || [];
  if (!readOnly() && list.length < 2){ el.hidden = true; return; }
  el.hidden = false;
  el.classList.toggle("team", readOnly());
  const pick = `<select id="pp-preview-client" aria-label="Business">${list.map(c => `<option value="${esc(c.id)}"${c.id === S.client.id ? " selected" : ""}>${esc(c.name)}</option>`).join("")}</select>`;
  el.innerHTML = readOnly() ? `<b>Team preview</b><span>This is what the client sees. Saving is switched off.</span>${pick}` : `<span>Business</span>${pick}`;
}

function leadRowHtml(l){
  const r = rate(l), qa = answers(l), open = isOpen(l);
  const ho = handover(l), left = ho ? ho - Date.now() : null;
  const where = l.city || l.address || "";
  const status = (l.status || "new") === "new" ? "" : `<span class="pp-st pp-st-${esc(l.status)}">${esc(l.status === "call_back" && l.call_back_at ? `Call back ${when(l.call_back_at)}` : BOOKED.has(l.status) && l.booked_for ? `Booked ${when(l.booked_for)}` : STATUS[l.status] || l.status)}</span>`;
  return `<li class="pp-lead${open ? "" : " done"}${!l.seen_at && (l.status || "new") === "new" ? " unseen" : ""}" data-open="${esc(l.id)}">
    <button type="button" class="pp-lead-main" data-open="${esc(l.id)}">
      <span class="pp-lead-top">
        ${open ? `<span class="pp-tier pp-${r.tier}">${r.label}</span>` : ""}
        <b class="pp-lead-name">${esc(l.name || "No name")}</b>
        <span class="pp-lead-when">${esc(ago(l.at))}</span>
      </span>
      <span class="pp-lead-sub">${esc([l.form, where].filter(Boolean).join(" · "))}</span>
      ${qa.length ? `<span class="pp-lead-qa">${qa.slice(0, 3).map(x => `<span><i>${esc(shortQ(x.q))}</i> ${esc(x.a)}</span>`).join("")}</span>` : ""}
      <span class="pp-lead-tags">${status}
        ${open && r.why.length ? r.why.slice(0, 2).map(w => `<span class="pp-why">${esc(w)}</span>`).join("") : ""}
        ${l.ours && open && l.client_calls ? `<span class="pp-ours">Mr Priceless is following up</span>` : ""}
        ${!l.client_calls && open ? `<span class="pp-ours">Our team is calling them</span>` : ""}
        ${left != null ? `<span class="pp-clock${left < 4 * 3600e3 ? " soon" : ""}">${esc(hoursLeft(left))} before we step in</span>` : ""}
      </span>
    </button>
    ${l.phone ? `<a class="pp-call-round" href="${esc(telHref(l.phone))}" data-dial="${esc(l.id)}" aria-label="Call ${esc(l.name || "them")}">☎</a>` : ""}
  </li>`;
}
// "What are you looking to invest?" -> "Invest:" for the one-line summary.
function shortQ(q){
  const s = q.replace(/\?$/, "");
  const m = s.match(/(budget|invest|size|how big|when|where|suburb|area|timeframe|start|project|service|job|type)/i);
  if (/budget|invest|spend/i.test(s)) return "Budget:";
  if (/when|timeframe|time frame|start|complete|how soon/i.test(s)) return "When:";
  if (/size|how big|m2|square|metre/i.test(s)) return "Size:";
  if (/where|suburb|area|location|address/i.test(s)) return "Where:";
  return (m ? s : s.split(" ").slice(0, 4).join(" ")) + ":";
}

function renderLeads(b){
  const el = $("#pp-leads");
  const counts = { call: b.call.length, later: b.later.length, booked: b.booked.length, all: b.all.length };
  const list = { call: b.call, later: b.later, booked: b.booked, all: b.all }[S.filter] || b.call;
  const empty = {
    call: S.leads.length ? "Nobody waiting for a call. Nice work." : "No leads yet. They'll show up here the moment they come in.",
    later: "No call-backs or second tries waiting.",
    booked: "Nothing booked yet.",
    all: "No leads match that.",
  }[S.filter];
  const newCount = b.call.filter(l => (l.status || "new") === "new").length;
  const alertsOff = "Notification" in window && Notification.permission === "default" && !readOnly();
  el.innerHTML = `
    <div class="pp-hero">
      <div>
        <h1>${newCount ? `${newCount} new lead${newCount === 1 ? "" : "s"} to call` : "Your leads"}</h1>
        <p>${newCount ? "Best ones first. Ring within 5 minutes and you're far more likely to win the job." : `${statsLine()}`}</p>
      </div>
      ${alertsOff ? `<button type="button" class="pp-btn pp-btn-dark" data-act="alerts">🔔 Alert me to new leads</button>` : ""}
    </div>
    ${S.client.client_calls ? `<p class="pp-rule">You call your leads. Any you haven't spoken to within 24 hours, the Mr Priceless team follows up for you.</p>` : ""}
    <div class="pp-filter">
      <div class="pp-pills" role="tablist">
        ${[["call", "To call"], ["later", "Later"], ["booked", "Booked"], ["all", "All"]].map(([k, label]) => `<button type="button" data-filter="${k}" class="${S.filter === k ? "active" : ""}">${label}<b>${counts[k]}</b></button>`).join("")}
      </div>
      <input type="search" id="pp-search" placeholder="Search name, phone, suburb" value="${esc(S.q)}" aria-label="Search leads">
    </div>
    ${list.length ? `<ul class="pp-list">${list.map(leadRowHtml).join("")}</ul>` : `<div class="pp-empty">${esc(empty)}</div>`}`;
}
function statsLine(){
  const d30 = S.leads.filter(l => Date.now() - t(l.at) < 30 * 86400e3);
  const booked = d30.filter(l => BOOKED.has(l.status)).length;
  return d30.length ? `${d30.length} lead${d30.length === 1 ? "" : "s"} in the last 30 days, ${booked} booked.` : "Your leads show up here the moment they come in.";
}

/* ───────── one lead ───────── */
function openLead(id){
  const l = S.leads.find(x => x.id === id);
  if (!l) return;
  // The phone's back button closes the lead instead of leaving the portal.
  if (!S.openId) try { history.pushState({ lead: id }, ""); } catch(e){}
  S.openId = id; S.pickOutcome = null;
  $("#pp-sheet-wrap").hidden = false;
  document.body.classList.add("pp-locked");
  renderSheet();
  $("#pp-sheet").scrollTop = 0;
  if (!readOnly() && !l.seen_at){ l.seen_at = new Date().toISOString(); rpc("portal_log_call", { p_lead: id, p_outcome: "seen" }).catch(() => {}); }
}
function closeLead(){
  if (history.state?.lead){ history.back(); return; }
  shutLead();
}
function shutLead(){
  S.openId = null; S.outcomeFor = null; S.pickOutcome = null;
  $("#pp-sheet-wrap").hidden = true;
  document.body.classList.remove("pp-locked");
  render();
}
function renderSheet(){
  const l = S.leads.find(x => x.id === S.openId);
  if (!l){ closeLead(); return; }
  const r = rate(l), qa = answers(l), open = isOpen(l), first = firstName(l.name);
  const ho = handover(l);
  const sms = smsHref(l);
  const asking = S.outcomeFor === l.id;
  const o = S.pickOutcome;
  $("#pp-sheet").innerHTML = `
    <div class="pp-sheet-head">
      <button type="button" class="pp-back" data-act="close" aria-label="Back to leads">‹ Leads</button>
      ${open ? `<span class="pp-tier pp-${r.tier}">${r.label} lead</span>` : `<span class="pp-st pp-st-${esc(l.status)}">${esc(STATUS[l.status] || l.status)}</span>`}
    </div>
    <h2 class="pp-sheet-name">${esc(l.name || "No name")}</h2>
    <p class="pp-sheet-sub">Came in ${esc(ago(l.at))} · ${esc(when(l.at))}${l.form ? ` · ${esc(l.form)}` : ""}</p>
    ${ho ? `<p class="pp-clock-big${ho - Date.now() < 4 * 3600e3 ? " soon" : ""}">${esc(hoursLeft(ho - Date.now()))} left to call before the Mr Priceless team steps in</p>` : ""}
    ${l.ours && open && l.client_calls ? `<p class="pp-clock-big us">The Mr Priceless team is following ${esc(first)} up for you.</p>` : ""}
    ${!l.client_calls && open ? `<p class="pp-clock-big us">Our team is calling ${esc(first)} for you. You can still ring them yourself.</p>` : ""}

    ${l.phone ? `<div class="pp-actions">
      <a class="pp-btn pp-btn-call" href="${esc(telHref(l.phone))}" data-dial="${esc(l.id)}">☎ Call ${esc(first)}</a>
      <a class="pp-btn pp-btn-light" href="${esc(sms)}" data-text="${esc(l.id)}">✉ Text</a>
      ${l.email ? `<a class="pp-btn pp-btn-light" href="mailto:${esc(l.email)}">@ Email</a>` : ""}
    </div>
    <p class="pp-number">${esc(l.phone)} <button type="button" class="pp-link" data-copy="${esc(l.phone)}">Copy</button>${isPhone() ? "" : `<span class="pp-hint"> · On a computer? Dial it on your phone, then come back and tap what happened.</span>`}</p>`
    : `<p class="pp-warn">No phone number came through${l.email ? ` - email ${esc(first)} at <a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ""}.</p>`}

    ${open && (r.why.length || r.warn.length) ? `<div class="pp-reasons">${r.why.map(w => `<span class="pp-why">✓ ${esc(w)}</span>`).join("")}${r.warn.map(w => `<span class="pp-warnchip">! ${esc(w)}</span>`).join("")}</div>` : ""}

    <section class="pp-block">
      <h3>What they told us</h3>
      ${qa.length ? `<dl class="pp-qa">${qa.map(x => `<dt>${esc(x.q)}</dt><dd>${esc(x.a)}</dd>`).join("")}</dl>` : `<p class="pp-muted">No form answers came through with this lead.</p>`}
      ${l.scope ? `<dl class="pp-qa"><dt>The job</dt><dd>${esc(l.scope)}</dd></dl>` : ""}
    </section>
    <section class="pp-block pp-grid2">
      ${l.address || l.city ? `<div><h3>Where</h3><p>${esc(l.address || l.city)}</p><a class="pp-link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.address || l.city)}">Open in Maps</a></div>` : ""}
      ${l.email ? `<div><h3>Email</h3><p><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></p></div>` : ""}
      ${l.ad || l.campaign ? `<div><h3>The ad they saw</h3><p>${esc(l.ad || l.campaign)}</p></div>` : ""}
      ${BOOKED.has(l.status) && l.booked_for ? `<div><h3>Booked for</h3><p>${esc(when(l.booked_for))}</p></div>` : ""}
    </section>
    ${open || asking ? outcomeHtml(l, asking, o) : ""}
    ${(l.log || []).length ? `<section class="pp-block"><h3>Calls so far</h3><ol class="pp-log">${l.log.slice().reverse().map(x => `<li><b>${esc((OUTCOMES[x.outcome]?.label) || STATUS[x.outcome] || x.outcome)}</b><span>${esc(when(x.at))} · ${x.by === "you" ? "You" : "Mr Priceless"}</span>${x.note ? `<p>${esc(x.note)}</p>` : ""}</li>`).join("")}</ol></section>` : ""}
    ${!open ? `<button type="button" class="pp-link pp-reopen" data-act="ask">Spoke to them again? Update it</button>` : ""}`;
  const note = $("#pp-note");
  if (note && S.noteDraft?.[l.id]) note.value = S.noteDraft[l.id];
}
function outcomeHtml(l, asking, o){
  const first = firstName(l.name);
  const def = o && OUTCOMES[o]?.when ? defaultWhen(o) : "";
  return `<section class="pp-block pp-outcome${asking ? " asking" : ""}" id="pp-outcome">
    <h3>${asking ? `How did it go with ${esc(first)}?` : "After you've called, tap what happened"}</h3>
    <div class="pp-outs">${Object.entries(OUTCOMES).map(([k, v]) => `<button type="button" class="pp-out pp-out-${v.cls}${o === k ? " picked" : ""}" data-out="${k}"><b>${esc(v.label)}</b><small>${esc(v.hint)}</small></button>`).join("")}</div>
    ${o ? `<div class="pp-out-form">
      ${OUTCOMES[o].when ? `<label>${esc(OUTCOMES[o].when)}${o === "booked" ? " <small>(optional)</small>" : ""}<input type="datetime-local" id="pp-when" value="${esc(def)}"></label>` : ""}
      <label>Note <small>(optional)</small><textarea id="pp-note" rows="2" placeholder="${o === "no_answer" ? "e.g. Left a voicemail" : "Anything worth remembering"}"></textarea></label>
      <button type="button" class="pp-btn pp-btn-gold pp-btn-big" data-act="save-outcome"${S.saving ? " disabled" : ""}>Save: ${esc(OUTCOMES[o].label)}</button>
    </div>` : ""}
  </section>`;
}
function defaultWhen(o){
  const d = new Date(Date.now() + (o === "call_back" ? 3 * 3600e3 : 86400e3));
  d.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function smsHref(l){
  const me = (S.me?.name || "").trim().split(/\s+/)[0];
  const biz = String(S.client?.name || "").replace(/\s+[-–|(].*$/, "").replace(/[,.]?\s+(ltd|limited)\.?$/i, "").trim();
  const msg = `Hi ${firstName(l.name)}, ${me ? `it's ${me} from ${biz}` : `${biz} here`}. Thanks for your enquiry${l.form ? ` about ${l.form.toLowerCase()}` : ""}! When's a good time for a quick call?`;
  return `sms:${String(l.phone || "").replace(/[^0-9+]/g, "")}${/iPhone|iPad|Mac/i.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(msg)}`;
}

async function saveOutcome(){
  const l = S.leads.find(x => x.id === S.openId), o = S.pickOutcome;
  if (!l || !o) return;
  if (readOnly()){ toast("Preview only - the client saves this from their login."); return; }
  const whenVal = $("#pp-when")?.value;
  const note = ($("#pp-note")?.value || "").trim();
  if (o === "call_back" && !whenVal){ toast("Pick when to ring them."); return; }
  const at = whenVal ? new Date(whenVal).toISOString() : null;
  S.saving = true; renderSheet();
  try {
    await rpc("portal_log_call", { p_lead: l.id, p_outcome: o, p_note: note || null, p_when: at });
    const now = new Date().toISOString();
    l.log = [...(l.log || []), { at: now, by: "you", outcome: o, note, when: at }];
    if (o === "no_answer"){ if ((l.status || "new") === "new") l.status = "no_answer"; }
    else l.status = o;
    if (o === "call_back") l.call_back_at = at;
    if (o === "booked") l.booked_for = at;
    if (S.noteDraft) delete S.noteDraft[l.id];
    toast(o === "no_answer" ? `Saved. ${firstName(l.name)} stays in your list to try again.` : `Saved: ${OUTCOMES[o].label}.`);
    S.saving = false;
    closeLead();
  } catch(e){
    S.saving = false; renderSheet();
    toast("Couldn't save that - check your internet and try again.");
    console.warn(e);
  }
}

/* ───────── ads ───────── */
// delivery_status from the ad sync: active / learning / learning_limited are all running.
const adOn = (a) => /^(active|learning|learning_limited)$/i.test(String(a.status || "").trim());
function renderAds(){
  const el = $("#pp-ads");
  const ads = S.ads || [];
  const live = ads.filter(adOn);
  const spend = ads.reduce((s, a) => s + (Number(a.spend) || 0), 0);
  const results = ads.reduce((s, a) => s + (Number(a.results) || 0), 0);
  const d30 = S.leads.filter(l => Date.now() - t(l.at) < 30 * 86400e3).length;
  const d7 = S.leads.filter(l => Date.now() - t(l.at) < 7 * 86400e3).length;
  const updated = ads.map(a => a.updated_at).filter(Boolean).sort().pop();
  el.innerHTML = `
    <div class="pp-hero"><div><h1>Your ads</h1><p>${live.length ? `${live.length} ad${live.length === 1 ? "" : "s"} running right now.` : ads.length ? "No ads running right now." : "Your ads will show here once they're live."}</p></div></div>
    <div class="pp-stats">
      <div><span>Leads this week</span><b>${d7}</b></div>
      <div><span>Leads in 30 days</span><b>${d30}</b></div>
      <div><span>Spent on ads</span><b>${spend ? money(spend) : "-"}</b><small>all time</small></div>
      <div><span>Cost per lead</span><b>${spend && results ? money(spend / results) : "-"}</b><small>all time</small></div>
    </div>
    ${ads.length ? `<ul class="pp-ads">${ads.map(a => {
      const on = adOn(a);
      return `<li class="pp-ad">
        <div class="pp-ad-img">${a.image ? `<img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : `<span>${a.media === "video" ? "▶" : "Ad"}</span>`}</div>
        <div class="pp-ad-body">
          <b>${esc(a.name)}</b>
          ${a.campaign ? `<small>${esc(a.campaign)}</small>` : ""}
          <span class="pp-ad-st ${on ? "on" : ""}">${on ? "Running" : /review|process|preapproved/i.test(a.status || "") ? "Waiting on Facebook's review" : "Not running"}</span>
          <div class="pp-ad-nums">
            <span><i>Leads</i>${num(a.results)}</span>
            <span><i>Spent</i>${money(a.spend)}</span>
            <span><i>Per lead</i>${a.cost_per_result != null ? money(a.cost_per_result) : a.spend && a.results ? money(a.spend / a.results) : "-"}</span>
          </div>
        </div>
      </li>`; }).join("")}</ul>` : ""}
    <p class="pp-muted pp-small">Numbers come from Facebook and cover each ad's whole life${updated ? `, last updated ${esc(ago(updated))}` : ""}.</p>`;
}

/* ───────── account ───────── */
function nextReport(c){
  const fourteen = 14 * 86400e3;
  if (c.report_anchor){
    let d = new Date(c.report_anchor + "T09:00:00").getTime();
    while (d < Date.now() - 86400e3) d += fourteen;
    return new Date(d).toISOString();
  }
  if (c.last_report_at) return new Date(t(c.last_report_at) + fourteen).toISOString();
  return null;
}
function renderAccount(){
  const el = $("#pp-account"), c = S.client;
  const m = MANAGERS[c.manager] || MANAGERS.rocky;
  const stage = { onboarding: "Getting set up", quote_guarantee: "Quote guarantee", live: "Ads live", finished: "Finished" }[c.stage] || "Ads live";
  const next = nextReport(c);
  const qg = c.stage === "quote_guarantee" && c.quote_target;
  const pct = qg ? Math.min(100, Math.round((Number(c.quotes_sent) || 0) / c.quote_target * 100)) : 0;
  const canNotify = "Notification" in window;
  el.innerHTML = `
    <div class="pp-hero"><div><h1>${esc(c.name)}</h1><p>Working with Mr Priceless since ${esc(new Date(c.since).toLocaleDateString("en-NZ", { month: "long", year: "numeric" }))}.</p></div></div>
    <div class="pp-cards">
      <div class="pp-card"><span>Where we're at</span><b>${esc(stage)}</b>
        ${qg ? `<div class="pp-bar"><i style="width:${pct}%"></i></div><small>${num(c.quotes_sent || 0)} of ${num(c.quote_target)} quotes delivered</small>` : ""}
        ${c.ads_since ? `<small>Ads running since ${esc(day(c.ads_since))}</small>` : ""}</div>
      <div class="pp-card"><span>Your next report</span><b>${next ? esc(new Date(next).toLocaleDateString("en-NZ", { timeZone: NZ_TZ, weekday: "short", day: "numeric", month: "short" })) : "We'll let you know"}</b>
        ${c.last_report_at ? `<small>Last one ${esc(day(c.last_report_at))}</small>` : "<small>Every two weeks</small>"}</div>
      ${c.monthly_ad_spend ? `<div class="pp-card"><span>Ad budget</span><b>${money(c.monthly_ad_spend)}<small> / month</small></b></div>` : ""}
      ${c.services ? `<div class="pp-card"><span>What we do for you</span><p>${esc(c.services)}</p></div>` : ""}
    </div>
    <section class="pp-block pp-manager">
      <h3>Your account manager</h3>
      <div><b>${esc(m.name)}</b><a class="pp-btn pp-btn-light" href="mailto:${esc(m.email)}?subject=${encodeURIComponent(c.name)}">Email ${esc(m.name.split(" ")[0])}</a></div>
    </section>
    <section class="pp-block">
      <h3>How your leads work</h3>
      ${c.client_calls ? `<ol class="pp-steps"><li>A lead fills in the form on your ad.</li><li>It shows up here straight away${S.me.notify_new_leads ? " and we email you" : ""}.</li><li>You call them - the best ones are at the top.</li><li>Tap what happened after each call.</li><li>Anyone you haven't spoken to within 24 hours, our team follows up for you.</li></ol>`
        : `<ol class="pp-steps"><li>A lead fills in the form on your ad.</li><li>Our team rings them fast and books them in with you.</li><li>You can see every lead, what they told us and how the call went, right here.</li></ol>`}
    </section>
    <section class="pp-block pp-settings">
      <h3>Settings</h3>
      ${readOnly() ? `<p class="pp-muted">Settings are the client's own - not shown in the team preview.</p>` : `
      <label class="pp-switch"><input type="checkbox" id="pp-notify"${S.me.notify_new_leads ? " checked" : ""}><span>Email me each new lead</span></label>
      ${canNotify ? `<div class="pp-row"><span>Alerts on this ${isPhone() ? "phone" : "computer"}</span>${Notification.permission === "granted" ? `<b class="pp-ok">On</b>` : Notification.permission === "denied" ? `<small>Blocked in your browser settings</small>` : `<button type="button" class="pp-btn pp-btn-light" data-act="alerts">Turn on</button>`}</div>` : ""}
      <p class="pp-muted pp-small">${/iPhone|iPad/i.test(navigator.userAgent) ? "Tip: tap Share, then Add to Home Screen, so your leads are one tap away." : "Tip: add this page to your phone's home screen so your leads are one tap away."}</p>
      <div class="pp-row"><span>Signed in as ${esc(S.me.email || "")}</span><button type="button" class="pp-btn pp-btn-light" data-act="signout">Sign out</button></div>
      <button type="button" class="pp-link" data-act="change-pw">Change my password</button>`}
    </section>`;
}

/* ───────── events ───────── */
function bind(){
  document.addEventListener("click", async (e) => {
    const tab = e.target.closest("[data-tab]");
    if (tab){ S.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }
    const f = e.target.closest("[data-filter]");
    if (f){ S.filter = f.dataset.filter; render(); return; }
    const dial = e.target.closest("[data-dial]");
    if (dial){
      // The phone app opens; when they come back, ask how it went.
      const id = dial.dataset.dial;
      S.outcomeFor = id; S.dialledAt = Date.now();
      if (!readOnly()) rpc("portal_log_call", { p_lead: id, p_outcome: "dialled" }).catch(() => {});
      if (!isPhone()) setTimeout(() => { if (S.openId !== id) openLead(id); else renderSheet(); }, 600);
      return;
    }
    const txt = e.target.closest("[data-text]");
    if (txt){ S.outcomeFor = txt.dataset.text; S.dialledAt = Date.now(); return; }
    const open = e.target.closest("[data-open]");
    if (open && !e.target.closest("a")){ openLead(open.dataset.open); return; }
    const out = e.target.closest("[data-out]");
    if (out){
      if (S.noteDraft === undefined) S.noteDraft = {};
      const note = $("#pp-note"); if (note && S.openId) S.noteDraft[S.openId] = note.value;
      S.pickOutcome = out.dataset.out; renderSheet();
      $("#pp-outcome")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (copy){ try { await navigator.clipboard.writeText(copy.dataset.copy); toast("Number copied."); } catch(err){ toast(copy.dataset.copy); } return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "close") closeLead();
    else if (act === "save-outcome") saveOutcome();
    else if (act === "ask"){ S.outcomeFor = S.openId; renderSheet(); }
    else if (act === "alerts") askAlerts();
    else if (act === "signout") signOut();
    else if (act === "change-pw") showSetPassword(true);
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "pp-search"){
      S.q = e.target.value;
      const pos = e.target.selectionStart;
      renderLeads(buckets());
      const s = $("#pp-search"); s.focus(); try { s.setSelectionRange(pos, pos); } catch(err){}
    }
    if (e.target.id === "pp-note" && S.openId){ S.noteDraft = S.noteDraft || {}; S.noteDraft[S.openId] = e.target.value; }
  });
  document.addEventListener("change", async (e) => {
    if (e.target.id === "pp-preview-client"){
      S.preview = e.target.value; store.set("mpp_preview_client", S.preview);
      S.known = null; if (S.openId) shutLead();
      await loadAll(true).catch(showError);
    }
    if (e.target.id === "pp-notify"){
      const on = e.target.checked;
      try { await rpc("portal_set_notify", { p_on: on }); S.me.notify_new_leads = on; toast(on ? "We'll email you each new lead." : "New lead emails are off."); }
      catch(err){ e.target.checked = !on; toast("Couldn't save that - try again."); }
    }
  });
  $("#pp-sheet-wrap").addEventListener("click", (e) => { if (e.target.id === "pp-sheet-wrap") closeLead(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.openId) closeLead(); });
  // Back from the phone app: open the lead and ask how the call went.
  const back = () => {
    if (document.hidden) return;
    refreshLeads();
    if (S.outcomeFor && Date.now() - S.dialledAt > 2500){
      const id = S.outcomeFor;
      if (S.openId !== id) openLead(id);
      S.outcomeFor = id; renderSheet();
      setTimeout(() => $("#pp-outcome")?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
    }
  };
  document.addEventListener("visibilitychange", back);
  window.addEventListener("focus", back);
  window.addEventListener("popstate", () => { if (S.openId) shutLead(); });
  setInterval(refreshLeads, POLL_MS);
  // Countdown clocks move on even when nothing new arrives.
  setInterval(() => { if (S.loaded && !S.openId && S.tab === "leads" && !document.hidden && document.activeElement?.id !== "pp-search") render(); }, 60e3);
}
async function askAlerts(){
  if (!("Notification" in window)) return toast("This browser can't show alerts - add the portal to your home screen instead.");
  const p = await Notification.requestPermission();
  toast(p === "granted" ? "Done - you'll get an alert when a new lead comes in while the portal is open." : "Alerts are off. You can turn them on in your browser settings.");
  render();
}

/* ───────── sign in ───────── */
function showScreen(id){
  ["pp-auth", "pp-noaccess", "pp-app"].forEach(x => { $("#" + x).hidden = x !== id; });
}
function authMsg(id, msg){ const el = $(id); el.textContent = msg || ""; el.classList.toggle("on", !!msg); }
function showSetPassword(fromAccount){
  showScreen("pp-auth");
  $("#pp-signin").hidden = true; $("#pp-setpw").hidden = false;
  S.pwFromAccount = !!fromAccount;
}
async function signOut(){
  if (sb) await sb.auth.signOut().catch(() => {});
  location.replace(location.pathname);
}
function showError(e){
  console.warn(e);
  const msg = String(e?.message || e || "");
  if (/not allowed/i.test(msg)){ showScreen("pp-noaccess"); return; }
  showScreen("pp-app");
  $("#pp-leads").innerHTML = `<div class="pp-empty">Couldn't load your leads. Check your internet, then <button type="button" class="pp-link" onclick="location.reload()">try again</button>.</div>`;
}
async function start(session){
  showScreen("pp-app");
  $("#pp-leads").innerHTML = `<div class="pp-empty">Loading your leads…</div>`;
  const params = new URLSearchParams(location.search);
  const want = params.get("client");
  S.preview = want || store.get("mpp_preview_client") || null;
  try {
    await loadAll(true);
  } catch(e){
    // A saved or linked client this login can't see: try again without it.
    if (S.preview){ S.preview = null; try { await loadAll(true); } catch(e2){ return showError(e2); } }
    else return showError(e);
  }
  if (S.me.viewer !== "team" && (S.me.clients || []).length < 2) S.preview = null;
  const lead = params.get("lead");
  if (lead){ history.replaceState(null, "", location.pathname); openLead(lead); }
}
async function init(){
  bind();
  $("#pp-signin").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#pp-signin-btn");
    authMsg("#pp-auth-msg", "");
    btn.disabled = true; btn.textContent = "Signing in…";
    const { error } = await sb.auth.signInWithPassword({ email: $("#pp-email").value.trim(), password: $("#pp-password").value });
    btn.disabled = false; btn.textContent = "Sign in";
    if (error) authMsg("#pp-auth-msg", /invalid/i.test(error.message) ? "That email and password don't match. Try again, or tap Forgot your password." : error.message);
  });
  $("#pp-forgot").addEventListener("click", async () => {
    const email = $("#pp-email").value.trim();
    if (!email) return authMsg("#pp-auth-msg", "Type your email above first, then tap this again.");
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    authMsg("#pp-auth-msg", error ? error.message : "Check your email for a link to choose a new password.");
  });
  $("#pp-setpw").addEventListener("submit", async (e) => {
    e.preventDefault();
    const a = $("#pp-newpw").value, b = $("#pp-newpw2").value;
    if (a.length < 8) return authMsg("#pp-setpw-msg", "Make it at least 8 characters.");
    if (a !== b) return authMsg("#pp-setpw-msg", "Those two don't match.");
    if (!sb) return showScreen("pp-app");
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) return authMsg("#pp-setpw-msg", error.message);
    $("#pp-setpw").hidden = true; $("#pp-signin").hidden = false;
    toast("Password saved.");
    const { data: { session } } = await sb.auth.getSession();
    if (session) start(session); else showScreen("pp-auth");
  });

  if (!sb){
    if (IS_CONFIGURED){ showScreen("pp-auth"); authMsg("#pp-auth-msg", "Couldn't load the sign-in tools. Refresh the page."); return; }
    return start(null);
  }
  // Opened from a "choose your password" email.
  const link = new URLSearchParams(location.hash.replace(/^#/, "") + "&" + location.search.replace(/^\?/, ""));
  const recovery = ["recovery", "invite"].includes(link.get("type"));
  const linkError = link.get("error_description");
  const { data: { session } } = await sb.auth.getSession();
  if (recovery || linkError) history.replaceState(null, "", location.pathname);
  if (session && recovery) showSetPassword();
  else if (session) start(session);
  else {
    showScreen("pp-auth");
    if (linkError) authMsg("#pp-auth-msg", "That link has expired or was already used. Type your email and tap Forgot your password to get a new one.");
  }
  sb.auth.onAuthStateChange((event, s) => {
    if (event === "PASSWORD_RECOVERY") showSetPassword();
    else if (event === "SIGNED_IN" && s && !S.loaded && $("#pp-setpw").hidden) start(s);
    else if (event === "SIGNED_OUT") location.replace(location.pathname);
  });
}

/* ───────── demo data (no Supabase config: testing only) ───────── */
let demo = null;
function demoData(){
  if (demo) return demo;
  const ago = (m) => new Date(Date.now() - m * 60e3).toISOString();
  const access = store.get("mpp_demo_viewer") || "client";
  demo = {
    me: { viewer: access, email: access === "team" ? "demo@mrpriceless.co.nz" : "brett@bbbuild.co.nz", name: "Brett", notify_new_leads: true,
      clients: access === "team" ? [{ id: "c1", name: "BB Build Ltd" }, { id: "c2", name: "A and B Concrete" }] : [{ id: "c1", name: "BB Build Ltd" }] },
    client: { id: "c1", name: "BB Build Ltd", stage: "quote_guarantee", quote_target: 10, quotes_sent: 4, since: ago(60 * 24 * 75), ads_since: ago(60 * 24 * 60).slice(0, 10),
      monthly_ad_spend: 1500, services: "Facebook and Instagram ads, lead follow-up and fortnightly reports.", client_calls: true, manager: "max", report_anchor: null, last_report_at: ago(60 * 24 * 6) },
    leads: [
      { id: "l1", name: "Hemi Walker", phone: "021 555 0148", email: "hemi.w@example.co.nz", at: ago(3), form: "Driveway quote", city: "Albany, Auckland", address: "12 Kauri Road, Albany",
        answers: [{ q: "What do you need done?", a: "Whole driveway replaced, about 60m2" }, { q: "what_are_you_looking_to_invest", a: "$15,000 - $20,000" }, { q: "when_are_you_hoping_to_get_it_done", a: "asap" }, { q: "Do you own the property?", a: "Yes" }],
        ad: "Driveway before/after - video", status: "new", client_calls: true, ours: false, log: [] },
      { id: "l2", name: "Sarah Lin", phone: "027 555 0172", email: "", at: ago(42), form: "Patio", city: "Hamilton East",
        answers: [{ q: "when_are_you_hoping_to_complete_the_project", a: "3-6_months" }, { q: "Budget", a: "Not sure" }], status: "new", client_calls: true, ours: false, log: [], seen_at: ago(30) },
      { id: "l3", name: "Tom Fraser", phone: "022 555 0190", email: "tom@example.com", at: ago(60 * 20), form: "Retaining wall", city: "Te Atatū",
        answers: [{ q: "What's the job?", a: "Retaining wall, 12m long" }, { q: "Budget", a: "$8k" }], status: "no_answer", client_calls: true, ours: false,
        log: [{ at: ago(60 * 19), by: "you", outcome: "no_answer", note: "Left a voicemail" }] },
      { id: "l4", name: "Aroha Pene", phone: "021 555 0111", email: "", at: ago(60 * 30), form: "Driveway quote", city: "Howick",
        answers: [{ q: "When", a: "Next month" }], status: "no_answer", client_calls: true, ours: true,
        log: [{ at: ago(60 * 5), by: "Mr Priceless", outcome: "no_answer", note: "" }] },
      { id: "l5", name: "Mike Doyle", phone: "021 555 0133", email: "", at: ago(60 * 50), form: "Driveway quote", city: "Albany", status: "booked", booked_for: new Date(Date.now() + 2 * 86400e3).toISOString(), client_calls: true, ours: false,
        answers: [{ q: "Budget", a: "$12k" }], log: [{ at: ago(60 * 49), by: "you", outcome: "booked", note: "Site visit Thursday 10am" }] },
      { id: "l6", name: "Grant Ellis", phone: "027 555 0164", email: "", at: ago(60 * 24 * 6), form: "Patio", city: "Mt Maunganui", status: "not_interested", client_calls: true, ours: false,
        answers: [], log: [{ at: ago(60 * 24 * 5), by: "you", outcome: "not_interested", note: "Went with someone else" }] },
    ],
    ads: [
      { id: "a1", name: "Driveway before/after - video", campaign: "Driveways - Auckland", status: "active", media: "video", spend: 842.5, results: 31, cost_per_result: 27.18, updated_at: ago(300) },
      { id: "a2", name: "Exposed aggregate - static", campaign: "Driveways - Auckland", status: "learning", spend: 410, results: 12, cost_per_result: 34.17, updated_at: ago(300) },
      { id: "a3", name: "Patio offer - static", campaign: "Patios", status: "paused", spend: 220, results: 4, cost_per_result: 55, updated_at: ago(300) },
    ],
  };
  return demo;
}
async function demoRpc(fn, args){
  const d = demoData();
  if (fn === "portal_me") return JSON.parse(JSON.stringify({ ...d.me, client: d.client }));
  if (fn === "portal_leads") return JSON.parse(JSON.stringify(d.leads));
  if (fn === "portal_ads") return JSON.parse(JSON.stringify(d.ads));
  if (fn === "portal_set_notify"){ d.me.notify_new_leads = !!args.p_on; return { ok: true }; }
  if (fn === "portal_log_call"){
    const l = d.leads.find(x => x.id === args.p_lead);
    if (!l) throw new Error("Not allowed");
    if (args.p_outcome === "seen"){ l.seen_at = l.seen_at || new Date().toISOString(); return { ok: true }; }
    if (args.p_outcome === "dialled"){ l.dialled_at = new Date().toISOString(); return { ok: true }; }
    l.log.push({ at: new Date().toISOString(), by: "you", outcome: args.p_outcome, note: args.p_note || "", when: args.p_when });
    if (args.p_outcome === "no_answer"){ if (l.status === "new") l.status = "no_answer"; }
    else l.status = args.p_outcome;
    if (args.p_outcome === "booked") l.booked_for = args.p_when;
    if (args.p_outcome === "call_back") l.call_back_at = args.p_when;
    return { ok: true };
  }
  throw new Error("Unknown");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
