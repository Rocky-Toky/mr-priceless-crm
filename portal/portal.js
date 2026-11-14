/* Mr Priceless - client portal (portal/).
   A separate, small app for clients: their leads (best ones first, every
   form answer on show, one tap to call or text), a pipeline from new lead to
   job won, their ads and their account with us. It never loads the CRM
   (js/app.js) and never touches a table directly: everything comes through
   the portal_* database functions (sql/112, sql/113), which only hand back
   the signed-in client's own rows and only the fields meant for them.
   Phone alerts: sw.js + portal_save_push; the client-portal function sends them.
   With no Supabase config it runs on made-up demo data (for testing). */
(() => {
"use strict";

const CFG = window.CRM_CONFIG || {};
const IS_CONFIGURED = Boolean(CFG.SUPABASE_URL && CFG.SUPABASE_ANON_KEY);
const sb = IS_CONFIGURED && window.supabase?.createClient ? window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY) : null;
const NZ_TZ = "Pacific/Auckland";
const HANDOVER_MS = 24 * 3600e3;
const POLL_MS = 30e3;
// The client's pipeline, in order (client_leads.client_stage, sql/113).
const STAGES = [
  { k: "new", label: "New", hint: "Not called yet", cls: "gold" },
  { k: "no_answer", label: "Didn't answer", hint: "Rang, no answer", cls: "amber" },
  { k: "call_scheduled", label: "Call scheduled", hint: "Ringing them at a set time", cls: "blue", when: "When will you ring them?", whenNeeded: true },
  { k: "site_visit", label: "Site visit booked", hint: "Going out to see the job", cls: "green", when: "When is the visit?" },
  { k: "quote_to_send", label: "Quote to send", hint: "Seen the job, quote to do", cls: "purple" },
  { k: "quote_sent", label: "Quote sent", hint: "Waiting to hear back", cls: "purple", amount: "How much was the quote?" },
  { k: "won", label: "Job won", hint: "They said yes!", cls: "won", amount: "What's the job worth?" },
  { k: "lost", label: "Job lost", hint: "They didn't go ahead", cls: "grey", reasons: ["Went with someone else", "Price too high", "Changed their mind", "Stopped replying", "Other"] },
  { k: "not_qualified", label: "Not qualified", hint: "Not a job for you", cls: "grey", reasons: ["Too small", "Out of our area", "Not our kind of work", "Just looking", "Wrong number", "Other"] },
];
const STAGE = Object.fromEntries(STAGES.map(s => [s.k, s]));
const CLOSED = new Set(["won", "lost", "not_qualified"]);
const EARLY = new Set(["new", "no_answer", "call_scheduled"]);
// How far a lead got, for the "from this month's leads" funnel.
const FUNNEL_RANK = { new: 0, no_answer: 0, call_scheduled: 1, site_visit: 2, quote_to_send: 2, quote_sent: 3, won: 4 };
const CALL_LABELS = { no_answer: "No answer", call_back: "Call back booked", site_visit: "Site visit booked", booked: "Booked in", consult_call: "Consultation call booked",
  not_interested: "Not interested", disqualified: "Not a fit", wrong_number: "Wrong number", qualified: "Interested", unreachable: "Couldn't reach them" };

const S = {
  me: null, client: null, leads: [], ads: [], tab: "leads", view: "call", q: "", period: "month",
  preview: null, openId: null, sheet: null, askFor: null, dialledAt: 0, known: null, loaded: false,
  saving: false, pick: null, drafts: {}, swReg: null, installEvt: null, alerts: "unknown",
};

/* ───────── little helpers ───────── */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const firstName = (n) => String(n || "").trim().split(/\s+/)[0] || "them";
const telHref = (p) => "tel:" + String(p || "").replace(/[^0-9+]/g, "");
const t = (iso) => iso ? new Date(iso).getTime() : 0;
const money = (n) => n == null || n === "" || isNaN(n) ? "-" : "$" + Number(n).toLocaleString("en-NZ", { maximumFractionDigits: Number(n) < 100 ? 2 : 0 });
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
const clock = (iso) => iso ? new Date(iso).toLocaleTimeString("en-NZ", { timeZone: NZ_TZ, hour: "numeric", minute: "2-digit" }) : "";
const day = (iso) => iso ? new Date(iso).toLocaleDateString("en-NZ", { timeZone: NZ_TZ, day: "numeric", month: "long", year: "numeric" }) : "";
const nzDay = (d = new Date()) => new Date(d).toLocaleDateString("en-CA", { timeZone: NZ_TZ });
function whenWords(iso){
  if (!iso) return "";
  const d = nzDay(iso), today = nzDay(), tomorrow = nzDay(Date.now() + 86400e3);
  return d === today ? `today ${clock(iso)}` : d === tomorrow ? `tomorrow ${clock(iso)}` : when(iso);
}
function hoursLeft(ms){
  const h = Math.max(0, ms / 3600e3);
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min` : `${Math.floor(h)} hr${Math.floor(h) === 1 ? "" : "s"}`;
}
const isPhone = () => matchMedia("(pointer: coarse)").matches || /iPhone|iPad|Android/i.test(navigator.userAgent);
const isIOS = () => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const readOnly = () => S.me?.viewer === "team";
function toast(msg){
  const el = $("#pp-toast");
  el.textContent = msg; el.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { el.hidden = true; }, 3600);
}
const store = {
  get(k){ try { return localStorage.getItem(k); } catch(e){ return null; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch(e){} },
};
function localInput(iso){
  const d = new Date(iso), pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
// A question's short label for the lead cards: "What are you looking to invest?" -> "Budget".
function shortQ(q){
  const s = q.replace(/[?:.]$/, "");
  if (/budget|invest|spend|price/i.test(s)) return "Budget";
  if (/when|timeframe|time frame|start|complete|how soon|timing/i.test(s)) return "When";
  if (/size|how big|m2|m²|square|metre|meter|length/i.test(s)) return "Size";
  if (/suburb|where|area|location|address|region/i.test(s)) return "Where";
  if (/own|homeowner/i.test(s)) return "Owns it";
  if (/what.*(need|done|after|looking|job|project|renovat|service|work)|describe|type of|which service/i.test(s)) return "Job";
  const words = s.replace(/^(what|which|how|do|are|is|would) (is |are |you |your )*/i, "").split(" ");
  return words.slice(0, 3).join(" ").replace(/^./, c => c.toUpperCase());
}

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
    } else if (!/not sure|unsure|don.?t know/i.test(budget.a)){ score += 1; why.push(`Budget: ${budget.a}`); }
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

/* ───────── where each lead is ───────── */
const stageOf = (l) => STAGE[l.stage] ? l.stage : "new";
// Still the client's to call? (Our team takes over early-stage leads it's
// rung or been handed; anything booked is the client's whatever happened.)
const withUs = (l) => l.ours && EARLY.has(stageOf(l));
const handoverAt = (l) => l.client_calls && !l.ours && stageOf(l) === "new" && !l.dialled_at ? t(l.at) + HANDOVER_MS : null;
const tries = (l) => (l.log || []).filter(x => x.by === "you" && x.outcome === "no_answer").length;
const nextAt = (l) => l.next_at || null;
function matchQ(l){
  const q = S.q.trim().toLowerCase();
  return !q || [l.name, l.phone, l.email, l.city, l.address, l.form, ...answers(l).map(x => x.a)].join(" ").toLowerCase().includes(q);
}
const byRank = (a, b) => rate(b).score - rate(a).score || t(b.at) - t(a.at);
// The Call now screen: who to ring, then who didn't answer (each with a live
// clock to when Mr Priceless steps in). Everything else lives in the Pipeline.
function callNow(){
  const L = S.leads.filter(matchQ), now = Date.now(), mine = (l) => !withUs(l);
  const st = (k) => L.filter(l => stageOf(l) === k);
  const due = st("call_scheduled").filter(l => mine(l) && nextAt(l) && t(nextAt(l)) <= now + 3600e3).sort((a, b) => t(nextAt(a)) - t(nextAt(b)));
  return [
    { k: "call", title: "Call now", sub: S.client.client_calls ? "Best ones at the top. Ring within 5 minutes and you're far more likely to win the job. Anyone not rung within 24 hours, Mr Priceless calls for you." : "Best ones at the top. Ring within 5 minutes and you're far more likely to win the job.",
      list: [...st("new").filter(l => mine(l) && !l.checkin).sort(byRank), ...due] },
    { k: "noanswer", title: "Didn't answer", sub: "Try them again. When the 24 hours is up we'll ask if they got back to you - if they didn't, Mr Priceless calls them for you.",
      list: st("no_answer").filter(mine).sort((a, b) => (b.checkin ? 1 : 0) - (a.checkin ? 1 : 0) || (timerFor(a)?.until ?? Infinity) - (timerFor(b)?.until ?? Infinity)) },
  ];
}
const callCount = () => callNow().reduce((n, x) => n + x.list.length, 0);
// When does a lead go to Mr Priceless (or get the 24-hour check-in)?
function timerFor(l){
  if (!l.client_calls || withUs(l)) return null;
  if (l.checkin && l.checkin_deadline) return { until: t(l.checkin_deadline), label: "Goes to Mr Priceless in", done: "Passing to Mr Priceless now" };
  if (stageOf(l) === "no_answer" && l.first_na_at) return { until: t(l.first_na_at) + HANDOVER_MS, label: "24 hours up in", done: "24 hours are up" };
  const ho = handoverAt(l);
  if (ho) return { until: ho, label: "Goes to Mr Priceless in", done: "Passing to Mr Priceless now" };
  return null;
}
function timerHtml(l, big){
  const x = timerFor(l);
  if (!x) return "";
  return `<span class="pp-timer${big ? " big" : ""}" data-until="${x.until}" data-label="${esc(x.label)}" data-done="${esc(x.done)}">${esc(timerText(x.until, x.label, x.done))}</span>`;
}
function timerText(until, label, done){
  const ms = until - Date.now();
  if (ms <= 0) return done;
  const h = Math.floor(ms / 3600e3), m = Math.floor(ms % 3600e3 / 60000), sec = Math.floor(ms % 60000 / 1000);
  return `${label} ${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}
// Every second: move the clocks on without redrawing the page.
function tickTimers(){
  $$(".pp-timer").forEach(el => {
    const until = Number(el.dataset.until), left = until - Date.now();
    el.textContent = timerText(until, el.dataset.label, el.dataset.done);
    el.classList.toggle("soon", left < 4 * 3600e3);
    el.classList.toggle("over", left <= 0);
  });
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
  const [leads, ads] = await Promise.all([rpc("portal_leads", { ...clientArg(), p_days: 400 }), rpc("portal_ads", clientArg())]);
  noticeNew(leads || [], first);
  S.leads = leads || []; S.ads = ads || [];
  S.loaded = true;
  render();
}
async function refreshLeads(){
  if (!S.loaded || document.hidden) return;
  try {
    const leads = await rpc("portal_leads", { ...clientArg(), p_days: 400 });
    noticeNew(leads || [], false);
    S.leads = leads || [];
    if (!(S.openId && document.activeElement?.closest?.("#pp-sheet"))) render();
  } catch(e){ console.warn(e); }
}

// A new lead while the portal's open: a chime and a flashing tab. (Phone
// alerts come from the server, even when the app is closed.)
function noticeNew(leads, first){
  const ids = new Set(leads.map(l => l.id));
  if (first || !S.known){ S.known = ids; return; }
  const fresh = leads.filter(l => !S.known.has(l.id) && Date.now() - t(l.at) < 6 * 3600e3);
  S.known = ids;
  if (!fresh.length || readOnly()) return;
  chime();
  flashTitle(`New lead: ${fresh[0].name || "someone"}`);
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
  const base = "Mr Priceless - My Leads";
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
  const n = S.leads.filter(l => l.checkin || (stageOf(l) === "new" && !withUs(l))).length;
  const c = $("#pp-count"); c.hidden = !n; c.textContent = n;
  $$("#pp-tabs [data-tab]").forEach(x => x.classList.toggle("active", x.dataset.tab === S.tab));
  $$("[data-pane]").forEach(p => { p.hidden = p.dataset.pane !== S.tab; });
  $(".pp-main")?.classList.toggle("wide", S.tab === "leads" && S.view === "board");
  renderPreview();
  if (S.tab === "leads") renderLeads();
  if (S.tab === "ads") renderAds();
  if (S.tab === "account") renderAccount();
  if (S.sheet) renderSheet();
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

function stageChip(l){
  const s = STAGE[stageOf(l)], na = nextAt(l);
  let text = s.label;
  if (stageOf(l) === "call_scheduled" && na) text = `Call ${whenWords(na)}`;
  else if (stageOf(l) === "site_visit" && na) text = `Visit ${whenWords(na)}`;
  else if (stageOf(l) === "quote_sent" && l.quote_amount) text = `Quote sent · ${money(l.quote_amount)}`;
  else if (stageOf(l) === "won" && l.job_value) text = `Won · ${money(l.job_value)}`;
  else if (stageOf(l) === "no_answer" && tries(l) > 1) text = `Didn't answer · ${tries(l)} tries`;
  return `<span class="pp-st pp-st-${s.cls}">${esc(text)}</span>`;
}
function leadCardHtml(l, section){
  const r = rate(l), qa = answers(l), st = stageOf(l), early = EARLY.has(st);
  const where = l.city || l.address || "";
  const quick = section === "visited" ? ["quote_to_send", "Quote to send →"] : section === "quote" ? ["quote_sent", "Quote sent →"] : section === "chase" ? ["won", "Won it →"] : null;
  return `<li class="pp-lead${l.checkin ? " checkin" : ""}${CLOSED.has(st) ? " done" : ""}${!l.seen_at && st === "new" ? " unseen" : ""}">
    ${l.checkin ? `<div class="pp-ask">
      <b>Did ${esc(firstName(l.name))} get back to you?</b>
      <span>${l.checkin_deadline ? `If we don't hear by ${esc(whenWords(l.checkin_deadline))}, our team will call them.` : ""}</span>
      <div><button type="button" class="pp-btn pp-btn-dark" data-ask-yes="${esc(l.id)}">Yes - update it</button><button type="button" class="pp-btn pp-btn-light" data-ask-no="${esc(l.id)}">No - pass to Mr Priceless</button></div>
    </div>` : ""}
    <div class="pp-lead-row">
      <button type="button" class="pp-lead-main" data-open="${esc(l.id)}">
        <span class="pp-lead-top">
          ${early && !withUs(l) ? `<span class="pp-tier pp-${r.tier}">${r.label}</span>` : ""}
          <b class="pp-lead-name">${esc(l.name || "No name")}</b>
          <span class="pp-lead-when">${esc(ago(l.at))}</span>
        </span>
        <span class="pp-lead-sub">${esc([l.form, where].filter(Boolean).join(" · "))}</span>
        ${qa.length ? `<span class="pp-card-qa">${qa.slice(0, 4).map(x => `<span${x.a.length > 26 ? ` class="wide"` : ""}><i>${esc(shortQ(x.q))}</i><b>${esc(x.a)}</b></span>`).join("")}</span>` : `<span class="pp-noqa">No form answers came through</span>`}
        <span class="pp-lead-tags">${section === "pipeline" || !early ? stageChip(l) : st !== "new" ? stageChip(l) : ""}
          ${early && !withUs(l) && r.why.length ? r.why.slice(0, 2).map(w => `<span class="pp-why">${esc(w)}</span>`).join("") : ""}
          ${withUs(l) ? `<span class="pp-ours">Mr Priceless is calling them</span>` : ""}
          ${timerHtml(l)}
        </span>
      </button>
      ${l.phone ? `<a class="pp-call-round" href="${esc(telHref(l.phone))}" data-dial="${esc(l.id)}" aria-label="Call ${esc(l.name || "them")}">☎</a>` : ""}
    </div>
    ${quick && !readOnly() ? `<button type="button" class="pp-quick" data-quick="${quick[0]}" data-id="${esc(l.id)}">${esc(quick[1])}</button>` : ""}
  </li>`;
}

function inPeriod(iso){
  const ms = t(iso), now = new Date();
  if (S.period === "all") return true;
  if (S.period === "90") return Date.now() - ms < 90 * 86400e3;
  const nz = nzDay(ms).slice(0, 7), thisM = nzDay(now).slice(0, 7);
  if (S.period === "month") return nz === thisM;
  const d = new Date(now.toLocaleString("en-US", { timeZone: NZ_TZ })); d.setDate(1); d.setMonth(d.getMonth() - 1);
  return nz === `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
function reachedRank(l){
  let r = FUNNEL_RANK[stageOf(l)] ?? -1;
  for (const n of l.notes || []){ if (n.stage && FUNNEL_RANK[n.stage] != null) r = Math.max(r, FUNNEL_RANK[n.stage]); if (n.from && FUNNEL_RANK[n.from] != null) r = Math.max(r, FUNNEL_RANK[n.from]); }
  return r;
}
function summaryHtml(){
  const L = S.leads.filter(l => inPeriod(l.at));
  const spoke = L.filter(l => reachedRank(l) >= 1).length, visits = L.filter(l => reachedRank(l) >= 2).length;
  const quotes = L.filter(l => reachedRank(l) >= 3), won = L.filter(l => stageOf(l) === "won");
  const qv = quotes.reduce((s, l) => s + (Number(l.quote_amount) || 0), 0), wv = won.reduce((s, l) => s + (Number(l.job_value) || 0), 0);
  // How fast they ring new leads: their first tap of Call (or first call saved).
  const speeds = L.filter(l => l.client_calls).map(l => {
    const first = [l.dialled_at, ...(l.log || []).filter(x => x.by === "you").map(x => x.at)].filter(Boolean).map(t).sort((a, b) => a - b)[0];
    return first ? first - t(l.at) : null;
  }).filter(x => x != null && x >= 0).sort((a, b) => a - b);
  const med = speeds.length ? speeds[Math.floor(speeds.length / 2)] : null;
  const speedTxt = med == null ? "-" : med < 3600e3 ? `${Math.max(1, Math.round(med / 60000))} min` : `${Math.round(med / 3600e3)} hrs`;
  const periods = [["month", "This month"], ["last", "Last month"], ["90", "Last 90 days"], ["all", "All time"]];
  return `<section class="pp-sum">
    <div class="pp-sum-head"><h2>How your leads are going</h2>
      <select id="pp-period" aria-label="Period">${periods.map(([k, l]) => `<option value="${k}"${S.period === k ? " selected" : ""}>${l}</option>`).join("")}</select></div>
    <div class="pp-funnel">
      <div><b>${L.length}</b><span>Leads</span></div>
      <div><b>${spoke}</b><span>Spoke to</span></div>
      <div><b>${visits}</b><span>Site visits</span></div>
      <div><b>${quotes.length}</b><span>Quotes${qv ? ` · ${money(qv)}` : ""}</span></div>
      <div class="won"><b>${won.length}</b><span>Won${wv ? ` · ${money(wv)}` : ""}</span></div>
    </div>
    ${S.client.client_calls && speeds.length ? `<p class="pp-speed${med != null && med <= 15 * 60e3 ? " good" : ""}">You usually ring new leads within <b>${esc(speedTxt)}</b>${med != null && med <= 5 * 60e3 ? " - brilliant." : med != null && med <= 3600e3 ? ". Under 5 minutes wins the most jobs." : ". The sooner the better - under 5 minutes wins the most jobs."}</p>` : ""}
  </section>`;
}

function alertsBannerHtml(){
  if (readOnly() || S.alerts === "on" || S.alerts === "unsupported" || store.get("mpp_alerts_later") === nzDay()) return "";
  return `<div class="pp-alertbar">
    <span>🔔</span><div><b>Get new leads on your phone</b><small>A notification the second one comes in, even when this app is closed.</small></div>
    <button type="button" class="pp-btn pp-btn-gold" data-act="alerts-setup">Set it up</button>
    <button type="button" class="pp-x" data-act="alerts-later" aria-label="Not now">×</button>
  </div>`;
}

function renderLeads(){
  const el = $("#pp-leads");
  if (S.view !== "board") S.view = "call";
  const secs = callNow(), n = secs[0].list.length, na = secs[1].list.length;
  const views = [["call", "Call now", n + na], ["board", "Pipeline", null]];
  let body;
  if (S.view === "board") body = boardHtml();
  else {
    body = secs.map(x => `<section class="pp-sec pp-sec-${x.k}">
        <h3>${esc(x.title)} <b>${x.list.length}</b></h3>${x.sub ? `<p>${esc(x.sub)}</p>` : ""}
        ${x.list.length ? `<ul class="pp-list">${x.list.map(l => leadCardHtml(l, x.k)).join("")}</ul>`
          : `<div class="pp-empty">${x.k === "call" ? (S.leads.length ? "Nobody to call right now. New leads show up here the moment they come in." : "No leads yet. They'll show up here the moment they come in.") : "Nobody waiting on a call back."}</div>`}
      </section>`).join("") + summaryHtml();
  }
  const checkins = S.leads.filter(l => l.checkin).length;
  el.innerHTML = `
    ${alertsBannerHtml()}
    <div class="pp-hero"><div>
      <h1>${S.view === "board" ? "Your pipeline" : checkins ? `${checkins} lead${checkins === 1 ? "" : "s"} need${checkins === 1 ? "s" : ""} an answer` : n ? `${n} lead${n === 1 ? "" : "s"} to call` : "Your leads"}</h1>
      <p>${S.view === "board" ? "Every lead, from new to job won." : S.client.client_calls ? "You call your leads. Can't reach one? Tap Didn't answer - we'll check with you after 24 hours, and Mr Priceless can follow them up." : "Our team calls your new leads and books them in. Take them from there in your Pipeline: site visit, quote, job won."}</p>
    </div></div>
    <nav class="pp-pipe pp-views" aria-label="Leads">${views.map(([k, label, c]) => `<button type="button" data-view="${k}" class="${S.view === k ? "active" : ""}"><span>${esc(label)}</span>${c ? `<b>${c}</b>` : ""}</button>`).join("")}</nav>
    <input type="search" id="pp-search" placeholder="Search name, phone, suburb, answers" value="${esc(S.q)}" aria-label="Search leads">
    ${body}`;
}

/* ───────── the board: drag leads between stages ───────── */
// Won / lost / not qualified only show the last 60 days, so the board stays short.
const BOARD_CLOSED_MS = 60 * 86400e3;
// Dropping on these asks a quick question first (time, amount or reason);
// the rest move straight away.
const ASK_ON_DROP = new Set(["call_scheduled", "site_visit", "quote_sent", "won", "lost", "not_qualified"]);
function boardHtml(){
  const L = S.leads.filter(matchQ);
  const cols = STAGES.map(s => {
    let list = L.filter(l => stageOf(l) === s.k);
    if (CLOSED.has(s.k)) list = list.filter(l => Date.now() - t(l.stage_at || l.at) < BOARD_CLOSED_MS);
    list.sort(EARLY.has(s.k) ? byRank : s.k === "call_scheduled" || s.k === "site_visit" ? (a, b) => t(nextAt(a)) - t(nextAt(b)) : (a, b) => t(b.stage_at || b.at) - t(a.stage_at || a.at));
    const total = s.k === "quote_sent" ? list.reduce((n, l) => n + (Number(l.quote_amount) || 0), 0) : s.k === "won" ? list.reduce((n, l) => n + (Number(l.job_value) || 0), 0) : 0;
    return `<section class="pp-col pp-col-${s.cls}" data-col="${s.k}">
      <header><b>${esc(s.label)}</b><span>${list.length}${total ? ` · ${money(total)}` : ""}</span></header>
      <ul>${list.map(boardCardHtml).join("")}</ul>
      ${list.length ? "" : `<p class="pp-col-empty">Drag a lead here</p>`}
      ${CLOSED.has(s.k) ? `<p class="pp-col-note">Last 60 days</p>` : ""}
    </section>`;
  }).join("");
  return `<p class="pp-board-tip">${readOnly() ? "Clients drag leads between stages here." : isPhone() ? "Press and hold a lead, then drag it to another stage. Tap to open it." : "Drag a lead to another stage. Click to open it."}</p>
    <div class="pp-board" id="pp-board">${cols}</div>`;
}
function boardCardHtml(l){
  const r = rate(l), st = stageOf(l), qa = answers(l).slice(0, 2), na = nextAt(l);
  const extra = (st === "call_scheduled" || st === "site_visit") && na ? whenWords(na)
    : st === "quote_sent" && l.quote_amount ? money(l.quote_amount) : st === "won" && l.job_value ? money(l.job_value)
    : st === "no_answer" && tries(l) ? `${tries(l)} ${tries(l) === 1 ? "try" : "tries"}` : CLOSED.has(st) && l.lost_reason ? l.lost_reason : "";
  return `<li class="pp-bcard${l.checkin ? " checkin" : ""}" data-card="${esc(l.id)}">
    <div class="pp-bcard-top">${EARLY.has(st) && !withUs(l) ? `<span class="pp-tier pp-${r.tier}">${r.label}</span>` : ""}<b>${esc(l.name || "No name")}</b><small>${esc(ago(l.at))}</small></div>
    ${qa.length ? `<div class="pp-bcard-qa">${qa.map(x => `<span><i>${esc(shortQ(x.q))}</i> ${esc(x.a)}</span>`).join("")}</div>` : ""}
    <div class="pp-bcard-foot">
      ${l.checkin ? `<span class="pp-bflag">Did they get back to you?</span>` : withUs(l) ? `<span class="pp-bflag us">Mr Priceless calling</span>` : extra ? `<span class="pp-bextra">${esc(extra)}</span>` : "<span></span>"}
      ${l.phone ? `<a class="pp-bcall" href="${esc(telHref(l.phone))}" data-dial="${esc(l.id)}" aria-label="Call ${esc(l.name || "them")}">☎</a>` : ""}
    </div>
  </li>`;
}
async function moveLead(id, k){
  const l = S.leads.find(x => x.id === id);
  if (!l || stageOf(l) === k) return;
  if (readOnly()){ toast("Preview only - the client moves leads from their login."); return; }
  // Stages that need a time, amount or reason: open the lead with that stage picked.
  if (ASK_ON_DROP.has(k)){ openLead(id, { pick: k }); return; }
  const was = l.stage;
  l.stage = k; l.stage_at = new Date().toISOString();
  render();
  try {
    await rpc("portal_update_lead", { p_lead: id, p_stage: k, p_note: null, p_when: null, p_amount: null, p_reason: null });
    toast(`Moved ${firstName(l.name)} to ${STAGE[k].label}.`);
    await refreshAfterSave(); render();
  } catch(e){
    l.stage = was; render();
    toast("Couldn't move that - check your internet and try again.");
  }
}
// One drag for mouse and touch (pointer events). On touch it starts after a
// short press-and-hold, so a normal swipe still scrolls the page and board.
const DRAG = { el: null, id: null, ghost: null, x: 0, y: 0, sx: 0, sy: 0, dx: 0, dy: 0, timer: null, on: false, over: null, type: "", ended: 0, raf: 0 };
function dragReset(){
  clearTimeout(DRAG.timer); cancelAnimationFrame(DRAG.raf);
  if (DRAG.ghost) DRAG.ghost.parentNode?.removeChild(DRAG.ghost);
  DRAG.el?.classList.toggle("dragging", false);
  DRAG.el?.classList.toggle("pressing", false);
  $$(".pp-col.over").forEach(c => c.classList.toggle("over", false));
  document.body.classList.toggle("pp-dragging", false);
  Object.assign(DRAG, { el: null, id: null, ghost: null, timer: null, on: false, over: null });
}
function dragStart(){
  const r = DRAG.el.getBoundingClientRect();
  DRAG.on = true;
  DRAG.dx = DRAG.x - r.left; DRAG.dy = DRAG.y - r.top;
  const g = DRAG.el.cloneNode(true);
  g.classList.add("pp-ghost"); g.style.width = r.width + "px";
  document.body.appendChild(g);
  DRAG.ghost = g;
  DRAG.el.classList.toggle("pressing", false); DRAG.el.classList.add("dragging");
  document.body.classList.add("pp-dragging");
  if (DRAG.type === "touch") try { navigator.vibrate?.(15); } catch(e){}
  dragMove();
}
function dragMove(){
  if (!DRAG.on) return;
  DRAG.ghost.style.transform = `translate(${DRAG.x - DRAG.dx}px, ${DRAG.y - DRAG.dy}px) rotate(2deg)`;
  const col = document.elementFromPoint(DRAG.x, DRAG.y)?.closest?.(".pp-col") || null;
  if (col !== DRAG.over){ DRAG.over?.classList.toggle("over", false); col?.classList.add("over"); DRAG.over = col; }
  // Near an edge: scroll the board sideways (and the page up or down).
  cancelAnimationFrame(DRAG.raf);
  const board = $("#pp-board"), edge = 48;
  let sx = 0, sy = 0;
  if (board){ const b = board.getBoundingClientRect(); if (DRAG.x < b.left + edge) sx = -14; else if (DRAG.x > b.right - edge) sx = 14; }
  if (DRAG.y < 90) sy = -12; else if (DRAG.y > innerHeight - 90) sy = 12;
  if (sx || sy) DRAG.raf = requestAnimationFrame(() => { if (sx && board) board.scrollLeft += sx; if (sy) scrollBy(0, sy); dragMove(); });
}
function bindBoardDrag(){
  document.addEventListener("pointerdown", (e) => {
    const card = e.target.closest?.(".pp-bcard");
    if (!card || e.target.closest("a, button") || (e.pointerType === "mouse" && e.button !== 0)) return;
    dragReset();
    Object.assign(DRAG, { el: card, id: card.dataset.card, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, type: e.pointerType });
    if (e.pointerType !== "mouse"){
      card.classList.add("pressing");
      DRAG.timer = setTimeout(() => { if (DRAG.el === card) dragStart(); }, 320);
    }
  });
  document.addEventListener("pointermove", (e) => {
    if (!DRAG.el) return;
    DRAG.x = e.clientX; DRAG.y = e.clientY;
    const moved = Math.hypot(e.clientX - DRAG.sx, e.clientY - DRAG.sy);
    if (!DRAG.on){
      if (DRAG.type === "mouse"){ if (moved > 6) dragStart(); }
      else if (moved > 10) dragReset(); // moved before the hold: it's a scroll
      return;
    }
    e.preventDefault();
    dragMove();
  });
  // While dragging on a phone, stop the page from scrolling under the finger.
  document.addEventListener("touchmove", (e) => { if (DRAG.on) e.preventDefault(); }, { passive: false });
  document.addEventListener("contextmenu", (e) => { if (e.target.closest?.(".pp-bcard")) e.preventDefault(); });
  const end = (e) => {
    if (!DRAG.el) return;
    const wasOn = DRAG.on, id = DRAG.id, to = DRAG.over?.dataset.col;
    dragReset();
    if (wasOn){ DRAG.ended = Date.now(); if (e.type === "pointerup" && to) moveLead(id, to); }
  };
  document.addEventListener("pointerup", end);
  document.addEventListener("pointercancel", end);
}

/* ───────── one lead ───────── */
function openLead(id, opts = {}){
  const l = S.leads.find(x => x.id === id);
  if (!l) return;
  // The phone's back button closes the lead instead of leaving the portal.
  if (!S.sheet) try { history.pushState({ sheet: 1 }, ""); } catch(e){}
  S.openId = id; S.sheet = "lead"; S.pick = opts.pick || null; S.askFor = opts.ask ? id : null;
  $("#pp-sheet-wrap").hidden = false;
  document.body.classList.add("pp-locked");
  renderSheet();
  $("#pp-sheet").scrollTop = 0;
  if (opts.ask || opts.pick) setTimeout(() => $("#pp-move")?.scrollIntoView({ block: "start", behavior: "smooth" }), 60);
  if (!readOnly() && !l.seen_at){ l.seen_at = new Date().toISOString(); rpc("portal_log_call", { p_lead: id, p_outcome: "seen" }).catch(() => {}); }
}
function openSheet(kind){
  if (!S.sheet) try { history.pushState({ sheet: 1 }, ""); } catch(e){}
  S.sheet = kind; S.openId = null;
  $("#pp-sheet-wrap").hidden = false;
  document.body.classList.add("pp-locked");
  renderSheet();
  $("#pp-sheet").scrollTop = 0;
}
function closeSheet(){
  if (history.state?.sheet){ history.back(); return; }
  shutSheet();
}
function shutSheet(){
  S.openId = null; S.sheet = null; S.askFor = null; S.pick = null;
  $("#pp-sheet-wrap").hidden = true;
  document.body.classList.remove("pp-locked");
  render();
}
function renderSheet(){
  if (S.sheet === "alerts") return renderAlertsSheet();
  const l = S.leads.find(x => x.id === S.openId);
  if (!l){ shutSheet(); return; }
  const r = rate(l), qa = answers(l), st = stageOf(l), first = firstName(l.name);
  const na = nextAt(l);
  $("#pp-sheet").innerHTML = `
    <div class="pp-sheet-head">
      <button type="button" class="pp-back" data-act="close" aria-label="Back to leads">‹ Leads</button>
      ${stageChip(l)}
    </div>
    <h2 class="pp-sheet-name">${esc(l.name || "No name")}</h2>
    <p class="pp-sheet-sub">${EARLY.has(st) && !withUs(l) ? `<span class="pp-tier pp-${r.tier}">${r.label} lead</span> ` : ""}Came in ${esc(ago(l.at))} · ${esc(when(l.at))}${l.form ? ` · ${esc(l.form)}` : ""}</p>
    ${l.checkin ? `<div class="pp-ask big">
      <b>Did ${esc(first)} get back to you?</b>
      <span>You couldn't reach them${l.first_na_at ? ` on ${esc(when(l.first_na_at))}` : ""}. ${l.checkin_deadline ? `If we don't hear by ${esc(whenWords(l.checkin_deadline))}, our team will call them.` : ""}</span>
      <div><button type="button" class="pp-btn pp-btn-dark" data-act="ask-yes">Yes - pick where they're at</button><button type="button" class="pp-btn pp-btn-light" data-ask-no="${esc(l.id)}">No - pass to Mr Priceless</button></div>
    </div>` : ""}
    ${timerFor(l) ? `<p class="pp-note-line">${timerHtml(l, true)}</p>` : ""}
    ${withUs(l) ? `<p class="pp-note-line us">The Mr Priceless team is calling ${esc(first)}${l.handover_reason === "client_no" ? " - you passed them to us" : ""}. If they get in touch with you, just update them here.</p>` : ""}

    ${l.phone ? `<div class="pp-actions">
      <a class="pp-btn pp-btn-call" href="${esc(telHref(l.phone))}" data-dial="${esc(l.id)}">☎ Call ${esc(first)}</a>
      <a class="pp-btn pp-btn-light" href="${esc(smsHref(l))}" data-text="${esc(l.id)}">✉ Text</a>
      ${l.email ? `<a class="pp-btn pp-btn-light" href="mailto:${esc(l.email)}">@ Email</a>` : ""}
    </div>
    <p class="pp-number">${esc(l.phone)} <button type="button" class="pp-link" data-copy="${esc(l.phone)}">Copy</button>${isPhone() ? "" : `<span class="pp-hint"> · On a computer? Dial it on your phone, then come back and say how it went.</span>`}</p>`
    : `<p class="pp-warn">No phone number came through${l.email ? ` - email ${esc(first)} at <a href="mailto:${esc(l.email)}">${esc(l.email)}</a>` : ""}.</p>`}

    <section class="pp-block pp-told">
      <h3>What ${esc(first)} told us</h3>
      ${qa.length ? `<dl class="pp-qa">${qa.map(x => `<div><dt>${esc(x.q)}</dt><dd>${esc(x.a)}</dd></div>`).join("")}</dl>` : `<p class="pp-muted">No form answers came through with this lead.</p>`}
      ${l.scope ? `<dl class="pp-qa"><div><dt>The job</dt><dd>${esc(l.scope)}</dd></div></dl>` : ""}
      ${EARLY.has(st) && (r.why.length || r.warn.length) ? `<div class="pp-reasons">${r.why.map(w => `<span class="pp-why">✓ ${esc(w)}</span>`).join("")}${r.warn.map(w => `<span class="pp-warnchip">! ${esc(w)}</span>`).join("")}</div>` : ""}
    </section>

    ${moveHtml(l)}

    <section class="pp-block pp-grid2">
      ${l.address || l.city ? `<div><h3>Where</h3><p>${esc(l.address || l.city)}</p><a class="pp-link" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(l.address || l.city)}">Open in Maps</a></div>` : ""}
      ${(st === "site_visit" || st === "call_scheduled") && na ? `<div><h3>${st === "site_visit" ? "Site visit" : "Call them"}</h3><p>${esc(when(na))}</p><a class="pp-link" target="_blank" rel="noopener" href="${esc(gcalHref(l, st, na))}">Add to my calendar</a></div>` : ""}
      ${l.quote_amount ? `<div><h3>Quote</h3><p>${esc(money(l.quote_amount))}${l.quote_sent_at ? ` · sent ${esc(day(l.quote_sent_at))}` : ""}</p></div>` : ""}
      ${l.job_value ? `<div><h3>Job value</h3><p>${esc(money(l.job_value))}</p></div>` : ""}
      ${l.lost_reason && CLOSED.has(st) ? `<div><h3>Why</h3><p>${esc(l.lost_reason)}</p></div>` : ""}
      ${l.email ? `<div><h3>Email</h3><p><a href="mailto:${esc(l.email)}">${esc(l.email)}</a></p></div>` : ""}
      ${l.ad || l.campaign ? `<div><h3>The ad they saw</h3><p>${esc(l.ad || l.campaign)}</p></div>` : ""}
    </section>

    <section class="pp-block">
      <h3>Notes and calls</h3>
      ${readOnly() ? "" : `<div class="pp-addnote"><textarea id="pp-newnote" rows="2" placeholder="Add a note - e.g. wants it done before Christmas">${esc(S.drafts["note:" + l.id] || "")}</textarea><button type="button" class="pp-btn pp-btn-light" data-act="save-note">Save note</button></div>`}
      ${historyHtml(l)}
    </section>`;
}
function moveHtml(l){
  const st = stageOf(l), first = firstName(l.name), o = S.pick ? STAGE[S.pick] : null;
  const asking = S.askFor === l.id;
  const def = o?.when ? localInput(nextAt(l) && o.k === st ? nextAt(l) : (() => { const d = new Date(Date.now() + (o.k === "call_scheduled" ? 3 : 24) * 3600e3); d.setMinutes(0, 0, 0); return d.toISOString(); })()) : "";
  return `<section class="pp-block pp-move${asking ? " asking" : ""}" id="pp-move">
    <h3>${asking ? `How did it go with ${esc(first)}?` : `Where's ${esc(first)} at?`}</h3>
    <p class="pp-muted pp-small">${asking ? "Tap what happened." : "Tap to move them along. You can change it any time."}</p>
    <div class="pp-stages">${STAGES.map(s => `<button type="button" class="pp-stage pp-stage-${s.cls}${s.k === st ? " now" : ""}${S.pick === s.k ? " picked" : ""}" data-pick="${s.k}"><b>${esc(s.label)}</b><small>${s.k === st ? "Now" : esc(s.hint)}</small></button>`).join("")}</div>
    ${o ? `<div class="pp-out-form">
      ${o.when ? `<label>${esc(o.when)}${o.whenNeeded ? "" : " <small>(optional)</small>"}<input type="datetime-local" id="pp-when" value="${esc(def)}"></label>` : ""}
      ${o.amount ? `<label>${esc(o.amount)} <small>(optional)</small><span class="pp-money"><i>$</i><input type="number" inputmode="decimal" min="0" step="1" id="pp-amount" value="${esc(o.k === "won" ? (l.job_value || l.quote_amount || "") : (l.quote_amount || ""))}" placeholder="0"></span></label>` : ""}
      ${o.reasons ? `<label>Why? <small>(optional)</small><select id="pp-reason"><option value="">Pick one</option>${o.reasons.map(x => `<option${l.lost_reason === x ? " selected" : ""}>${esc(x)}</option>`).join("")}</select></label>` : ""}
      <label>Note <small>(optional)</small><textarea id="pp-note" rows="2" placeholder="${o.k === "no_answer" ? "e.g. Left a voicemail" : "Anything worth remembering"}">${esc(S.drafts[l.id] || "")}</textarea></label>
      <button type="button" class="pp-btn pp-btn-gold pp-btn-big" data-act="save-stage"${S.saving ? " disabled" : ""}>Save: ${esc(o.label)}</button>
    </div>` : ""}
  </section>`;
}
function historyHtml(l){
  const items = [
    ...(l.notes || []).map(n => ({ at: n.at, who: "You", what: n.stage ? `${STAGE[n.stage]?.label || n.stage}${n.amount != null ? ` · ${money(n.amount)}` : ""}${n.when ? ` · ${when(n.when)}` : ""}` : "Note", note: [n.reason, n.note].filter(Boolean).join(" - ") })),
    ...(l.log || []).filter(x => x.by !== "you").map(x => ({ at: x.at, who: "Mr Priceless", what: CALL_LABELS[x.outcome] || x.outcome, note: x.note })),
  ].filter(x => x.at).sort((a, b) => t(b.at) - t(a.at));
  if (!items.length) return `<p class="pp-muted">Nothing yet.</p>`;
  return `<ol class="pp-log">${items.map(x => `<li class="${x.who === "You" ? "" : "us"}"><b>${esc(x.what)}</b><span>${esc(when(x.at))} · ${esc(x.who)}</span>${x.note ? `<p>${esc(x.note)}</p>` : ""}</li>`).join("")}</ol>`;
}
function smsHref(l){
  const me = (S.me?.name || "").trim().split(/\s+/)[0];
  const biz = String(S.client?.name || "").replace(/\s+[-–|(].*$/, "").replace(/[,.]?\s+(ltd|limited)\.?$/i, "").trim();
  const msg = `Hi ${firstName(l.name)}, ${me ? `it's ${me} from ${biz}` : `${biz} here`}. Thanks for your enquiry${l.form ? ` about ${l.form.toLowerCase()}` : ""}! When's a good time for a quick call?`;
  return `sms:${String(l.phone || "").replace(/[^0-9+]/g, "")}${isIOS() ? "&" : "?"}body=${encodeURIComponent(msg)}`;
}
function gcalHref(l, st, at){
  const fmt = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const start = t(at), end = start + (st === "site_visit" ? 60 : 15) * 60e3;
  const what = st === "site_visit" ? `Site visit - ${l.name || "lead"}` : `Call ${l.name || "lead"}`;
  const details = [l.phone ? `Phone: ${l.phone}` : "", ...answers(l).map(x => `${x.q} ${x.a}`)].filter(Boolean).join("\n");
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(what)}&dates=${fmt(start)}/${fmt(end)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent(l.address || l.city || "")}`;
}

async function saveStage(){
  const l = S.leads.find(x => x.id === S.openId), o = S.pick ? STAGE[S.pick] : null;
  if (!l || !o) return;
  if (readOnly()){ toast("Preview only - the client saves this from their login."); return; }
  const whenVal = $("#pp-when")?.value, amt = $("#pp-amount")?.value, reason = $("#pp-reason")?.value || null;
  const note = ($("#pp-note")?.value || "").trim();
  if (o.whenNeeded && !whenVal){ toast("Pick when you'll ring them."); return; }
  const at = whenVal ? new Date(whenVal).toISOString() : null;
  const amount = amt !== undefined && amt !== "" && !isNaN(Number(amt)) ? Number(amt) : null;
  S.saving = true; renderSheet();
  try {
    await rpc("portal_update_lead", { p_lead: l.id, p_stage: o.k, p_note: note || null, p_when: at, p_amount: amount, p_reason: reason });
    const wasAsked = l.checkin;
    delete S.drafts[l.id];
    S.saving = false;
    await refreshAfterSave();
    toast(o.k === "no_answer" ? (wasAsked ? `Thanks - our team will follow ${firstName(l.name)} up for you.` : `Saved. Try ${firstName(l.name)} again later - we'll check in with you tomorrow if you can't reach them.`)
      : o.k === "won" ? "Nice one! Job won." : `Saved: ${o.label}.`);
    closeSheet();
  } catch(e){
    S.saving = false; renderSheet();
    toast(e?.message && !/fetch|network/i.test(e.message) ? e.message : "Couldn't save that - check your internet and try again.");
    console.warn(e);
  }
}
async function saveNote(){
  const l = S.leads.find(x => x.id === S.openId), el = $("#pp-newnote");
  const note = (el?.value || "").trim();
  if (!l || !note) return toast("Type a note first.");
  if (readOnly()) return toast("Preview only - the client saves this from their login.");
  try {
    await rpc("portal_update_lead", { p_lead: l.id, p_stage: null, p_note: note, p_when: null, p_amount: null, p_reason: null });
    delete S.drafts["note:" + l.id];
    await refreshAfterSave();
    toast("Note saved.");
    renderSheet();
  } catch(e){ toast("Couldn't save that - try again."); }
}
async function passToUs(id){
  const l = S.leads.find(x => x.id === id);
  if (!l) return;
  if (readOnly()) return toast("Preview only - the client answers this from their login.");
  try {
    await rpc("portal_checkin", { p_lead: id, p_answer: "no" });
    await refreshAfterSave();
    toast(`Done - our team will follow ${firstName(l.name)} up for you.`);
    if (S.sheet) closeSheet(); else render();
  } catch(e){ toast("Couldn't save that - try again."); }
}
async function refreshAfterSave(){
  try { S.leads = await rpc("portal_leads", { ...clientArg(), p_days: 400 }) || S.leads; } catch(e){}
}

/* ───────── phone alerts ───────── */
function b64uToBytes(s){
  const p = s.replace(/-/g, "+").replace(/_/g, "/"), bin = atob(p + "===".slice((p.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function checkAlerts(){
  if (readOnly()){ S.alerts = "team"; return; }
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)){
    S.alerts = isIOS() && !installed() ? "install" : "unsupported"; return;
  }
  if (isIOS() && !installed()){ S.alerts = "install"; return; }
  if (Notification.permission === "denied"){ S.alerts = "denied"; return; }
  try {
    S.swReg = S.swReg || await navigator.serviceWorker.register("sw.js", { scope: "./" });
    const sub = await S.swReg.pushManager.getSubscription();
    S.alerts = sub && Notification.permission === "granted" ? "on" : "off";
    // Keep the server's copy fresh (it can change, e.g. after a browser update).
    if (sub && S.alerts === "on" && sb) rpc("portal_save_push", { p_sub: { ...sub.toJSON(), ua: navigator.userAgent } }).catch(() => {});
  } catch(e){ console.warn(e); S.alerts = "off"; }
}
async function turnOnAlerts(){
  if (readOnly()) return toast("Preview only.");
  if (!S.me.push_key && sb) return toast("Phone alerts are still being set up on our side - try again in a few minutes.");
  try {
    const p = await Notification.requestPermission();
    if (p !== "granted"){ S.alerts = p === "denied" ? "denied" : "off"; renderSheet(); render(); return toast("Alerts are off. You can switch them on in your phone's settings."); }
    S.swReg = S.swReg || await navigator.serviceWorker.register("sw.js", { scope: "./" });
    await navigator.serviceWorker.ready;
    let sub = await S.swReg.pushManager.getSubscription();
    if (!sub && sb) sub = await S.swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uToBytes(S.me.push_key) });
    if (sub && sb) await rpc("portal_save_push", { p_sub: { ...sub.toJSON(), ua: navigator.userAgent } });
    S.alerts = "on";
    toast("Alerts are on. You'll get a notification the moment a new lead comes in.");
    if (S.sheet === "alerts") closeSheet(); else render();
  } catch(e){
    console.warn(e);
    toast("Couldn't turn alerts on here. Make sure you opened the app from your home screen, then try again.");
  }
}
function renderAlertsSheet(){
  const ios = isIOS(), android = /Android/i.test(navigator.userAgent);
  const st = S.alerts;
  let steps = "";
  if (st === "install" || (ios && !installed())){
    steps = `<ol class="pp-install">
      <li><b>Tap the Share button</b><span>The square with an arrow, at the bottom of Safari (or top right on an iPad).</span></li>
      <li><b>Tap "Add to Home Screen"</b><span>Scroll down the list if you can't see it. Then tap Add.</span></li>
      <li><b>Open "My Leads" from your home screen</b><span>It's the gold P icon. Sign in, then tap Turn on alerts.</span></li>
    </ol><p class="pp-muted pp-small">iPhones only send website alerts to apps added to the home screen. It's a one-off.</p>`;
  } else if (st === "denied"){
    steps = `<p>Alerts are blocked for this app. ${ios ? "Open Settings → Notifications → My Leads and switch on Allow Notifications." : android ? "Tap the lock next to the address (or hold the app icon → App info) → Notifications → Allow." : "Click the lock next to the address bar → Notifications → Allow."} Then come back and tap Turn on alerts.</p>
      <button type="button" class="pp-btn pp-btn-gold pp-btn-big" data-act="alerts-on">Turn on alerts</button>`;
  } else if (st === "unsupported"){
    steps = `<p>This browser can't show alerts. On your phone, open the portal in ${ios ? "Safari" : "Chrome"} and add it to your home screen.</p>`;
  } else if (st === "on"){
    steps = `<p class="pp-ok-big">✓ Alerts are on for this ${isPhone() ? "phone" : "computer"}.</p><p class="pp-muted">Turn them on on each phone or computer you use.</p>`;
  } else {
    steps = `${android && S.installEvt && !installed() ? `<div class="pp-step"><b>1. Put it on your home screen</b><span>So your leads are one tap away, like any other app.</span><button type="button" class="pp-btn pp-btn-light" data-act="install">Add to home screen</button></div>` : ""}
      <div class="pp-step"><b>${android && S.installEvt && !installed() ? "2. " : ""}Allow notifications</b><span>Tap below, then tap Allow.</span>
      <button type="button" class="pp-btn pp-btn-gold pp-btn-big" data-act="alerts-on">Turn on alerts</button></div>`;
  }
  $("#pp-sheet").innerHTML = `
    <div class="pp-sheet-head"><button type="button" class="pp-back" data-act="close">‹ Back</button></div>
    <h2 class="pp-sheet-name">Lead alerts on your phone</h2>
    <p class="pp-sheet-sub">Get a notification the second a new lead comes in, and a nudge when one needs you - even when the app is closed.</p>
    <section class="pp-block">${steps}</section>
    ${S.me.phone ? "" : `<section class="pp-block"><h3>Backup: a text</h3><p class="pp-muted pp-small">If an alert can't reach you, we'll text this number instead.</p>
      <div class="pp-addnote"><input type="tel" id="pp-phone2" placeholder="Your mobile, e.g. 021 123 4567" autocomplete="tel"><button type="button" class="pp-btn pp-btn-light" data-act="save-phone2">Save</button></div></section>`}`;
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
  const wonAll = S.leads.filter(l => stageOf(l) === "won"), wonV = wonAll.reduce((s, l) => s + (Number(l.job_value) || 0), 0);
  const updated = ads.map(a => a.updated_at).filter(Boolean).sort().pop();
  el.innerHTML = `
    <div class="pp-hero"><div><h1>Your ads</h1><p>${live.length ? `${live.length} ad${live.length === 1 ? "" : "s"} running right now.` : ads.length ? "No ads running right now." : "Your ads will show here once they're live."}</p></div></div>
    <div class="pp-stats">
      <div><span>Leads this week</span><b>${d7}</b></div>
      <div><span>Leads in 30 days</span><b>${d30}</b></div>
      <div><span>Spent on ads</span><b>${spend ? money(spend) : "-"}</b><small>all time</small></div>
      <div><span>Cost per lead</span><b>${spend && results ? money(spend / results) : "-"}</b><small>all time</small></div>
    </div>
    ${wonAll.length ? `<div class="pp-roi"><span>Jobs you've won from these leads</span><b>${wonAll.length} job${wonAll.length === 1 ? "" : "s"}${wonV ? ` · ${money(wonV)}` : ""}</b>${spend && wonV ? `<small>${money(spend)} spent on ads${wonV > spend ? ` - that's ${(wonV / spend).toFixed(1)}x back in work` : ""}</small>` : `<small>Add the job value when you mark a job won to see your return.</small>`}</div>` : ""}
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
  // Their account manager, from our Team page (portal_me looks them up).
  const m = { name: c.manager_name || "Your account manager", email: c.manager_email || "" };
  const stage = { onboarding: "Getting set up", quote_guarantee: "Quote guarantee", live: "Ads live", finished: "Finished" }[c.stage] || "Ads live";
  const next = nextReport(c);
  const qg = c.stage === "quote_guarantee" && c.quote_target;
  const pct = qg ? Math.min(100, Math.round((Number(c.quotes_sent) || 0) / c.quote_target * 100)) : 0;
  const alertsTxt = { on: `<b class="pp-ok">On</b>`, denied: "<small>Blocked</small>", unsupported: "<small>Not on this browser</small>" }[S.alerts];
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
      <div><b>${esc(m.name)}</b>${m.email ? `<a class="pp-btn pp-btn-light" href="mailto:${esc(m.email)}?subject=${encodeURIComponent(c.name)}">Email ${esc(c.manager_name ? m.name.split(" ")[0] : "them")}</a>` : ""}</div>
    </section>
    <section class="pp-block">
      <h3>How your leads work</h3>
      ${c.client_calls ? `<ol class="pp-steps"><li>A lead fills in the form on your ad. It shows up here straight away, and your phone gets an alert.</li><li>Call them - the best ones are at the top of To do, with everything they told us.</li><li>Move each lead along as it goes: call scheduled, site visit, quote sent, job won.</li><li>Can't reach someone? Tap Didn't answer. The next day we'll ask if they got back to you - if not, our team follows them up.</li><li>Haven't rung a lead within 24 hours? Our team calls them for you.</li></ol>`
        : `<ol class="pp-steps"><li>A lead fills in the form on your ad.</li><li>Our team rings them fast and books them in with you.</li><li>You take it from there here: site visit, quote sent, job won.</li></ol>`}
    </section>
    <section class="pp-block pp-settings">
      <h3>Settings</h3>
      ${readOnly() ? `<p class="pp-muted">Settings are the client's own - not shown in the team preview.</p>` : `
      <div class="pp-row"><span>Alerts on this ${isPhone() ? "phone" : "computer"}</span>${alertsTxt || `<button type="button" class="pp-btn pp-btn-gold" data-act="alerts-setup">Set up</button>`}</div>
      <label class="pp-switch"><input type="checkbox" id="pp-notify"${S.me.notify_new_leads ? " checked" : ""}><span>Also email me each new lead</span></label>
      <div class="pp-row pp-phone-row"><span>Text me here if an alert can't reach me</span>
        <span class="pp-addnote"><input type="tel" id="pp-phone" value="${esc(S.me.phone || "")}" placeholder="Your mobile" autocomplete="tel"><button type="button" class="pp-btn pp-btn-light" data-act="save-phone">Save</button></span></div>
      <div class="pp-row"><span>Signed in as ${esc(S.me.email || "")}</span><button type="button" class="pp-btn pp-btn-light" data-act="signout">Sign out</button></div>
      <button type="button" class="pp-link" data-act="change-pw">Change my password</button>`}
    </section>`;
}
async function savePhone(input){
  const v = (input?.value || "").trim();
  if (v && v.replace(/\D/g, "").length < 8) return toast("That number looks too short.");
  try { await rpc("portal_set_settings", { p_notify: null, p_phone: v }); S.me.phone = v.replace(/[^\d+]/g, "") || null; toast(v ? "Saved - we'll text you if an alert can't reach you." : "Number removed."); render(); }
  catch(e){ toast("Couldn't save that - try again."); }
}

/* ───────── events ───────── */
function bind(){
  bindBoardDrag();
  document.addEventListener("click", async (e) => {
    // The click that ends a drag isn't a tap.
    if (Date.now() - DRAG.ended < 400){ e.preventDefault(); return; }
    const card = e.target.closest(".pp-bcard");
    if (card && !e.target.closest("a, button")){ openLead(card.dataset.card); return; }
    const tab = e.target.closest("[data-tab]");
    if (tab){ S.tab = tab.dataset.tab; render(); window.scrollTo(0, 0); return; }
    const v = e.target.closest("[data-view]");
    if (v){ S.view = v.dataset.view; store.set("mpp_view", S.view); render(); return; }
    const dial = e.target.closest("[data-dial]");
    if (dial){
      // The phone app opens; when they come back, ask how it went.
      const id = dial.dataset.dial;
      S.askFor = id; S.dialledAt = Date.now(); S.pendingAsk = id;
      if (!readOnly()) rpc("portal_log_call", { p_lead: id, p_outcome: "dialled" }).catch(() => {});
      if (!isPhone()) setTimeout(() => { if (S.openId !== id) openLead(id, { ask: true }); else { S.askFor = id; renderSheet(); } }, 600);
      return;
    }
    const txt = e.target.closest("[data-text]");
    if (txt){ S.pendingAsk = txt.dataset.text; S.dialledAt = Date.now(); return; }
    const yes = e.target.closest("[data-ask-yes]");
    if (yes){ openLead(yes.dataset.askYes, { ask: true }); return; }
    const no = e.target.closest("[data-ask-no]");
    if (no){ passToUs(no.dataset.askNo); return; }
    const quick = e.target.closest("[data-quick]");
    if (quick){ openLead(quick.dataset.id, { pick: quick.dataset.quick }); return; }
    const open = e.target.closest("[data-open]");
    if (open && !e.target.closest("a")){ openLead(open.dataset.open); return; }
    const pick = e.target.closest("[data-pick]");
    if (pick){
      const note = $("#pp-note"); if (note && S.openId) S.drafts[S.openId] = note.value;
      S.pick = S.pick === pick.dataset.pick ? null : pick.dataset.pick; renderSheet();
      setTimeout(() => $("#pp-out-form, .pp-out-form")?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 30);
      return;
    }
    const copy = e.target.closest("[data-copy]");
    if (copy){ try { await navigator.clipboard.writeText(copy.dataset.copy); toast("Number copied."); } catch(err){ toast(copy.dataset.copy); } return; }
    const act = e.target.closest("[data-act]")?.dataset.act;
    if (!act) return;
    if (act === "close") closeSheet();
    else if (act === "save-stage") saveStage();
    else if (act === "save-note") saveNote();
    else if (act === "ask-yes"){ S.askFor = S.openId; renderSheet(); $("#pp-move")?.scrollIntoView({ block: "start", behavior: "smooth" }); }
    else if (act === "alerts-setup"){ await checkAlerts(); openSheet("alerts"); }
    else if (act === "alerts-later"){ store.set("mpp_alerts_later", nzDay()); render(); }
    else if (act === "alerts-on") turnOnAlerts();
    else if (act === "install"){ try { S.installEvt?.prompt(); await S.installEvt?.userChoice; } catch(err){} S.installEvt = null; renderSheet(); }
    else if (act === "save-phone") savePhone($("#pp-phone"));
    else if (act === "save-phone2") savePhone($("#pp-phone2"));
    else if (act === "signout") signOut();
    else if (act === "change-pw") showSetPassword(true);
  });
  document.addEventListener("input", (e) => {
    if (e.target.id === "pp-search"){
      S.q = e.target.value;
      const pos = e.target.selectionStart;
      renderLeads();
      const s = $("#pp-search"); s.focus(); try { s.setSelectionRange(pos, pos); } catch(err){}
    }
    if (e.target.id === "pp-note" && S.openId) S.drafts[S.openId] = e.target.value;
    if (e.target.id === "pp-newnote" && S.openId) S.drafts["note:" + S.openId] = e.target.value;
  });
  document.addEventListener("change", async (e) => {
    if (e.target.id === "pp-preview-client"){
      S.preview = e.target.value; store.set("mpp_preview_client", S.preview);
      S.known = null; if (S.sheet) shutSheet();
      await loadAll(true).catch(showError);
    }
    if (e.target.id === "pp-period"){ S.period = e.target.value; render(); }
    if (e.target.id === "pp-notify"){
      const on = e.target.checked;
      try { await rpc("portal_set_settings", { p_notify: on, p_phone: null }); S.me.notify_new_leads = on; toast(on ? "We'll email you each new lead too." : "New lead emails are off."); }
      catch(err){ e.target.checked = !on; toast("Couldn't save that - try again."); }
    }
  });
  $("#pp-sheet-wrap").addEventListener("click", (e) => { if (e.target.id === "pp-sheet-wrap") closeSheet(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.sheet) closeSheet(); });
  // Back from the phone app: open the lead and ask how the call went.
  const back = () => {
    if (document.hidden) return;
    refreshLeads();
    if (S.pendingAsk && Date.now() - S.dialledAt > 2500){
      const id = S.pendingAsk; S.pendingAsk = null;
      if (S.openId !== id) openLead(id, { ask: true });
      else { S.askFor = id; renderSheet(); setTimeout(() => $("#pp-move")?.scrollIntoView({ block: "start", behavior: "smooth" }), 80); }
    }
  };
  document.addEventListener("visibilitychange", back);
  window.addEventListener("focus", back);
  window.addEventListener("popstate", () => { if (S.sheet) shutSheet(); });
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installEvt = e; if (S.sheet === "alerts") renderSheet(); });
  // A tapped phone alert while the app is open: go to that lead.
  navigator.serviceWorker?.addEventListener?.("message", (e) => { if (e.data?.lead && S.loaded) refreshAfterSave().then(() => openLead(e.data.lead, { ask: e.data.kind === "checkin" })); });
  setInterval(refreshLeads, POLL_MS);
  setInterval(tickTimers, 1000);
  // Countdown clocks move on even when nothing new arrives.
  setInterval(() => { if (S.loaded && !S.sheet && S.tab === "leads" && !document.hidden && document.activeElement?.id !== "pp-search") render(); }, 60e3);
}

/* ───────── sign in ───────── */
function showScreen(id){
  ["pp-auth", "pp-noaccess", "pp-app", "pp-linkdone"].forEach(x => { const el = $("#" + x); if (el) el.hidden = x !== id; });
}
function authMsg(id, msg){ const el = $(id); el.textContent = msg || ""; el.classList.toggle("on", !!msg); }
function showSetPassword(){
  showScreen("pp-auth");
  $("#pp-signin").hidden = true; $("#pp-setpw").hidden = false;
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
async function start(){
  showScreen("pp-app");
  $("#pp-leads").innerHTML = `<div class="pp-empty">Loading your leads…</div>`;
  const params = new URLSearchParams(location.search);
  const want = params.get("client");
  S.preview = want || store.get("mpp_preview_client") || null;
  S.view = store.get("mpp_view") === "board" ? "board" : "call";
  try {
    await loadAll(true);
  } catch(e){
    // A saved or linked client this login can't see: try again without it.
    if (S.preview){ S.preview = null; try { await loadAll(true); } catch(e2){ return showError(e2); } }
    else return showError(e);
  }
  if (S.me.viewer !== "team" && (S.me.clients || []).length < 2) S.preview = null;
  await checkAlerts(); render();
  const lead = params.get("lead");
  if (lead){ history.replaceState(null, "", location.pathname); openLead(lead, { ask: S.leads.find(l => l.id === lead)?.checkin }); }
}
// "Not yet? Tap to pass them to our team" from a text or email: works without
// signing in (the link's one-off token can only hand that one lead over).
async function linkAnswer(token){
  showScreen("pp-linkdone");
  const box = $("#pp-linkdone-body");
  box.innerHTML = `<h1>Pass this lead to Mr Priceless?</h1><p class="pp-auth-sub">Our team will give them a call for you. If they get back to you first, just update them in the app.</p>
    <button type="button" class="pp-btn pp-btn-gold pp-btn-big" id="pp-link-yes">Yes, pass them over</button>
    <a class="pp-btn pp-btn-light pp-btn-big" href="./">No, open my leads</a>`;
  $("#pp-link-yes").addEventListener("click", async () => {
    try {
      const r = sb ? (await sb.rpc("portal_checkin_link", { p_token: token, p_answer: "no" })) : { data: { ok: true, first: "them" } };
      if (r.error) throw r.error;
      const first = r.data?.first || "them";
      box.innerHTML = `<h1>Done</h1><p class="pp-auth-sub">${r.data?.already ? `${esc(first)} was already sorted - nothing else to do.` : `Our team will follow ${esc(first)} up for you.`}</p><a class="pp-btn pp-btn-gold pp-btn-big" href="./">Open my leads</a>`;
    } catch(e){
      box.innerHTML = `<h1>That link didn't work</h1><p class="pp-auth-sub">It may already have been used. Open your leads to update them there.</p><a class="pp-btn pp-btn-gold pp-btn-big" href="./">Open my leads</a>`;
    }
  });
}
async function init(){
  bind();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js", { scope: "./" }).then(r => { S.swReg = r; }).catch(() => {});
  const params = new URLSearchParams(location.search);
  if (params.get("checkin")){ history.replaceState(null, "", location.pathname); return linkAnswer(params.get("checkin")); }
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
    if (session) start(); else showScreen("pp-auth");
  });

  if (!sb){
    if (IS_CONFIGURED){ showScreen("pp-auth"); authMsg("#pp-auth-msg", "Couldn't load the sign-in tools. Refresh the page."); return; }
    return start();
  }
  // Opened from a "choose your password" email.
  const link = new URLSearchParams(location.hash.replace(/^#/, "") + "&" + location.search.replace(/^\?/, ""));
  const recovery = ["recovery", "invite"].includes(link.get("type"));
  const linkError = link.get("error_description");
  const { data: { session } } = await sb.auth.getSession();
  if (recovery || linkError) history.replaceState(null, "", location.pathname + (link.get("lead") ? `?lead=${encodeURIComponent(link.get("lead"))}` : ""));
  if (session && recovery) showSetPassword();
  else if (session) start();
  else {
    showScreen("pp-auth");
    if (linkError) authMsg("#pp-auth-msg", "That link has expired or was already used. Type your email and tap Forgot your password to get a new one.");
  }
  sb.auth.onAuthStateChange((event, s) => {
    if (event === "PASSWORD_RECOVERY") showSetPassword();
    else if (event === "SIGNED_IN" && s && !S.loaded && $("#pp-setpw").hidden) start();
    else if (event === "SIGNED_OUT") location.replace(location.pathname);
  });
}

/* ───────── demo data (no Supabase config: testing only) ───────── */
let demo = null;
function demoData(){
  if (demo) return demo;
  const ago = (m) => new Date(Date.now() - m * 60e3).toISOString();
  const ahead = (m) => new Date(Date.now() + m * 60e3).toISOString();
  const access = store.get("mpp_demo_viewer") || "client";
  const L = (o) => ({ email: "", answers: [], log: [], notes: [], client_calls: true, ours: false, status: "new", stage: "new", ...o });
  demo = {
    me: { viewer: access, email: access === "team" ? "team@example.com" : "client@example.com", name: "Brett", notify_new_leads: true, phone: null, push_key: null,
      clients: access === "team" ? [{ id: "c1", name: "BB Build Ltd" }, { id: "c2", name: "A and B Concrete" }] : [{ id: "c1", name: "BB Build Ltd" }] },
    client: { id: "c1", name: "BB Build Ltd", stage: "quote_guarantee", quote_target: 10, quotes_sent: 4, since: ago(60 * 24 * 75), ads_since: ago(60 * 24 * 60).slice(0, 10),
      monthly_ad_spend: 1500, services: "Facebook and Instagram ads, lead follow-up and fortnightly reports.", client_calls: true, manager: "max", manager_name: "Max Smith", manager_email: "accounts@example.com", report_anchor: null, last_report_at: ago(60 * 24 * 6) },
    leads: [
      L({ id: "l1", name: "Hemi Walker", phone: "021 555 0148", email: "hemi.w@example.co.nz", at: ago(3), form: "Driveway quote", city: "Albany, Auckland", address: "12 Kauri Road, Albany",
        answers: [{ q: "What do you need done?", a: "Whole driveway replaced, about 60m2" }, { q: "what_are_you_looking_to_invest", a: "$15,000 - $20,000" }, { q: "when_are_you_hoping_to_get_it_done", a: "asap" }, { q: "Do you own the property?", a: "Yes" }],
        ad: "Driveway before/after - video" }),
      L({ id: "l2", name: "Sarah Lin", phone: "027 555 0172", at: ago(42), form: "Patio", city: "Hamilton East", seen_at: ago(30),
        answers: [{ q: "when_are_you_hoping_to_complete_the_project", a: "3-6_months" }, { q: "Budget", a: "Not sure" }, { q: "What are you looking to get done?", a: "Patio out the back" }] }),
      L({ id: "l3", name: "Tom Fraser", phone: "022 555 0190", email: "tom@example.com", at: ago(60 * 30), form: "Retaining wall", city: "Te Atatū", status: "no_answer", stage: "no_answer",
        answers: [{ q: "What's the job?", a: "Retaining wall, 12m long" }, { q: "Budget", a: "$8k" }], first_na_at: ago(60 * 26), checkin: true, checkin_deadline: ahead(60 * 6),
        log: [{ at: ago(60 * 26), by: "you", outcome: "no_answer", note: "Left a voicemail" }], notes: [{ at: ago(60 * 26), stage: "no_answer", from: "new", note: "Left a voicemail" }] }),
      L({ id: "l4", name: "Aroha Pene", phone: "021 555 0111", at: ago(60 * 50), form: "Driveway quote", city: "Howick", status: "no_answer", stage: "no_answer", ours: true, handed_over_at: ago(60 * 2), handover_reason: "client_no",
        answers: [{ q: "When", a: "Next month" }], log: [{ at: ago(60 * 47), by: "you", outcome: "no_answer" }, { at: ago(60), by: "Mr Priceless", outcome: "no_answer", note: "" }] }),
      L({ id: "l11", name: "Jade Kerr", phone: "021 555 0122", at: ago(60 * 7), form: "Driveway quote", city: "Birkenhead", status: "no_answer", stage: "no_answer", first_na_at: ago(60 * 6),
        answers: [{ q: "When", a: "ASAP" }, { q: "Budget", a: "$15k" }], log: [{ at: ago(60 * 6), by: "you", outcome: "no_answer" }], notes: [{ at: ago(60 * 6), stage: "no_answer", from: "new" }] }),
      L({ id: "l5", name: "Mike Doyle", phone: "021 555 0133", at: ago(60 * 50), form: "Driveway quote", city: "Albany", address: "4 Rata St, Albany", status: "site_visit", stage: "site_visit", next_at: ahead(60 * 20),
        answers: [{ q: "Budget", a: "$12k" }, { q: "Size", a: "40m2" }], notes: [{ at: ago(60 * 49), stage: "site_visit", from: "new", when: ahead(60 * 20), note: "Wants exposed aggregate" }] }),
      L({ id: "l6", name: "Kate Moore", phone: "021 555 0144", at: ago(60 * 24 * 6), form: "Driveway quote", city: "Glenfield", status: "booked", stage: "quote_to_send", stage_at: ago(60 * 24 * 2),
        answers: [{ q: "Budget", a: "$20k+" }], notes: [{ at: ago(60 * 24 * 5), stage: "site_visit", from: "new" }, { at: ago(60 * 24 * 2), stage: "quote_to_send", from: "site_visit" }] }),
      L({ id: "l7", name: "Raj Patel", phone: "021 555 0155", at: ago(60 * 24 * 9), form: "Patio", city: "Takapuna", status: "booked", stage: "quote_sent", quote_amount: 9400, quote_sent_at: ago(60 * 24 * 4), stage_at: ago(60 * 24 * 4),
        answers: [{ q: "Budget", a: "$10k" }], notes: [{ at: ago(60 * 24 * 7), stage: "site_visit", from: "new" }, { at: ago(60 * 24 * 4), stage: "quote_sent", from: "site_visit", amount: 9400 }] }),
      L({ id: "l8", name: "Lisa Brown", phone: "021 555 0166", at: ago(60 * 24 * 12), form: "Driveway quote", city: "Albany", status: "booked", stage: "won", job_value: 14200, stage_at: ago(60 * 24 * 1),
        notes: [{ at: ago(60 * 24 * 10), stage: "site_visit" }, { at: ago(60 * 24 * 7), stage: "quote_sent", amount: 14200 }, { at: ago(60 * 24), stage: "won", amount: 14200 }] }),
      L({ id: "l9", name: "Grant Ellis", phone: "027 555 0164", at: ago(60 * 24 * 6), form: "Patio", city: "Mt Maunganui", status: "not_interested", stage: "lost", lost_reason: "Went with someone else",
        notes: [{ at: ago(60 * 24 * 5), stage: "lost", from: "new", reason: "Went with someone else" }] }),
      L({ id: "l10", name: "Ben Carter", phone: "021 555 0109", at: ago(60 * 5), form: "Driveway quote", city: "Takapuna", status: "call_back", stage: "call_scheduled", next_at: ahead(45),
        answers: [{ q: "When", a: "Within a month" }], notes: [{ at: ago(60 * 4), stage: "call_scheduled", from: "new", when: ahead(45), note: "At work, ring after lunch" }] }),
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
  const copy = (x) => JSON.parse(JSON.stringify(x));
  if (fn === "portal_me") return copy({ ...d.me, client: d.client });
  if (fn === "portal_leads") return copy(d.leads);
  if (fn === "portal_ads") return copy(d.ads);
  if (fn === "portal_set_settings"){ if (args.p_notify != null) d.me.notify_new_leads = !!args.p_notify; if (args.p_phone != null) d.me.phone = args.p_phone || null; return { ok: true }; }
  if (fn === "portal_save_push") return { ok: true };
  const l = d.leads.find(x => x.id === args.p_lead);
  if (!l) throw new Error("Not allowed");
  if (fn === "portal_checkin"){ l.ours = true; l.checkin = false; l.handed_over_at = new Date().toISOString(); l.handover_reason = "client_no"; l.notes.push({ at: new Date().toISOString(), note: "Passed to Mr Priceless to follow up" }); return { ok: true }; }
  if (fn === "portal_log_call"){
    if (args.p_outcome === "seen") l.seen_at = l.seen_at || new Date().toISOString();
    if (args.p_outcome === "dialled") l.dialled_at = new Date().toISOString();
    return { ok: true };
  }
  if (fn === "portal_update_lead"){
    const now = new Date().toISOString(), st = args.p_stage;
    if (st === "call_scheduled" && !args.p_when) throw new Error("Pick when to call them");
    l.notes.push(Object.fromEntries(Object.entries({ at: now, stage: st, from: st ? l.stage : null, note: args.p_note, when: args.p_when, amount: args.p_amount, reason: args.p_reason }).filter(([, v]) => v != null && v !== "")));
    if (st){
      if (l.checkin){ l.checkin = false; if (st === "no_answer"){ l.ours = true; l.handed_over_at = now; l.handover_reason = "client_no"; } }
      if (st === "no_answer"){ l.log.push({ at: now, by: "you", outcome: "no_answer", note: args.p_note || "" }); l.first_na_at = l.first_na_at || now; }
      l.stage = st; l.stage_at = now;
      if (st === "call_scheduled" || st === "site_visit") l.next_at = args.p_when; else l.next_at = null;
      if (st === "quote_sent"){ if (args.p_amount != null) l.quote_amount = args.p_amount; l.quote_sent_at = now; }
      if (st === "won") l.job_value = args.p_amount ?? l.quote_amount ?? null;
      if (st === "lost" || st === "not_qualified") l.lost_reason = args.p_reason;
    }
    return { ok: true };
  }
  throw new Error("Unknown");
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
