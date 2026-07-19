/* Mr Priceless CRM — app logic (vanilla JS, no build step) */
(function(){
"use strict";

const { supabase, IS_CONFIGURED } = window.CRM_DB;

const STAGES = [
  { key: "not_qualified", label: "Not Qualified" },
  { key: "qualified", label: "Qualified" },
  { key: "proposal", label: "Proposal Meeting" },
  { key: "negotiation", label: "Negotiation" },
];
const OUTCOMES = {
  no_answer: { label: "No Answer", cls: "gray" },
  call_back: { label: "Call Back", cls: "gold" },
  not_interested: { label: "Not Interested", cls: "red" },
  interested: { label: "Interested", cls: "green" },
  booked_meeting: { label: "Booked Meeting", cls: "black" },
};
const CONTACT_STATUS = {
  lead: { label: "Lead", cls: "gray" },
  active: { label: "Active", cls: "gold" },
  client: { label: "Client", cls: "green" },
  inactive: { label: "Inactive", cls: "red" },
};

const state = {
  page: "dashboard",
  user: null,
  contacts: [],
  coldCalls: [],
  deals: [],
  notes: [],
  regions: [],
  team: [],
  contactFilter: "",
  contactSearch: "",
  googleAccessToken: null,
  calendarEvents: [],
  calendarWeekStart: startOfWeek(new Date()),
};

const CAL_HOUR_START = 7;
const CAL_HOUR_END = 21;
const CAL_ROW_H = 48;
function startOfWeek(d){
  const dt = new Date(d);
  const dayIdx = (dt.getDay() + 6) % 7; // Monday = 0
  dt.setDate(dt.getDate() - dayIdx);
  dt.setHours(0,0,0,0);
  return dt;
}

const SUPABASE_URL = window.CRM_CONFIG.SUPABASE_URL;
const SUPABASE_ANON_KEY = window.CRM_CONFIG.SUPABASE_ANON_KEY;
const FUNCTIONS_URL = SUPABASE_URL ? SUPABASE_URL + "/functions/v1" : "";

const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));
const fmtMoney = (n) => "$" + Number(n||0).toLocaleString(undefined,{maximumFractionDigits:0});
const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}) : "—";
const timeAgo = (iso) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime())/1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s/60)+"m ago";
  if (s < 86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
};
const uid = () => "id-" + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

/* ───────── Demo seed (used only when Supabase isn't configured) ───────── */
function seedDemo(){
  const c1 = uid(), c2 = uid(), c3 = uid();
  state.contacts = [
    { id:c1, name:"Aroha Ngata", company:"Kauri Property Group", email:"aroha@kauriproperty.co.nz", phone:"021 555 0142", status:"client", tags:"Real Estate", created_at:new Date(Date.now()-86400e3*30).toISOString() },
    { id:c2, name:"Ben Whitfield", company:"Summit Dental", email:"ben@summitdental.co.nz", phone:"027 555 0198", status:"active", tags:"Healthcare", created_at:new Date(Date.now()-86400e3*10).toISOString() },
    { id:c3, name:"Priya Chand", company:"Chand Legal", email:"priya@chandlegal.co.nz", phone:"022 555 0177", status:"lead", tags:"Legal", created_at:new Date(Date.now()-86400e3*2).toISOString() },
  ];
  state.coldCalls = [
    { id:uid(), contact_id:c3, contact_name:"Priya Chand", phone:"022 555 0177", call_date:new Date(Date.now()-86400e3*1).toISOString().slice(0,10), outcome:"interested", follow_up_date:new Date(Date.now()+86400e3*3).toISOString().slice(0,10), notes:"Wants a proposal for SEO + Google Ads.", created_at:new Date(Date.now()-3600e3*20).toISOString() },
    { id:uid(), contact_id:null, contact_name:"Marlon Reeve — Reeve Builders", phone:"021 555 0111", call_date:new Date().toISOString().slice(0,10), outcome:"no_answer", follow_up_date:new Date(Date.now()+86400e3*1).toISOString().slice(0,10), notes:"Left voicemail.", created_at:new Date(Date.now()-3600e3*2).toISOString() },
  ];
  state.deals = [
    { id:uid(), contact_id:c1, contact_name:"Aroha Ngata", title:"Kauri — Full funnel rebuild", value:8500, stage:"negotiation", notes:"", created_at:new Date(Date.now()-86400e3*14).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), contact_id:c2, contact_name:"Ben Whitfield", title:"Summit Dental — Meta Ads retainer", value:2200, stage:"qualified", notes:"", created_at:new Date(Date.now()-86400e3*20).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), contact_id:c3, contact_name:"Priya Chand", title:"Chand Legal — SEO + Ads", value:3600, stage:"proposal", notes:"", created_at:new Date(Date.now()-86400e3*1).toISOString(), updated_at:new Date().toISOString() },
  ];
  state.calendarEvents = [
    { id:"demo-1", summary:"Discovery call — Reeve Builders", start:{ dateTime:new Date(Date.now()+3600e3*3).toISOString() }, end:{ dateTime:new Date(Date.now()+3600e3*3.5).toISOString() }, attendees:[{ email:"marlon@reevebuilders.co.nz" }] },
    { id:"demo-2", summary:"Internal pipeline review", start:{ dateTime:new Date(Date.now()+86400e3*1).toISOString() }, end:{ dateTime:new Date(Date.now()+86400e3*1+3600e3).toISOString() }, attendees:[{ email:"rockyoneill02@gmail.com" }] },
  ];
  state.notes = [
    { id:uid(), title:"Q3 outreach plan", body:"Focus cold calls on trades + legal this month. Aim for 20 dials/day between us.", contact_id:null, deal_id:null, created_at:new Date(Date.now()-86400e3*5).toISOString() },
  ];
  state.regions = [
    { id:uid(), region:"Auckland CBD", calls_made:64, meetings_booked:6, notes:"Worked through the Queen St + Britomart lists.", created_at:new Date(Date.now()-86400e3*12).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), region:"North Shore", calls_made:38, meetings_booked:2, notes:"Started this week, more to go.", created_at:new Date(Date.now()-86400e3*3).toISOString(), updated_at:new Date().toISOString() },
  ];
}

/* ───────── Data layer ───────── */
const DataLayer = {
  async fetchAll(){
    if (!IS_CONFIGURED){ return; }
    const [c, cc, d, n, r] = await Promise.all([
      supabase.from("contacts").select("*").order("created_at",{ascending:false}),
      supabase.from("cold_calls").select("*").order("created_at",{ascending:false}),
      supabase.from("deals").select("*").order("created_at",{ascending:false}),
      supabase.from("notes").select("*").order("created_at",{ascending:false}),
      supabase.from("prospecting_regions").select("*").order("region",{ascending:true}),
    ]);
    state.contacts = c.data || [];
    state.coldCalls = cc.data || [];
    state.deals = d.data || [];
    state.notes = n.data || [];
    state.regions = r.data || [];
  },
  async insert(table, row){
    row.created_by = state.user ? state.user.email : "demo";
    if (!IS_CONFIGURED){
      row.id = uid(); row.created_at = new Date().toISOString();
      stateArray(table).unshift(row);
      renderAll();
      return row;
    }
    const { data, error } = await supabase.from(table).insert(row).select().single();
    if (error){ alert(error.message); return null; }
    return data;
  },
  async update(table, id, patch){
    if (!IS_CONFIGURED){
      const arr = stateArray(table);
      const item = arr.find(x => x.id === id);
      if (item) Object.assign(item, patch);
      renderAll();
      return item;
    }
    const { data, error } = await supabase.from(table).update(patch).eq("id", id).select().single();
    if (error){ alert(error.message); return null; }
    return data;
  },
  async remove(table, id){
    if (!IS_CONFIGURED){
      const arr = stateArray(table);
      const idx = arr.findIndex(x => x.id === id);
      if (idx > -1) arr.splice(idx,1);
      renderAll();
      return;
    }
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error){ alert(error.message); return; }
  }
};
function stateArray(table){
  return { contacts: state.contacts, cold_calls: state.coldCalls, deals: state.deals, notes: state.notes, prospecting_regions: state.regions }[table];
}

/* ───────── Realtime ───────── */
let realtimeSubscribed = false;
function subscribeRealtime(){
  if (!IS_CONFIGURED || realtimeSubscribed) return;
  realtimeSubscribed = true;
  supabase.channel("crm-live")
    .on("postgres_changes", { event:"*", schema:"public", table:"contacts" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"cold_calls" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"deals" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"notes" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"prospecting_regions" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"INSERT", schema:"public", table:"meeting_reviews" }, () => { checkPendingMeetingReviews(); })
    .subscribe();
}

/* ───────── Auth (Google sign-in + allowlist gate) ───────── */
async function initAuth(){
  if (!IS_CONFIGURED){
    seedDemo();
    state.user = { email: "demo@mrpriceless.co.nz" };
    state.team = [{ email: "demo@mrpriceless.co.nz", invited_by: "setup", created_at: new Date().toISOString() }];
    showApp();
    reviewQueue = [{ id:"demo-review-1", meeting_title:"Discovery call — Reeve Builders", attendees:["marlon@reevebuilders.co.nz"] }];
    showNextReview();
    return;
  }
  const { data:{ session } } = await supabase.auth.getSession();
  if (session) await handleSignedIn(session);
  else showAuth();

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "SIGNED_IN" && session){
      await handleSignedIn(session, /*freshLogin*/ true);
    } else if (event === "SIGNED_OUT"){
      state.user = null;
      location.reload();
    }
  });
}

async function handleSignedIn(session, freshLogin){
  state.user = session.user;
  state.googleAccessToken = session.provider_token || state.googleAccessToken;

  // First time we see a Google refresh token (only returned right after consent),
  // stash it server-side so we can mint fresh access tokens later without
  // asking this person to sign in again.
  if (freshLogin && session.provider_refresh_token){
    const { error } = await supabase.from("google_tokens").upsert({
      user_id: session.user.id,
      refresh_token: session.provider_refresh_token,
    });
    if (error) console.error("Couldn't save Google refresh token:", error.message);
  } else if (freshLogin){
    console.warn("Google sign-in didn't return a refresh token — use the Calendar page's Connect button to retry.");
  }

  const allowed = await isAllowlisted(session.user.email);
  if (!allowed){
    showUnauthorized(session.user.email);
    return;
  }

  await DataLayer.fetchAll();
  await fetchTeam();
  subscribeRealtime();
  showApp();
  await checkPendingMeetingReviews();
  loadCalendarWeek();
}

async function isAllowlisted(email){
  const { data } = await supabase.from("allowlist").select("email").eq("email", email).maybeSingle();
  return Boolean(data);
}

function showAuth(){
  $("#auth-screen").style.display = "flex";
  $("#unauthorized-screen").style.display = "none";
  $("#app").classList.remove("visible");
}
function showUnauthorized(email){
  $("#auth-screen").style.display = "none";
  $("#unauthorized-screen").style.display = "flex";
  $("#app").classList.remove("visible");
  $("#unauthorized-email").textContent = email;
}
function showApp(){
  $("#auth-screen").style.display = "none";
  $("#unauthorized-screen").style.display = "none";
  $("#app").classList.add("visible");
  $("#demo-banner").style.display = IS_CONFIGURED ? "none" : "flex";
  const emailChip = $("#user-email");
  if (emailChip) emailChip.textContent = state.user.email;
  const initial = $("#user-initial");
  if (initial) initial.textContent = (state.user.email||"?").charAt(0).toUpperCase();
  renderAll();
}

function startGoogleOAuth(){
  return supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      scopes: "https://www.googleapis.com/auth/calendar.events",
      queryParams: { access_type: "offline", prompt: "consent" },
      redirectTo: window.location.origin + window.location.pathname,
    },
  });
}
function setupGoogleAuth(){
  $("#google-signin-btn").addEventListener("click", async () => {
    if (!IS_CONFIGURED) return;
    const { error } = await startGoogleOAuth();
    if (error){
      const errBox = $("#auth-error");
      errBox.textContent = error.message;
      errBox.classList.add("visible");
    }
  });
  $("#unauthorized-signout-btn").addEventListener("click", async () => {
    if (IS_CONFIGURED) await supabase.auth.signOut();
    else location.reload();
  });
  $("#connect-calendar-btn")?.addEventListener("click", async () => {
    if (!IS_CONFIGURED){ alert("Connect Supabase first (see README.md)."); return; }
    await startGoogleOAuth();
  });
}

/* ───────── Auth (email/password — quick-start alternative to Google) ───────── */
function setupEmailAuth(){
  let mode = "signin";
  $$(".auth-tab").forEach(tab => tab.addEventListener("click", () => {
    mode = tab.dataset.mode;
    $$(".auth-tab").forEach(t => t.classList.toggle("active", t === tab));
    $("#auth-submit").textContent = mode === "signin" ? "Sign In" : "Create Account";
  }));
  $("#auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!IS_CONFIGURED) return;
    const email = $("#auth-email").value.trim();
    const password = $("#auth-password").value;
    const errBox = $("#auth-error");
    errBox.classList.remove("visible");
    try {
      if (mode === "signin"){
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        errBox.textContent = "Account created. Check your email if confirmation is required, then sign in.";
        errBox.classList.add("visible");
        return;
      }
    } catch (err){
      errBox.textContent = err.message || "Something went wrong.";
      errBox.classList.add("visible");
    }
  });
}

/* ───────── Navigation ───────── */
function setupNav(){
  $$(".nav-item").forEach(btn => {
    btn.addEventListener("click", () => {
      state.page = btn.dataset.page;
      $$(".nav-item").forEach(b => b.classList.toggle("active", b === btn));
      $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + state.page));
    });
  });
  $("#signout-btn")?.addEventListener("click", async () => {
    if (IS_CONFIGURED) await supabase.auth.signOut();
    else location.reload();
  });
}

/* ───────── Render: Dashboard ───────── */
function renderDashboard(){
  const qualifiedThisMonth = state.deals.filter(d => d.stage === "qualified" && sameMonth(d.updated_at || d.created_at));
  const callsThisWeek = state.coldCalls.filter(c => withinDays(c.created_at, 7));
  const pipelineValue = state.deals.reduce((s,d) => s + Number(d.value||0), 0);

  $("#stat-contacts").textContent = state.contacts.length;
  $("#stat-calls").textContent = callsThisWeek.length;
  $("#stat-pipeline").textContent = fmtMoney(pipelineValue);
  $("#stat-won").textContent = fmtMoney(qualifiedThisMonth.reduce((s,d)=>s+Number(d.value||0),0));

  const events = [
    ...state.coldCalls.map(c => ({ t:c.created_at, text:`Cold call logged with <b>${escapeHtml(c.contact_name)}</b> — ${OUTCOMES[c.outcome]?.label||c.outcome}` })),
    ...state.deals.map(d => ({ t:d.created_at, text:`Deal created — <b>${escapeHtml(d.title)}</b> (${fmtMoney(d.value)})` })),
    ...state.notes.map(n => ({ t:n.created_at, text:`Note added — <b>${escapeHtml(n.title||"Untitled")}</b>` })),
  ].sort((a,b) => new Date(b.t) - new Date(a.t)).slice(0,8);

  $("#activity-list").innerHTML = events.length ? events.map(e => `
    <div class="activity-row">
      <div class="activity-dot"></div>
      <div>
        <div class="activity-text">${e.text}</div>
        <div class="activity-time">${timeAgo(e.t)}</div>
      </div>
    </div>
  `).join("") : emptyState("No activity yet — log a cold call or add a deal to get started.");

  const followUps = state.coldCalls.filter(c => c.follow_up_date).sort((a,b)=> new Date(a.follow_up_date)-new Date(b.follow_up_date)).slice(0,6);
  $("#followup-list").innerHTML = followUps.length ? followUps.map(c => `
    <div class="activity-row">
      <div class="activity-dot"></div>
      <div>
        <div class="activity-text"><b>${escapeHtml(c.contact_name)}</b></div>
        <div class="activity-time">Follow up ${fmtDate(c.follow_up_date)}</div>
      </div>
    </div>
  `).join("") : emptyState("No follow-ups scheduled.");
}
function sameMonth(iso){ const d=new Date(iso), n=new Date(); return d.getMonth()===n.getMonth() && d.getFullYear()===n.getFullYear(); }
function withinDays(iso, days){ return (Date.now()-new Date(iso).getTime()) < days*86400e3; }
function emptyState(msg){ return `<div class="empty-state"><p>${escapeHtml(msg)}</p></div>`; }

/* ───────── Render: Contacts ───────── */
function renderContacts(){
  const q = state.contactSearch.toLowerCase();
  const filtered = state.contacts.filter(c => {
    const matchesQ = !q || [c.name,c.company,c.email].some(v => (v||"").toLowerCase().includes(q));
    const matchesF = !state.contactFilter || c.status === state.contactFilter;
    return matchesQ && matchesF;
  });
  const tbody = $("#contacts-tbody");
  if (!filtered.length){ tbody.innerHTML = `<tr><td colspan="6">${emptyState("No contacts match. Add your first contact.")}</td></tr>`; return; }
  tbody.innerHTML = filtered.map(c => `
    <tr data-id="${c.id}">
      <td><div class="row-name">${escapeHtml(c.name)}</div><div class="row-sub">${escapeHtml(c.tags||"")}</div></td>
      <td>${escapeHtml(c.company||"—")}</td>
      <td>${escapeHtml(c.email||"—")}</td>
      <td>${escapeHtml(c.phone||"—")}</td>
      <td><span class="badge ${CONTACT_STATUS[c.status]?.cls||"gray"}">${CONTACT_STATUS[c.status]?.label||c.status}</span></td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="icon-btn" data-action="edit-contact" data-id="${c.id}" title="Edit">${ICONS.edit}</button>
        <button class="icon-btn" data-action="delete-contact" data-id="${c.id}" title="Delete">${ICONS.trash}</button>
      </td>
    </tr>
  `).join("");
}

/* ───────── Render: Deals (Kanban) ───────── */
function renderDeals(){
  const board = $("#kanban-board");
  const totalEl = $("#pipeline-total");
  if (totalEl) totalEl.textContent = fmtMoney(state.deals.reduce((s,d) => s + Number(d.value||0), 0));
  board.innerHTML = STAGES.map(stage => {
    const deals = state.deals.filter(d => d.stage === stage.key);
    const stageValue = deals.reduce((s,d) => s + Number(d.value||0), 0);
    return `
      <div class="kanban-col" data-stage="${stage.key}">
        <div class="kanban-col-head">
          <h4>${stage.label}</h4>
          <span class="kanban-count">${deals.length}</span>
        </div>
        <div class="kanban-col-value">${fmtMoney(stageValue)}</div>
        ${deals.map(d => `
          <div class="deal-card" draggable="true" data-id="${d.id}">
            <h5>${escapeHtml(d.title)}</h5>
            <div class="deal-contact">${escapeHtml(d.contact_name||"No contact")}</div>
            <div class="deal-card-foot">
              <span class="deal-value">${fmtMoney(d.value)}</span>
              <button class="icon-btn" data-action="delete-deal" data-id="${d.id}" title="Delete">${ICONS.trash}</button>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }).join("");
  setupDragDrop();
}
function setupDragDrop(){
  let draggedId = null;
  $$(".deal-card").forEach(card => {
    card.addEventListener("dragstart", (e) => {
      draggedId = card.dataset.id;
      card.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  $$(".kanban-col").forEach(col => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("dragover"); });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      if (!draggedId) return;
      await DataLayer.update("deals", draggedId, { stage: col.dataset.stage, updated_at: new Date().toISOString() });
    });
  });
}

/* ───────── Render: Notes ───────── */
function renderNotes(){
  const grid = $("#notes-grid");
  if (!state.notes.length){ grid.innerHTML = emptyState("No notes yet. Jot down your first one."); return; }
  grid.innerHTML = state.notes.map(n => `
    <div class="note-card" data-id="${n.id}">
      <button class="icon-btn note-del" data-action="delete-note" data-id="${n.id}" title="Delete">${ICONS.trash}</button>
      <h5>${escapeHtml(n.title||"Untitled")}</h5>
      <p>${escapeHtml(n.body)}</p>
      <div class="note-meta">${timeAgo(n.created_at)}${n.contact_id ? " · " + escapeHtml(contactName(n.contact_id)) : ""}</div>
    </div>
  `).join("");
}
function contactName(id){ return state.contacts.find(c => c.id === id)?.name || ""; }

/* ───────── Render: Prospecting (by region) ───────── */
function renderRegions(){
  const tbody = $("#regions-tbody");
  if (!tbody) return;
  if (!state.regions.length){ tbody.innerHTML = `<tr><td colspan="6">${emptyState("No regions yet. Add the first region you're calling through.")}</td></tr>`; return; }
  const sorted = [...state.regions].sort((a,b) => (a.region||"").localeCompare(b.region||""));
  tbody.innerHTML = sorted.map(r => {
    const calls = Number(r.calls_made||0);
    const meetings = Number(r.meetings_booked||0);
    const conversion = calls > 0 ? Math.round((meetings/calls)*100) + "%" : "—";
    return `
    <tr data-id="${r.id}">
      <td><div class="row-name">${escapeHtml(r.region)}</div></td>
      <td>${calls.toLocaleString()}</td>
      <td>${meetings.toLocaleString()}</td>
      <td>${conversion}</td>
      <td style="max-width:260px;"><span class="row-sub" style="font-size:12.5px;color:var(--text);">${escapeHtml(r.notes||"")}</span></td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="icon-btn" data-action="edit-region" data-id="${r.id}" title="Edit">${ICONS.edit}</button>
        <button class="icon-btn" data-action="delete-region" data-id="${r.id}" title="Delete">${ICONS.trash}</button>
      </td>
    </tr>
  `;
  }).join("");
}

function renderAll(){
  renderDashboard();
  renderContacts();
  renderDeals();
  renderNotes();
  renderRegions();
  renderTeam();
  renderCalendarGrid();
  fillContactDropdowns();
}

/* ───────── Team / invites ───────── */
async function fetchTeam(){
  if (!IS_CONFIGURED) return;
  const { data } = await supabase.from("allowlist").select("*").order("created_at", { ascending: true });
  state.team = data || [];
}
function renderTeam(){
  const list = $("#team-list");
  if (!list) return;
  if (!state.team.length){ list.innerHTML = emptyState("No teammates yet."); return; }
  list.innerHTML = state.team.map(t => `
    <div class="team-row">
      <div class="team-row-name">
        <div class="team-row-avatar">${(t.email||"?").charAt(0).toUpperCase()}</div>
        <div>
          <div class="team-row-email">${escapeHtml(t.email)}</div>
          <div class="team-row-sub">${t.email === (state.user && state.user.email) ? "You" : "Invited " + timeAgo(t.created_at)}</div>
        </div>
      </div>
    </div>
  `).join("");
}
function setupTeam(){
  const form = $("#invite-form");
  if (!form) return;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#invite-email").value.trim();
    const msg = $("#invite-message");
    const submitBtn = $("#invite-submit");
    msg.textContent = "";
    if (!IS_CONFIGURED){
      msg.style.color = "var(--gold)";
      msg.textContent = "Connect Supabase first (see README.md) to send real invites.";
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "Inviting…";
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const resp = await fetch(`${FUNCTIONS_URL}/invite-user`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`,
          "apikey": SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({ email }),
      });
      const result = await resp.json();
      if (!resp.ok) throw new Error(result.error || "Something went wrong.");
      msg.style.color = "var(--success)";
      msg.textContent = `Invited ${result.email}. They'll get an email to get started.`;
      form.reset();
      await fetchTeam();
      renderTeam();
    } catch (err){
      msg.style.color = "var(--danger)";
      msg.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = "+ Invite";
    }
  });
}

/* ───────── Google Calendar sync ───────── */
async function getValidGoogleToken(){
  if (state.googleAccessToken) return state.googleAccessToken;
  return refreshGoogleToken();
}
async function refreshGoogleToken(){
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(`${FUNCTIONS_URL}/refresh-google-token`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${session.access_token}`, "apikey": SUPABASE_ANON_KEY },
  });
  const result = await resp.json();
  if (!resp.ok) throw new Error(result.error || "Couldn't refresh Google access.");
  state.googleAccessToken = result.access_token;
  return state.googleAccessToken;
}
/* ───────── Calendar page: Google-Calendar-style week grid ───────── */
async function loadCalendarWeek(){
  if (!IS_CONFIGURED){ renderCalendarGrid(); return; }
  const timeMin = state.calendarWeekStart.toISOString();
  const weekEnd = new Date(state.calendarWeekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);
  const timeMax = weekEnd.toISOString();
  try {
    let token = await getValidGoogleToken();
    let resp = await fetchCalendarEvents(token, timeMin, timeMax);
    if (resp.status === 401){
      token = await refreshGoogleToken();
      resp = await fetchCalendarEvents(token, timeMin, timeMax);
    }
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error?.message || "Couldn't load your calendar.");
    state.calendarEvents = (data.items || []).filter(ev => ev.start?.dateTime);
    renderCalendarGrid();
  } catch (err){
    state.calendarEvents = [];
    renderCalendarGrid(err.message);
  }
}
function fetchCalendarEvents(token, timeMin, timeMax){
  const params = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", maxResults: "50" });
  return fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
function patchCalendarEvent(token, eventId, patch){
  return fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

function fmtHourLabel(h){
  const period = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return hour12 + " " + period;
}
function fmtEventTime(ev){
  const s = new Date(ev.start.dateTime), e = new Date(ev.end?.dateTime || s);
  return s.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"}) + " – " + e.toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
}
function formatWeekRange(start, end){
  const sameMonth = start.getMonth() === end.getMonth();
  const startStr = start.toLocaleDateString(undefined,{month:"short",day:"numeric"});
  const endStr = sameMonth ? end.getDate() : end.toLocaleDateString(undefined,{month:"short",day:"numeric"});
  return `${startStr} – ${endStr}, ${end.getFullYear()}`;
}
function calEventStyle(ev){
  const start = new Date(ev.start.dateTime);
  const end = new Date(ev.end?.dateTime || start);
  const startMins = Math.max(start.getHours()*60 + start.getMinutes(), CAL_HOUR_START*60);
  const endMins = Math.min(Math.max(end.getHours()*60 + end.getMinutes(), startMins+15), CAL_HOUR_END*60);
  const top = (startMins - CAL_HOUR_START*60) / 60 * CAL_ROW_H;
  const height = Math.max((endMins - startMins) / 60 * CAL_ROW_H, 20);
  return `top:${top}px;height:${height}px;`;
}

function renderCalendarGrid(errorMsg){
  const grid = $("#calendar-grid");
  if (!grid) return;
  const weekStart = state.calendarWeekStart;
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
  const label = $("#calendar-range-label");
  if (label) label.textContent = formatWeekRange(weekStart, weekEnd);

  const days = [...Array(7)].map((_,i) => { const d = new Date(weekStart); d.setDate(d.getDate()+i); return d; });
  const todayStr = new Date().toDateString();
  const now = Date.now();

  let html = `<div class="calendar-grid-corner"></div>`;
  days.forEach(d => {
    html += `<div class="calendar-day-head ${d.toDateString()===todayStr?"today":""}">
      <div class="dow">${d.toLocaleDateString(undefined,{weekday:"short"})}</div>
      <div class="dom">${d.getDate()}</div>
    </div>`;
  });

  html += `<div class="calendar-hours-col">`;
  for (let h = CAL_HOUR_START; h < CAL_HOUR_END; h++){
    html += `<div class="calendar-hour-label">${fmtHourLabel(h)}</div>`;
  }
  html += `</div>`;

  const colHeight = (CAL_HOUR_END - CAL_HOUR_START) * CAL_ROW_H;
  days.forEach(d => {
    const dayEvents = state.calendarEvents.filter(ev => new Date(ev.start.dateTime).toDateString() === d.toDateString());
    html += `<div class="calendar-day-col" data-date="${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}" style="height:${colHeight}px;">`;
    dayEvents.forEach(ev => {
      const isPast = new Date(ev.end?.dateTime || ev.start.dateTime).getTime() < now;
      html += `<div class="calendar-event ${isPast?"past":""}" draggable="true" data-id="${ev.id}" style="${calEventStyle(ev)}" title="Click to edit · drag to reschedule">
        <div class="ce-title">${escapeHtml(ev.summary || "Untitled meeting")}</div>
        <div class="ce-time">${fmtEventTime(ev)}</div>
      </div>`;
    });
    html += `</div>`;
  });

  grid.innerHTML = html;

  const emptyBox = $("#calendar-empty");
  if (emptyBox){
    if (errorMsg) emptyBox.innerHTML = emptyState(errorMsg);
    else if (!state.calendarEvents.length) emptyBox.innerHTML = emptyState("No events this week.");
    else emptyBox.innerHTML = "";
  }

  setupCalendarDragDrop();
}

function setupCalendarNav(){
  $("#calendar-prev-btn")?.addEventListener("click", () => {
    state.calendarWeekStart.setDate(state.calendarWeekStart.getDate() - 7);
    loadCalendarWeek();
  });
  $("#calendar-next-btn")?.addEventListener("click", () => {
    state.calendarWeekStart.setDate(state.calendarWeekStart.getDate() + 7);
    loadCalendarWeek();
  });
  $("#calendar-today-btn")?.addEventListener("click", () => {
    state.calendarWeekStart = startOfWeek(new Date());
    loadCalendarWeek();
  });
}

function setupCalendarDragDrop(){
  let draggedId = null, grabOffsetPx = 0, durationMs = 30*60000, dragMoved = false;
  $$(".calendar-event").forEach(evEl => {
    evEl.addEventListener("dragstart", (e) => {
      draggedId = evEl.dataset.id;
      dragMoved = false;
      grabOffsetPx = e.clientY - evEl.getBoundingClientRect().top;
      const ev = state.calendarEvents.find(x => x.id === draggedId);
      durationMs = ev ? (new Date(ev.end.dateTime) - new Date(ev.start.dateTime)) : 30*60000;
      evEl.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    evEl.addEventListener("drag", () => { dragMoved = true; });
    evEl.addEventListener("dragend", () => evEl.classList.remove("dragging"));
    evEl.addEventListener("click", () => {
      if (dragMoved) return;
      openEventModal(evEl.dataset.id);
    });
  });
  $$(".calendar-day-col").forEach(col => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("dragover"); });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      if (!draggedId) return;
      const rect = col.getBoundingClientRect();
      const dropY = e.clientY - rect.top - grabOffsetPx;
      let mins = CAL_HOUR_START*60 + (dropY / CAL_ROW_H) * 60;
      mins = Math.round(mins / 15) * 15;
      mins = Math.max(CAL_HOUR_START*60, Math.min(mins, CAL_HOUR_END*60 - 15));
      const newStart = new Date(col.dataset.date + "T00:00:00");
      newStart.setMinutes(mins);
      const newEnd = new Date(newStart.getTime() + durationMs);
      await rescheduleCalendarEvent(draggedId, newStart, newEnd);
      draggedId = null;
    });
  });
}

async function rescheduleCalendarEvent(eventId, newStart, newEnd){
  await applyCalendarEventPatch(eventId, {
    start: { dateTime: newStart.toISOString() },
    end: { dateTime: newEnd.toISOString() },
  }, "reschedule");
}

async function applyCalendarEventPatch(eventId, patch, failVerb){
  const ev = state.calendarEvents.find(x => x.id === eventId);
  if (!ev) return;
  if (!IS_CONFIGURED){
    Object.assign(ev, patch);
    renderCalendarGrid();
    return;
  }
  try {
    let token = await getValidGoogleToken();
    let resp = await patchCalendarEvent(token, eventId, patch);
    if (resp.status === 401){
      token = await refreshGoogleToken();
      resp = await patchCalendarEvent(token, eventId, patch);
    }
    const result = await resp.json();
    if (!resp.ok) throw new Error(result.error?.message || "Google Calendar rejected the change.");
    Object.assign(ev, result);
    renderCalendarGrid();
  } catch (err){
    alert(`Couldn't ${failVerb || "update"} this meeting: ` + err.message);
    renderCalendarGrid();
  }
}

function openEventModal(eventId){
  const ev = state.calendarEvents.find(x => x.id === eventId);
  if (!ev) return;
  const start = new Date(ev.start.dateTime);
  const end = new Date(ev.end?.dateTime || start);
  const pad = (n) => String(n).padStart(2, "0");
  $("#event-form-id").value = eventId;
  $("#event-title").value = ev.summary || "";
  $("#event-date").value = `${start.getFullYear()}-${pad(start.getMonth()+1)}-${pad(start.getDate())}`;
  $("#event-start").value = `${pad(start.getHours())}:${pad(start.getMinutes())}`;
  $("#event-end").value = `${pad(end.getHours())}:${pad(end.getMinutes())}`;
  openModal("event-modal");
}

/* ───────── Meeting qualification popup ───────── */
let reviewQueue = [];
async function checkPendingMeetingReviews(){
  if (!IS_CONFIGURED || !state.user) return;
  const { data } = await supabase
    .from("meeting_reviews")
    .select("*")
    .eq("user_id", state.user.id)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  reviewQueue = data || [];
  showNextReview();
}
function showNextReview(){
  if (!reviewQueue.length) { closeModal("qualify-modal"); return; }
  const review = reviewQueue[0];
  $("#qualify-title").textContent = review.meeting_title || "Untitled meeting";
  $("#qualify-attendees").textContent = (review.attendees || []).join(", ") || "—";
  openModal("qualify-modal");
}
async function resolveMeetingReview(answer){
  // answer is "qualified", "internal", or "not_qualified"
  const review = reviewQueue[0];
  if (!review) return;

  if (answer === "internal"){
    if (IS_CONFIGURED){
      await supabase.from("meeting_reviews").update({ status: "internal" }).eq("id", review.id);
    }
    reviewQueue.shift();
    showNextReview();
    return;
  }

  const attendee = (review.attendees || [])[0] || "Unknown";
  const dealRow = {
    title: `${review.meeting_title || "Meeting"} — ${attendee}`,
    value: 1500,
    stage: answer,
    contact_id: null,
    contact_name: attendee,
    notes: `MRR deal auto-created from a calendar meeting (${attendee}).`,
    updated_at: new Date().toISOString(),
  };
  const deal = await DataLayer.insert("deals", dealRow);
  if (IS_CONFIGURED){
    await supabase.from("meeting_reviews").update({
      status: answer,
      deal_id: deal ? deal.id : null,
    }).eq("id", review.id);
  }
  reviewQueue.shift();
  if (IS_CONFIGURED) { await DataLayer.fetchAll(); renderAll(); }
  showNextReview();
}
function fillContactDropdowns(){
  const opts = `<option value="">— No contact —</option>` + state.contacts.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  ["deal-contact-select","note-contact-select"].forEach(id => {
    const el = $("#"+id);
    if (el) el.innerHTML = opts;
  });
}

const ICONS = {
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  calendarCheck: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4"/></svg>`,
};

/* ───────── Modals ───────── */
function openModal(id){ $("#"+id).classList.add("visible"); }
function closeModal(id){ $("#"+id).classList.remove("visible"); }
function setupModals(){
  $$("[data-close]").forEach(btn => btn.addEventListener("click", () => closeModal(btn.dataset.close)));
  $$(".overlay").forEach(ov => {
    if (ov.id === "qualify-modal") return; // requires an explicit Yes/No answer
    ov.addEventListener("click", (e) => { if (e.target === ov) ov.classList.remove("visible"); });
  });

  $("#add-contact-btn").addEventListener("click", () => { $("#contact-form").reset(); $("#contact-form-id").value=""; $("#contact-modal-title").textContent="Add Contact"; openModal("contact-modal"); });
  $("#contact-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#contact-form-id").value;
    const row = {
      name: $("#contact-name").value.trim(),
      company: $("#contact-company").value.trim(),
      email: $("#contact-email").value.trim(),
      phone: $("#contact-phone").value.trim(),
      status: $("#contact-status").value,
      tags: $("#contact-tags").value.trim(),
    };
    if (!row.name) return;
    if (id) await DataLayer.update("contacts", id, row);
    else await DataLayer.insert("contacts", row);
    closeModal("contact-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-deal-btn").addEventListener("click", () => { $("#deal-form").reset(); openModal("deal-modal"); });
  $("#deal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const contactId = $("#deal-contact-select").value || null;
    const row = {
      title: $("#deal-title").value.trim(),
      value: Number($("#deal-value").value || 0),
      stage: $("#deal-stage").value,
      contact_id: contactId,
      contact_name: contactId ? contactName(contactId) : "",
      notes: "",
      updated_at: new Date().toISOString(),
    };
    if (!row.title) return;
    await DataLayer.insert("deals", row);
    closeModal("deal-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-region-btn")?.addEventListener("click", () => { $("#region-form").reset(); $("#region-form-id").value=""; $("#region-modal-title").textContent="Add Region"; openModal("region-modal"); });
  $("#region-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#region-form-id").value;
    const row = {
      region: $("#region-name").value.trim(),
      calls_made: Number($("#region-calls").value || 0),
      meetings_booked: Number($("#region-meetings").value || 0),
      notes: $("#region-notes").value.trim(),
      updated_at: new Date().toISOString(),
    };
    if (!row.region) return;
    if (id) await DataLayer.update("prospecting_regions", id, row);
    else await DataLayer.insert("prospecting_regions", row);
    closeModal("region-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#event-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const eventId = $("#event-form-id").value;
    const dateStr = $("#event-date").value;
    const startStr = $("#event-start").value;
    const endStr = $("#event-end").value;
    if (!dateStr || !startStr || !endStr) return;
    const newStart = new Date(`${dateStr}T${startStr}:00`);
    const newEnd = new Date(`${dateStr}T${endStr}:00`);
    if (newEnd <= newStart){ alert("End time must be after the start time."); return; }
    closeModal("event-modal");
    await applyCalendarEventPatch(eventId, {
      summary: $("#event-title").value.trim(),
      start: { dateTime: newStart.toISOString() },
      end: { dateTime: newEnd.toISOString() },
    }, "save");
  });

  $("#add-note-btn").addEventListener("click", () => { $("#note-form").reset(); openModal("note-modal"); });
  $("#note-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const row = {
      title: $("#note-title").value.trim(),
      body: $("#note-body").value.trim(),
      contact_id: $("#note-contact-select").value || null,
      deal_id: null,
    };
    if (!row.body) return;
    await DataLayer.insert("notes", row);
    closeModal("note-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  document.body.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { action, id } = btn.dataset;
    if (action === "delete-contact" && confirm("Delete this contact?")) await DataLayer.remove("contacts", id);
    if (action === "delete-deal" && confirm("Delete this deal?")) await DataLayer.remove("deals", id);
    if (action === "delete-note" && confirm("Delete this note?")) await DataLayer.remove("notes", id);
    if (action === "delete-region" && confirm("Delete this region?")) await DataLayer.remove("prospecting_regions", id);
    if (action === "edit-region"){
      const r = state.regions.find(x => x.id === id);
      if (!r) return;
      $("#region-form-id").value = r.id;
      $("#region-name").value = r.region||"";
      $("#region-calls").value = r.calls_made||0;
      $("#region-meetings").value = r.meetings_booked||0;
      $("#region-notes").value = r.notes||"";
      $("#region-modal-title").textContent = "Edit Region";
      openModal("region-modal");
    }
    if (action === "edit-contact"){
      const c = state.contacts.find(x => x.id === id);
      if (!c) return;
      $("#contact-form-id").value = c.id;
      $("#contact-name").value = c.name||"";
      $("#contact-company").value = c.company||"";
      $("#contact-email").value = c.email||"";
      $("#contact-phone").value = c.phone||"";
      $("#contact-status").value = c.status||"lead";
      $("#contact-tags").value = c.tags||"";
      $("#contact-modal-title").textContent = "Edit Contact";
      openModal("contact-modal");
    }
    if (!IS_CONFIGURED) renderAll();
  });
}

function setupSearchFilters(){
  $("#contact-search").addEventListener("input", (e) => { state.contactSearch = e.target.value; renderContacts(); });
  $("#contact-status-filter").addEventListener("change", (e) => { state.contactFilter = e.target.value; renderContacts(); });
}

function setupQualifyModal(){
  $("#qualify-yes")?.addEventListener("click", () => resolveMeetingReview("qualified"));
  $("#qualify-internal")?.addEventListener("click", () => resolveMeetingReview("internal"));
  $("#qualify-no")?.addEventListener("click", () => resolveMeetingReview("not_qualified"));
}

document.addEventListener("DOMContentLoaded", () => {
  setupGoogleAuth();
  setupEmailAuth();
  setupNav();
  setupModals();
  setupSearchFilters();
  setupTeam();
  setupQualifyModal();
  setupCalendarNav();
  initAuth();
});
})();
