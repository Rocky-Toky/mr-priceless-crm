/* Mr Priceless CRM - app logic (vanilla JS, no build step) */
(function(){
"use strict";

const { supabase, IS_CONFIGURED } = window.CRM_DB;

// Only these tables actually have a created_by column (see sql/schema.sql) -
// every table added since (dial_prospects, clients, client_content,
// client_ad_creatives, client_campaigns, deal_contacts, prospecting_regions)
// does not, and Supabase rejects inserts with an unknown column.
const TABLES_WITH_CREATED_BY = new Set(["contacts", "cold_calls", "deals"]);
// These tables are per-login (see sql/013_per_login_scoping.sql) - every new
// row is stamped with whoever created it so RLS can scope it to just them.
const TABLES_WITH_USER_ID = new Set(["dial_prospects", "tasks"]);

const STAGES = [
  { key: "not_qualified", label: "Not Qualified" },
  { key: "qualified", label: "Qualified" },
  { key: "proposal", label: "Proposal Meeting" },
  { key: "negotiation", label: "Negotiation" },
];
const CONTENT_STATUSES = [
  { key: "idea", label: "Idea" },
  { key: "scripting", label: "Scripting" },
  { key: "filming", label: "Filming / Editing" },
  { key: "posted", label: "Posted" },
];
const CONTENT_TYPES = {
  video: { label: "Video", cls: "gold" },
  script: { label: "Script", cls: "gray" },
  post: { label: "Post", cls: "green" },
  other: { label: "Other", cls: "gray" },
};
const AD_RESULTS = {
  testing: { label: "Testing", cls: "gray" },
  winner: { label: "Winner", cls: "green" },
  killed: { label: "Killed", cls: "red" },
};
const CAMPAIGN_STATUSES = {
  active: { label: "Active", cls: "green" },
  paused: { label: "Paused", cls: "gray" },
  ended: { label: "Ended", cls: "red" },
};
const TASK_PRIORITIES = {
  low: { label: "Low", cls: "gray", rank: 0 },
  medium: { label: "Medium", cls: "gold", rank: 1 },
  high: { label: "High", cls: "red", rank: 2 },
  urgent: { label: "Urgent", cls: "black", rank: 3 },
};
const TASK_CHECK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>`;
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
  regions: [],
  prospects: [],
  clients: [],
  clientContent: [],
  adCreatives: [],
  campaigns: [],
  dealContacts: [],
  tasks: [],
  clientReports: [],
  notes: [],
  selectedClientId: null,
  selectedDealId: null,
  dialerFilter: { search: "", region: "", industry: "" },
  taskFilter: { status: "open", priority: "", sort: "due_date" },
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
const fmtDate = (d) => d ? new Date(d).toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"}) : "-";
const timeAgo = (iso) => {
  const s = Math.floor((Date.now() - new Date(iso).getTime())/1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s/60)+"m ago";
  if (s < 86400) return Math.floor(s/3600)+"h ago";
  return Math.floor(s/86400)+"d ago";
};
const uid = () => "id-" + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
// Twilio needs E.164 (+<country code><number>). Prospect numbers are usually entered in
// local NZ format (e.g. "021 555 0111"), so assume NZ (+64) unless a "+" is already present.
const toE164 = (phone, defaultCountryCode = "64") => {
  const raw = String(phone||"").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return "+" + raw.replace(/[^0-9]/g, "");
  const national = raw.replace(/[^0-9]/g, "").replace(/^0+/, "");
  return national ? "+" + defaultCountryCode + national : "";
};

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
    { id:uid(), contact_id:null, contact_name:"Marlon Reeve - Reeve Builders", phone:"021 555 0111", call_date:new Date().toISOString().slice(0,10), outcome:"no_answer", follow_up_date:new Date(Date.now()+86400e3*1).toISOString().slice(0,10), notes:"Left voicemail.", created_at:new Date(Date.now()-3600e3*2).toISOString() },
  ];
  const deal1 = uid();
  state.deals = [
    { id:deal1, contact_id:c1, contact_name:"Aroha Ngata", title:"Kauri - Full funnel rebuild", value:8500, stage:"negotiation", notes:"", created_at:new Date(Date.now()-86400e3*14).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), contact_id:c2, contact_name:"Ben Whitfield", title:"Summit Dental - Meta Ads retainer", value:2200, stage:"qualified", notes:"", created_at:new Date(Date.now()-86400e3*20).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), contact_id:c3, contact_name:"Priya Chand", title:"Chand Legal - SEO + Ads", value:3600, stage:"proposal", notes:"", created_at:new Date(Date.now()-86400e3*1).toISOString(), updated_at:new Date().toISOString() },
  ];
  state.calendarEvents = [
    { id:"demo-1", summary:"Discovery call - Reeve Builders", start:{ dateTime:new Date(Date.now()+3600e3*3).toISOString() }, end:{ dateTime:new Date(Date.now()+3600e3*3.5).toISOString() }, attendees:[{ email:"marlon@reevebuilders.co.nz" }] },
    { id:"demo-2", summary:"Internal pipeline review", start:{ dateTime:new Date(Date.now()+86400e3*1).toISOString() }, end:{ dateTime:new Date(Date.now()+86400e3*1+3600e3).toISOString() }, attendees:[{ email:"rockyoneill02@gmail.com" }] },
  ];
  state.regions = [
    { id:uid(), region:"Auckland CBD", calls_made:64, meetings_booked:6, notes:"Worked through the Queen St + Britomart lists.", created_at:new Date(Date.now()-86400e3*12).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), region:"North Shore", calls_made:38, meetings_booked:2, notes:"Started this week, more to go.", created_at:new Date(Date.now()-86400e3*3).toISOString(), updated_at:new Date().toISOString() },
  ];
  state.prospects = [
    { id:uid(), name:"Marlon Reeve", phone:"021 555 0111", company:"Reeve Builders", email:"marlon@reevebuilders.co.nz", calls_made:1, last_called_at:new Date(Date.now()-3600e3*2).toISOString(), last_outcome:"no_answer", notes:"", created_at:new Date(Date.now()-86400e3*3).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), name:"Sina Tuilagi", phone:"022 555 0133", company:"Tuilagi Landscaping", email:"", calls_made:0, last_called_at:null, last_outcome:null, notes:"", created_at:new Date(Date.now()-86400e3*1).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), name:"Grace Nguyen", phone:"027 555 0166", company:"Nguyen Dental Studio", email:"grace@nguyendental.co.nz", calls_made:0, last_called_at:null, last_outcome:null, notes:"", created_at:new Date(Date.now()-86400e3*1).toISOString(), updated_at:new Date().toISOString() },
  ];
  const cl1 = uid(), cl2 = uid();
  state.clients = [
    { id:cl1, name:"Kauri Property Group", notes:"Real estate. Wants weekly listing videos.", cost_per_lead:38, meta_ad_account_id:"act_1234567890", report_email:"aroha@kauriproperty.co.nz", report_frequency:"monthly", last_report_sent_at:new Date(Date.now()-86400e3*32).toISOString(), created_at:new Date(Date.now()-86400e3*60).toISOString(), updated_at:new Date().toISOString() },
    { id:cl2, name:"Summit Dental", notes:"Healthcare. Focused on Meta lead ads.", cost_per_lead:22, meta_ad_account_id:"", report_email:"", report_frequency:"monthly", last_report_sent_at:null, created_at:new Date(Date.now()-86400e3*40).toISOString(), updated_at:new Date().toISOString() },
  ];
  state.clientContent = [
    { id:uid(), client_id:cl1, type:"video", status:"idea", title:"Listing walkthrough - 14 Marama Rd", directions:"Golden hour, drone opening shot, 45-60s.", script:"", notes:"", created_at:new Date(Date.now()-86400e3*2).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl1, type:"script", status:"scripting", title:"\"5 signs it's time to sell\" talking-head", directions:"", script:"Hook: Most people wait too long to sell. Here's how to know...", notes:"", created_at:new Date(Date.now()-86400e3*5).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl1, type:"video", status:"posted", title:"Open home recap - Britomart apartment", directions:"", script:"", notes:"Posted to IG + FB, did well.", created_at:new Date(Date.now()-86400e3*12).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl2, type:"video", status:"filming", title:"Patient testimonial - Whitening results", directions:"Shoot in the new chair, natural light near window.", script:"", notes:"", created_at:new Date(Date.now()-86400e3*3).toISOString(), updated_at:new Date().toISOString() },
  ];
  state.adCreatives = [
    { id:uid(), client_id:cl1, name:"Drone listing reel v1", result:"winner", notes:"Lowest CPL so far, keep scaling.", created_at:new Date(Date.now()-86400e3*20).toISOString() },
    { id:uid(), client_id:cl1, name:"Static \"just sold\" carousel", result:"killed", notes:"CTR too low, paused after 3 days.", created_at:new Date(Date.now()-86400e3*15).toISOString() },
    { id:uid(), client_id:cl2, name:"Before/after smile carousel", result:"testing", notes:"", created_at:new Date(Date.now()-86400e3*2).toISOString() },
  ];
  state.campaigns = [
    { id:uid(), client_id:cl1, name:"Auckland listings - lead gen", platform:"Meta", status:"active", cost_per_lead:35, notes:"", created_at:new Date(Date.now()-86400e3*18).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl1, name:"Retargeting - open home visitors", platform:"Meta", status:"active", cost_per_lead:22, notes:"", created_at:new Date(Date.now()-86400e3*9).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl1, name:"Google Search - suburb keywords", platform:"Google", status:"paused", cost_per_lead:58, notes:"Paused, CPL too high vs Meta.", created_at:new Date(Date.now()-86400e3*30).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl2, name:"Whitening promo - lead gen", platform:"Meta", status:"active", cost_per_lead:19, notes:"", created_at:new Date(Date.now()-86400e3*6).toISOString(), updated_at:new Date().toISOString() },
  ];
  state.dealContacts = [];
  state.tasks = [
    { id:uid(), title:"Send Kauri contract for signature", notes:"", due_date:new Date(Date.now()+86400e3*1).toISOString().slice(0,10), priority:"high", status:"open", contact_id:c1, deal_id:deal1, created_at:new Date(Date.now()-86400e3*2).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), title:"Follow up with Priya Chand re: proposal", notes:"She wanted pricing broken out by service.", due_date:new Date(Date.now()-86400e3*1).toISOString().slice(0,10), priority:"urgent", status:"open", contact_id:c3, deal_id:null, created_at:new Date(Date.now()-86400e3*3).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), title:"Prep Summit Dental ad creative review", notes:"", due_date:new Date(Date.now()+86400e3*5).toISOString().slice(0,10), priority:"medium", status:"open", contact_id:c2, deal_id:null, created_at:new Date(Date.now()-86400e3*1).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), title:"Renew domain for agency site", notes:"", due_date:null, priority:"low", status:"open", contact_id:null, deal_id:null, created_at:new Date(Date.now()-86400e3*6).toISOString(), updated_at:new Date().toISOString() },
  ];
  state.clientReports = [
    { id:uid(), client_id:cl1, period_start:new Date(Date.now()-86400e3*62).toISOString().slice(0,10), period_end:new Date(Date.now()-86400e3*32).toISOString().slice(0,10),
      metrics:{ spend:"842.50", impressions:"48210", reach:"21340", clicks:"612", ctr:"1.27", cpc:"1.38", cpm:"17.47", actions:[{action_type:"lead",value:"19"}], cost_per_action_type:[{action_type:"lead",value:"44.34"}] },
      status:"sent", error:null, created_at:new Date(Date.now()-86400e3*32).toISOString() },
  ];
}

/* ───────── Data layer ───────── */
const DataLayer = {
  async fetchAll(){
    if (!IS_CONFIGURED){ return; }
    const [c, cc, d, r, p, cl, ccon, cad, camp, dc, tk, crep, nt] = await Promise.all([
      supabase.from("contacts").select("*").order("created_at",{ascending:false}),
      supabase.from("cold_calls").select("*").order("created_at",{ascending:false}),
      supabase.from("deals").select("*").order("created_at",{ascending:false}),
      supabase.from("prospecting_regions").select("*").order("region",{ascending:true}),
      supabase.from("dial_prospects").select("*").order("last_called_at",{ascending:true,nullsFirst:true}),
      supabase.from("clients").select("*").order("name",{ascending:true}),
      supabase.from("client_content").select("*").order("created_at",{ascending:false}),
      supabase.from("client_ad_creatives").select("*").order("created_at",{ascending:false}),
      supabase.from("client_campaigns").select("*").order("created_at",{ascending:false}),
      supabase.from("deal_contacts").select("*").order("created_at",{ascending:false}),
      supabase.from("tasks").select("*").order("created_at",{ascending:false}),
      supabase.from("client_reports").select("*").order("created_at",{ascending:false}),
      supabase.from("notes").select("*").order("created_at",{ascending:false}),
    ]);
    state.contacts = c.data || [];
    state.coldCalls = cc.data || [];
    state.deals = d.data || [];
    state.regions = r.data || [];
    state.prospects = p.data || [];
    state.clients = cl.data || [];
    state.clientContent = ccon.data || [];
    state.adCreatives = cad.data || [];
    state.campaigns = camp.data || [];
    state.dealContacts = dc.data || [];
    state.tasks = tk.data || [];
    state.clientReports = crep.data || [];
    state.notes = nt.data || [];
  },
  async insert(table, row){
    if (TABLES_WITH_CREATED_BY.has(table)) row.created_by = state.user ? state.user.email : "demo";
    if (TABLES_WITH_USER_ID.has(table)) row.user_id = state.user ? state.user.id : null;
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
      if (table === "clients"){
        state.clientContent = state.clientContent.filter(x => x.client_id !== id);
        state.adCreatives = state.adCreatives.filter(x => x.client_id !== id);
        state.campaigns = state.campaigns.filter(x => x.client_id !== id);
      }
      if (table === "deals"){
        state.dealContacts = state.dealContacts.filter(x => x.deal_id !== id);
      }
      renderAll();
      return;
    }
    const { error } = await supabase.from(table).delete().eq("id", id);
    if (error){ alert(error.message); return; }
  }
};
function stateArray(table){
  return {
    contacts: state.contacts, cold_calls: state.coldCalls, deals: state.deals,
    prospecting_regions: state.regions, dial_prospects: state.prospects,
    clients: state.clients, client_content: state.clientContent, client_ad_creatives: state.adCreatives,
    client_campaigns: state.campaigns, deal_contacts: state.dealContacts, tasks: state.tasks,
    client_reports: state.clientReports, notes: state.notes,
  }[table];
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
    .on("postgres_changes", { event:"*", schema:"public", table:"prospecting_regions" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"dial_prospects" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"clients" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"client_content" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"client_ad_creatives" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"client_campaigns" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"deal_contacts" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"tasks" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"client_reports" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"notes" }, async () => { await DataLayer.fetchAll(); renderAll(); })
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
    reviewQueue = [{ id:"demo-review-1", meeting_title:"Discovery call - Reeve Builders", attendees:["marlon@reevebuilders.co.nz"] }];
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
    console.warn("Google sign-in didn't return a refresh token - use the Calendar page's Connect button to retry.");
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

/* ───────── Auth (email/password - quick-start alternative to Google) ───────── */
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
  $$(".nav-item[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.page = btn.dataset.page;
      $$(".nav-item[data-page]").forEach(b => b.classList.toggle("active", b === btn));
      $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + state.page));
      $("#nav-more-dropdown")?.classList.remove("open");
    });
  });
  $("#nav-more-toggle")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const toggle = e.currentTarget;
    const dropdown = $("#nav-more-dropdown");
    if (!dropdown) return;
    const wasOpen = dropdown.classList.contains("open");
    dropdown.classList.toggle("open", !wasOpen);
    if (wasOpen) return;
    const r = toggle.getBoundingClientRect();
    const isNarrow = window.innerWidth <= 820;
    let top = isNarrow ? r.bottom + 8 : r.top;
    let left = isNarrow ? r.left : r.right + 8;
    const dw = dropdown.offsetWidth, dh = dropdown.offsetHeight;
    if (left + dw > window.innerWidth - 8) left = window.innerWidth - dw - 8;
    if (top + dh > window.innerHeight - 8) top = window.innerHeight - dh - 8;
    dropdown.style.left = left + "px";
    dropdown.style.top = top + "px";
  });
  document.addEventListener("click", (e) => {
    const group = $("#nav-more-toggle")?.closest(".nav-group");
    if (group && !group.contains(e.target)) $("#nav-more-dropdown")?.classList.remove("open");
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
    ...state.coldCalls.map(c => ({ t:c.created_at, text:`Cold call logged with <b>${escapeHtml(c.contact_name)}</b> - ${OUTCOMES[c.outcome]?.label||c.outcome}` })),
    ...state.deals.map(d => ({ t:d.created_at, text:`Deal created - <b>${escapeHtml(d.title)}</b> (${fmtMoney(d.value)})` })),
  ].sort((a,b) => new Date(b.t) - new Date(a.t)).slice(0,8);

  $("#activity-list").innerHTML = events.length ? events.map(e => `
    <div class="activity-row">
      <div class="activity-dot"></div>
      <div>
        <div class="activity-text">${e.text}</div>
        <div class="activity-time">${timeAgo(e.t)}</div>
      </div>
    </div>
  `).join("") : emptyState("No activity yet - log a cold call or add a deal to get started.");

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
      <td>${escapeHtml(c.company||"-")}</td>
      <td>${escapeHtml(c.email||"-")}</td>
      <td>${escapeHtml(c.phone||"-")}</td>
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
  const listView = $("#deals-list-view");
  const detailView = $("#deal-detail-view");
  if (!listView || !detailView) return;

  const selected = state.deals.find(d => d.id === state.selectedDealId);
  if (!selected){
    state.selectedDealId = null;
    listView.style.display = "";
    detailView.style.display = "none";
    renderDealsList();
  } else {
    listView.style.display = "none";
    detailView.style.display = "";
    renderDealDetail(selected);
  }
}
function renderDealsList(){
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
        ${deals.map(d => {
          const extraContacts = dealContactsFor(d.id);
          return `
          <div class="deal-card" draggable="true" data-id="${d.id}" data-action="view-deal">
            <h5>${escapeHtml(d.title)}</h5>
            <div class="deal-contact">${escapeHtml(d.contact_name||"No contact")}</div>
            ${extraContacts.length ? `<div class="deal-extra-contacts">${extraContacts.map(dc => `${escapeHtml(dc.role||"Contact")}: ${escapeHtml(dc.name)}`).join(", ")}</div>` : ""}
            <div class="deal-card-foot">
              <span class="deal-value">${fmtMoney(d.value)}</span>
              <button class="icon-btn" data-action="delete-deal" data-id="${d.id}" title="Delete">${ICONS.trash}</button>
            </div>
          </div>
        `;}).join("")}
      </div>
    `;
  }).join("");
  setupDragDrop();
}
function dealActivityFor(dealId){
  return state.notes.filter(n => n.deal_id === dealId && n.title === "Called").sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
}
function dealNotesFor(dealId){
  return state.notes.filter(n => n.deal_id === dealId && n.title === "Note").sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
}
function renderDealDetail(deal){
  $("#deal-detail-title").textContent = deal.title;
  $("#deal-detail-value").textContent = fmtMoney(deal.value);
  $("#deal-detail-delete").dataset.id = deal.id;

  const contactsBody = $("#deal-detail-contacts");
  const extraContacts = dealContactsFor(deal.id);
  const primary = deal.contact_id ? state.contacts.find(c => c.id === deal.contact_id) : null;
  const rows = [];
  if (primary) rows.push({ name: primary.name, phone: primary.phone, role: "Primary" });
  else if (deal.contact_name) rows.push({ name: deal.contact_name, phone: "", role: "Primary" });
  extraContacts.forEach(dc => rows.push({ name: dc.name, phone: dc.phone, role: dc.role || "Contact" }));
  contactsBody.innerHTML = rows.length
    ? rows.map(r => `<div style="margin-bottom:8px;"><b>${escapeHtml(r.name)}</b> ${r.phone ? "· " + escapeHtml(r.phone) : ""} <span class="badge gray" style="margin-left:6px;">${escapeHtml(r.role)}</span></div>`).join("")
    : `<span style="color:var(--text2);">No contact linked to this deal.</span>`;

  const linkedIds = new Set(extraContacts.map(dc => dc.contact_id).filter(Boolean));
  if (deal.contact_id) linkedIds.add(deal.contact_id);
  const pickable = state.contacts.filter(c => !linkedIds.has(c.id));
  const select = $("#deal-detail-contact-select");
  if (select){
    select.innerHTML = pickable.length
      ? pickable.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")
      : `<option value="">No other contacts to add</option>`;
    select.disabled = !pickable.length;
  }

  const notes = dealNotesFor(deal.id);
  const legacyNote = deal.notes ? [{ body: deal.notes, created_at: deal.updated_at || deal.created_at }] : [];
  const allNotes = [...notes, ...legacyNote];
  const notesList = $("#deal-detail-notes-list");
  notesList.innerHTML = allNotes.length
    ? allNotes.map(n => `<div style="padding:8px 0;border-bottom:1px solid var(--line);"><div style="font-size:13.5px;">${escapeHtml(n.body)}</div><div style="color:var(--text2);font-size:11.5px;margin-top:2px;">${fmtDate(n.created_at)}</div></div>`).join("")
    : `<span style="color:var(--text2);">No notes yet.</span>`;

  const activity = dealActivityFor(deal.id);
  const activityBody = $("#deal-detail-activity");
  activityBody.innerHTML = activity.length
    ? activity.map(a => `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line);"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" width="16" height="16" style="color:var(--gold);flex-shrink:0;"><path d="M20 6L9 17l-5-5"/></svg><span>${escapeHtml(a.body)}</span><span style="margin-left:auto;color:var(--text2);font-size:12px;">${fmtDate(a.created_at)}</span></div>`).join("")
    : `<span style="color:var(--text2);">No calls logged yet.</span>`;
}
async function markDealCalled(dealId){
  await DataLayer.insert("notes", {
    deal_id: dealId,
    title: "Called",
    body: `Called on ${fmtDate(new Date())}`,
  });
  if (!IS_CONFIGURED) return;
  await DataLayer.fetchAll(); renderAll();
}
async function addExistingContactToDeal(dealId){
  const select = $("#deal-detail-contact-select");
  const contactId = select?.value;
  if (!contactId) return;
  await DataLayer.insert("deal_contacts", { deal_id: dealId, contact_id: contactId, role: "Contact" });
  if (!IS_CONFIGURED) return;
  await DataLayer.fetchAll(); renderAll();
}
async function addDealNote(dealId){
  const btn = $("#deal-detail-save-notes");
  const textarea = $("#deal-detail-notes");
  const body = textarea.value.trim();
  if (!body) return;
  if (btn){ btn.disabled = true; btn.textContent = "Saving..."; }
  const saved = await DataLayer.insert("notes", { deal_id: dealId, title: "Note", body });
  if (btn){
    btn.disabled = false;
    btn.textContent = saved ? "Saved" : "Save Note";
    if (saved) setTimeout(() => { if ($("#deal-detail-save-notes")) $("#deal-detail-save-notes").textContent = "Save Note"; }, 1500);
  }
  if (saved) textarea.value = "";
  if (!saved || !IS_CONFIGURED) return;
  await DataLayer.fetchAll(); renderAll();
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

function contactName(id){ return state.contacts.find(c => c.id === id)?.name || ""; }
function dealContactsFor(dealId){
  return state.dealContacts.filter(dc => dc.deal_id === dealId).map(dc => ({
    ...dc, name: contactName(dc.contact_id) || "(deleted contact)",
  }));
}
function addDealContactRow(){
  const rows = $("#deal-contacts-rows");
  if (!rows) return;
  const row = document.createElement("div");
  row.className = "deal-contact-row";
  row.innerHTML = `
    <input type="text" class="dc-name" placeholder="Name">
    <input type="tel" class="dc-phone" placeholder="Phone">
    <input type="text" class="dc-role" placeholder="Role (e.g. Decision Maker)">
    <button type="button" class="icon-btn dc-remove" title="Remove">${ICONS.trash}</button>
  `;
  rows.appendChild(row);
}
async function saveDealContactRows(dealId){
  const rows = $$(".deal-contact-row", $("#deal-contacts-rows"));
  for (const row of rows){
    const name = row.querySelector(".dc-name").value.trim();
    const phone = row.querySelector(".dc-phone").value.trim();
    const role = row.querySelector(".dc-role").value.trim();
    if (!name) continue;
    const contact = await DataLayer.insert("contacts", { name, phone, company: "", email: "", status: "lead", tags: "" });
    if (!contact) continue;
    await DataLayer.insert("deal_contacts", { deal_id: dealId, contact_id: contact.id, role });
  }
}

/* ───────── Render: Dialer (power dialing prospect list) ───────── */
const OUTCOME_BUTTONS = [
  { key:"no_answer", label:"No Answer", cls:"ghost" },
  { key:"call_back", label:"Call Back", cls:"ghost" },
  { key:"not_interested", label:"Not Interested", cls:"ghost" },
  { key:"interested", label:"Interested", cls:"gold" },
  { key:"booked_meeting", label:"Booked Meeting", cls:"gold" },
];
function dialerFilteredProspects(){
  const f = state.dialerFilter;
  const q = f.search.trim().toLowerCase();
  return state.prospects.filter(p => {
    if (f.region && (p.region||"") !== f.region) return false;
    if (f.industry && (p.industry||"") !== f.industry) return false;
    if (q && ![p.name,p.company,p.notes].some(v => (v||"").toLowerCase().includes(q))) return false;
    return true;
  });
}
function dialerDistinctValues(field){
  return [...new Set(state.prospects.map(p => p[field]).filter(Boolean))].sort();
}
function dialerQueue(){
  return dialerFilteredProspects().sort((a,b) => {
    const ta = a.last_called_at ? new Date(a.last_called_at).getTime() : -Infinity;
    const tb = b.last_called_at ? new Date(b.last_called_at).getTime() : -Infinity;
    return ta - tb;
  });
}
function renderDialerFilters(){
  const regionSel = $("#dialer-filter-region");
  const industrySel = $("#dialer-filter-industry");
  if (regionSel){
    const regions = dialerDistinctValues("region");
    regionSel.innerHTML = `<option value="">All Regions</option>` + regions.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("");
    regionSel.value = state.dialerFilter.region;
  }
  if (industrySel){
    const industries = dialerDistinctValues("industry");
    industrySel.innerHTML = `<option value="">All Industries</option>` + industries.map(i => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join("");
    industrySel.value = state.dialerFilter.industry;
  }
}
function renderDialer(){
  renderDialerFilters();
  const filtered = dialerFilteredProspects();
  const total = filtered.length;
  const totalCalls = filtered.reduce((s,p) => s + Number(p.calls_made||0), 0);
  const neverCalled = filtered.filter(p => !p.calls_made).length;
  const todayStr = new Date().toDateString();
  const dialedToday = filtered.filter(p => p.last_called_at && new Date(p.last_called_at).toDateString() === todayStr).length;
  const st = (id,v) => { const el = $(id); if (el) el.textContent = v; };
  st("#dialer-stat-total", total);
  st("#dialer-stat-today", dialedToday);
  st("#dialer-stat-calls", totalCalls);
  st("#dialer-stat-fresh", neverCalled);

  const queue = dialerQueue();
  const posEl = $("#dialer-position");
  if (posEl) posEl.textContent = total ? `1 / ${total}` : "0 / 0";

  const body = $("#dialer-current-body");
  if (body){
    if (!queue.length){
      body.innerHTML = emptyState("Import a CSV/XLS file or add a prospect to start power dialing.");
    } else {
      const p = queue[0];
      body.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;">
          <div>
            <h3 style="font-size:22px;margin-bottom:4px;">${escapeHtml(p.name)}</h3>
            <div style="color:var(--text2);font-size:13.5px;">${escapeHtml(p.company||"No company")}</div>
            <div style="color:var(--text2);font-size:12.5px;margin-top:4px;">${escapeHtml(p.email||"")}</div>
          </div>
          <div style="text-align:right;">
            <div class="badge gray">Calls made: ${Number(p.calls_made||0)}</div>
            <div style="font-size:11.5px;color:var(--text2);margin-top:6px;">${p.last_called_at ? "Last called " + timeAgo(p.last_called_at) : "Never called"}</div>
          </div>
        </div>
        ${IS_CONFIGURED
          ? `<button type="button" class="btn gold" style="width:100%;justify-content:center;margin-top:18px;font-size:17px;padding:14px;" data-action="start-call" data-id="${p.id}" ${p.phone ? "" : "disabled"}>${p.phone ? "Call " + escapeHtml(p.phone) : "No phone number"}</button>`
          : `<a href="tel:${escapeHtml((p.phone||"").replace(/[^0-9+]/g,""))}" class="btn gold" style="width:100%;justify-content:center;margin-top:18px;font-size:17px;padding:14px;" data-action="dial-tel" data-id="${p.id}">${p.phone ? "Call " + escapeHtml(p.phone) : "No phone number"}</a>`}
        ${p.notes ? `<div class="card" style="margin-top:14px;padding:12px 14px;background:#faf9f5;box-shadow:none;"><div style="font-size:11px;color:var(--text2);text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px;">Notes</div><div style="font-size:13px;">${escapeHtml(p.notes)}</div></div>` : ""}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:16px;">
          ${OUTCOME_BUTTONS.map(o => `<button class="btn ${o.cls}" data-action="dial-outcome" data-outcome="${o.key}" data-id="${p.id}">${o.label}</button>`).join("")}
        </div>
      `;
    }
  }

  const tbody = $("#dialer-queue-tbody");
  if (tbody){
    if (!queue.length){
      tbody.innerHTML = `<tr><td colspan="5">${emptyState("No prospects yet.")}</td></tr>`;
    } else {
      tbody.innerHTML = queue.map((p,i) => `
        <tr data-id="${p.id}" style="${i===0?"background:var(--gold-soft);":""}">
          <td><div class="row-name">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.company||"")}</div></td>
          <td>${escapeHtml(p.phone||"-")}</td>
          <td>${[p.region,p.industry].filter(Boolean).map(escapeHtml).join(" · ") || "-"}</td>
          <td><span class="badge gray">${Number(p.calls_made||0)}</span></td>
          <td style="text-align:right;white-space:nowrap;">
            <button class="icon-btn" data-action="edit-prospect" data-id="${p.id}" title="Edit">${ICONS.edit}</button>
            <button class="icon-btn" data-action="convert-prospect" data-id="${p.id}" title="Move to Contacts">${ICONS.moveToContact}</button>
            <button class="icon-btn" data-action="delete-prospect" data-id="${p.id}" title="Delete">${ICONS.trash}</button>
          </td>
        </tr>
      `).join("");
    }
  }
}
async function logDialOutcome(prospectId, outcome){
  const p = state.prospects.find(x => x.id === prospectId);
  if (!p) return;
  await DataLayer.update("dial_prospects", prospectId, {
    calls_made: Number(p.calls_made||0) + 1,
    last_called_at: new Date().toISOString(),
    last_outcome: outcome,
    updated_at: new Date().toISOString(),
  });
  if (!IS_CONFIGURED) return;
  await DataLayer.fetchAll(); renderAll();
}

/* ───────── Twilio Voice (real outbound calling from the Dialer) ───────── */
let voiceDevice = null;
let activeCall = null;
let activeCallProspectId = null;

async function getVoiceDevice(){
  if (voiceDevice) return voiceDevice;
  if (typeof Twilio === "undefined"){ alert("Calling isn't available: the Twilio Voice SDK failed to load."); return null; }
  const { data, error } = await supabase.functions.invoke("voice-token");
  if (error || !data?.token){ alert("Couldn't start the call: " + (error?.message || "no token returned.")); return null; }
  voiceDevice = new Twilio.Device(data.token, { codecPreferences: ["opus", "pcmu"] });
  voiceDevice.on("tokenWillExpire", async () => {
    const refreshed = await supabase.functions.invoke("voice-token");
    if (refreshed.data?.token) voiceDevice.updateToken(refreshed.data.token);
  });
  voiceDevice.on("error", (e) => { alert("Call error: " + (e?.message || "unknown error")); endCall(); });
  await voiceDevice.register();
  return voiceDevice;
}

function setCallWidget(open, { name, status } = {}){
  const widget = $("#call-widget");
  if (!widget) return;
  widget.classList.toggle("hidden", !open);
  if (name !== undefined) $("#call-widget-name").textContent = name;
  if (status !== undefined) $("#call-widget-status").textContent = status;
}

async function startCall(prospectId){
  const p = state.prospects.find(x => x.id === prospectId);
  if (!p || !p.phone) return;
  if (activeCall){ alert("You're already on a call. Hang up first."); return; }
  const device = await getVoiceDevice();
  if (!device) return;

  const digits = toE164(p.phone);
  if (!digits){ alert("This prospect doesn't have a usable phone number."); return; }
  setCallWidget(true, { name: p.name, status: "Calling…" });
  activeCallProspectId = prospectId;
  activeCall = await device.connect({ params: { To: digits } });

  activeCall.on("accept", () => setCallWidget(true, { status: "In call" }));
  activeCall.on("disconnect", () => endCall());
  activeCall.on("cancel", () => endCall());
  activeCall.on("reject", () => endCall());
  activeCall.on("error", (e) => { alert("Call error: " + (e?.message || "unknown error")); endCall(); });

  await logDialOutcome(prospectId, "dialed");
}

function endCall(){
  if (activeCall){ try { activeCall.disconnect(); } catch {} }
  activeCall = null;
  activeCallProspectId = null;
  setCallWidget(false);
  const muteBtn = $("#call-widget-mute");
  if (muteBtn) muteBtn.textContent = "Mute";
}

function setupCallWidget(){
  $("#call-widget-hangup")?.addEventListener("click", () => endCall());
  $("#call-widget-mute")?.addEventListener("click", (e) => {
    if (!activeCall) return;
    const muted = !activeCall.isMuted();
    activeCall.mute(muted);
    e.target.textContent = muted ? "Unmute" : "Mute";
  });
}

function parseCsv(text){
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i=0;i<text.length;i++){
    const c = text[i];
    if (inQuotes){
      if (c === '"'){
        if (text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ","){ row.push(field); field = ""; }
      else if (c === "\n" || c === "\r"){
        if (c === "\r" && text[i+1] === "\n") i++;
        row.push(field); rows.push(row); row = []; field = "";
      } else field += c;
    }
  }
  if (field.length || row.length){ row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ""));
}
function mapImportRows(rows){
  if (!rows.length) return [];
  const headers = rows[0].map(h => String(h||"").trim().toLowerCase());
  const findCol = (...names) => headers.findIndex(h => names.some(n => h === n || h.includes(n)));
  const nameIdx = findCol("name","full name","contact");
  const phoneIdx = findCol("phone","mobile","number","tel");
  const companyIdx = findCol("company","organisation","organization","business");
  const emailIdx = findCol("email");
  const regionIdx = findCol("region","area","suburb","location","territory");
  const industryIdx = findCol("industry","sector","niche","category","vertical");
  return rows.slice(1).map(r => ({
    name: (nameIdx>-1 ? r[nameIdx] : "") || "Unknown",
    phone: phoneIdx>-1 ? String(r[phoneIdx]||"").trim() : "",
    company: companyIdx>-1 ? String(r[companyIdx]||"").trim() : "",
    email: emailIdx>-1 ? String(r[emailIdx]||"").trim() : "",
    region: regionIdx>-1 ? String(r[regionIdx]||"").trim() : "",
    industry: industryIdx>-1 ? String(r[industryIdx]||"").trim() : "",
  })).filter(p => p.name || p.phone);
}
async function importProspectRows(prospects){
  if (!prospects.length){ alert("No rows found to import."); return; }
  for (const p of prospects){
    await DataLayer.insert("dial_prospects", {
      name: p.name, phone: p.phone, company: p.company, email: p.email,
      region: p.region||"", industry: p.industry||"",
      calls_made: 0, last_called_at: null, last_outcome: null, notes: "",
    });
  }
  if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
  alert(`Imported ${prospects.length} prospect${prospects.length===1?"":"s"}.`);
}
function setupDialerImport(){
  const input = $("#dialer-import-input");
  $("#dialer-import-btn")?.addEventListener("click", () => input.click());
  input?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const isExcel = /\.xlsx?$/i.test(file.name);
    try {
      if (isExcel){
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
        await importProspectRows(mapImportRows(rows));
      } else {
        const text = await file.text();
        await importProspectRows(mapImportRows(parseCsv(text)));
      }
    } catch (err){
      alert("Couldn't read that file: " + err.message);
    }
    input.value = "";
  });
}

/* ───────── Render: Clients (retention workspace) ───────── */
function clientAvgCPL(){
  const withCpl = state.clients.filter(c => c.cost_per_lead != null && c.cost_per_lead !== "");
  if (!withCpl.length) return null;
  return withCpl.reduce((s,c) => s + Number(c.cost_per_lead||0), 0) / withCpl.length;
}
function campaignsFor(clientId){ return state.campaigns.filter(x => x.client_id === clientId); }
function runningCampaignsFor(clientId){ return campaignsFor(clientId).filter(x => x.status === "active"); }
async function uploadAdCreativeImage(file){
  if (!file) return null;
  if (!IS_CONFIGURED) return URL.createObjectURL(file);
  const ext = (file.name.split(".").pop() || "png").toLowerCase();
  const path = `${uid()}.${ext}`;
  const { error } = await supabase.storage.from("ad-creatives").upload(path, file);
  if (error){ alert("Image upload failed: " + error.message); return null; }
  const { data } = supabase.storage.from("ad-creatives").getPublicUrl(path);
  return data.publicUrl;
}
function renderClients(){
  const listView = $("#clients-list-view");
  const detailView = $("#clients-detail-view");
  if (!listView || !detailView) return;

  const selected = state.clients.find(c => c.id === state.selectedClientId);
  if (!selected){
    state.selectedClientId = null;
    listView.style.display = "";
    detailView.style.display = "none";
    renderClientsList();
  } else {
    listView.style.display = "none";
    detailView.style.display = "";
    renderClientDetail(selected);
  }
}
function renderClientsList(){
  const avg = clientAvgCPL();
  $("#clients-stat-total").textContent = state.clients.length;
  $("#clients-stat-cpl").textContent = avg != null ? fmtMoney(avg) : "-";
  $("#clients-stat-content").textContent = state.clientContent.length;
  $("#clients-stat-campaigns").textContent = state.campaigns.filter(c => c.status === "active").length;

  const grid = $("#clients-grid");
  if (!state.clients.length){ grid.innerHTML = emptyState("No clients yet. Add your first client to start planning their content."); return; }
  const sorted = [...state.clients].sort((a,b) => (a.name||"").localeCompare(b.name||""));
  grid.innerHTML = sorted.map(c => {
    const pieces = state.clientContent.filter(x => x.client_id === c.id);
    const creatives = state.adCreatives.filter(x => x.client_id === c.id);
    const running = runningCampaignsFor(c.id).length;
    const totalCampaigns = campaignsFor(c.id).length;
    return `
      <div class="client-card" data-action="view-client" data-id="${c.id}">
        <div class="client-card-head">
          <h3>${escapeHtml(c.name)}</h3>
          <span class="badge ${c.cost_per_lead!=null ? 'gold':'gray'}">${c.cost_per_lead!=null ? fmtMoney(c.cost_per_lead)+' CPL' : 'No CPL yet'}</span>
        </div>
        ${c.notes ? `<div class="client-card-notes">${escapeHtml(c.notes)}</div>` : ""}
        <div class="client-card-stats">
          <span>${running} of ${totalCampaigns} campaign${totalCampaigns===1?"":"s"} running</span>
          <span>${pieces.length} content piece${pieces.length===1?"":"s"}</span>
          <span>${creatives.length} ad creative${creatives.length===1?"":"s"}</span>
        </div>
      </div>
    `;
  }).join("");
}
function renderClientDetail(c){
  $("#client-detail-name").textContent = c.name;
  $("#client-detail-cpl").textContent = c.cost_per_lead != null ? fmtMoney(c.cost_per_lead) : "Not set";
  $("#client-detail-notes").textContent = c.notes || "No notes yet.";
  $("#client-detail-quotes").textContent = c.quotes_sent || 0;

  const campaigns = campaignsFor(c.id).sort((a,b) => new Date(b.created_at)-new Date(a.created_at));
  const running = campaigns.filter(x => x.status === "active");
  $("#client-detail-campaigns-running").textContent = running.length;
  $("#client-detail-campaigns-total").textContent = campaigns.length;
  const campTbody = $("#campaigns-tbody");
  if (!campaigns.length){ campTbody.innerHTML = `<tr><td colspan="5">${emptyState("No campaigns yet. Add one to start tracking CPL.")}</td></tr>`; }
  else {
    campTbody.innerHTML = campaigns.map(camp => `
      <tr data-id="${camp.id}">
        <td><div class="row-name">${escapeHtml(camp.name)}</div>${camp.notes?`<div class="row-sub">${escapeHtml(camp.notes)}</div>`:""}</td>
        <td>${escapeHtml(camp.platform||"-")}</td>
        <td><span class="badge ${CAMPAIGN_STATUSES[camp.status]?.cls||'gray'}">${CAMPAIGN_STATUSES[camp.status]?.label||camp.status}</span></td>
        <td>${camp.cost_per_lead!=null ? fmtMoney(camp.cost_per_lead) : "-"}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="icon-btn" data-action="edit-campaign" data-id="${camp.id}" title="Edit">${ICONS.edit}</button>
          <button class="icon-btn" data-action="delete-campaign" data-id="${camp.id}" title="Delete">${ICONS.trash}</button>
        </td>
      </tr>
    `).join("");
  }

  const pieces = state.clientContent.filter(x => x.client_id === c.id);
  const board = $("#content-kanban-board");
  board.innerHTML = CONTENT_STATUSES.map(st => {
    const items = pieces.filter(p => p.status === st.key);
    return `
      <div class="kanban-col content-kanban-col" data-status="${st.key}">
        <div class="kanban-col-head">
          <h4>${st.label}</h4>
          <span class="kanban-count">${items.length}</span>
        </div>
        ${items.map(p => `
          <div class="content-card" draggable="true" data-id="${p.id}" data-action="edit-content">
            <span class="badge ${CONTENT_TYPES[p.type]?.cls||'gray'}" style="margin-bottom:6px;">${CONTENT_TYPES[p.type]?.label||p.type}</span>
            <h5>${escapeHtml(p.title)}</h5>
            <div class="content-card-foot">
              <button class="icon-btn" data-action="delete-content" data-id="${p.id}" title="Delete">${ICONS.trash}</button>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }).join("");
  setupContentDragDrop();

  const creatives = state.adCreatives.filter(x => x.client_id === c.id).sort((a,b) => new Date(b.created_at)-new Date(a.created_at));
  const tbody = $("#ad-creatives-tbody");
  if (!creatives.length){ tbody.innerHTML = `<tr><td colspan="5">${emptyState("No ad creatives tried yet.")}</td></tr>`; }
  else {
    tbody.innerHTML = creatives.map(a => `
      <tr data-id="${a.id}">
        <td>${a.image_url ? `<img src="${escapeHtml(a.image_url)}" class="ad-creative-thumb" data-action="view-creative-image" data-url="${escapeHtml(a.image_url)}">` : `<div class="ad-creative-thumb ad-creative-thumb-empty"></div>`}</td>
        <td><div class="row-name">${escapeHtml(a.name)}</div>${a.notes?`<div class="row-sub">${escapeHtml(a.notes)}</div>`:""}</td>
        <td><span class="badge ${AD_RESULTS[a.result]?.cls||'gray'}">${AD_RESULTS[a.result]?.label||a.result}</span></td>
        <td>${fmtDate(a.created_at)}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="icon-btn" data-action="edit-ad-creative" data-id="${a.id}" title="Edit">${ICONS.edit}</button>
          <button class="icon-btn" data-action="delete-ad-creative" data-id="${a.id}" title="Delete">${ICONS.trash}</button>
        </td>
      </tr>
    `).join("");
  }
}
function setupContentDragDrop(){
  let draggedId = null;
  $$(".content-card").forEach(card => {
    card.addEventListener("dragstart", (e) => {
      draggedId = card.dataset.id;
      card.classList.add("dragging");
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  });
  $$(".content-kanban-col").forEach(col => {
    col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("dragover"); });
    col.addEventListener("dragleave", () => col.classList.remove("dragover"));
    col.addEventListener("drop", async (e) => {
      e.preventDefault();
      col.classList.remove("dragover");
      if (!draggedId) return;
      await DataLayer.update("client_content", draggedId, { status: col.dataset.status, updated_at: new Date().toISOString() });
    });
  });
}

/* ───────── Render: Tasks ───────── */
function dealTitle(id){ return state.deals.find(d => d.id === id)?.title || ""; }
function todayDateStr(){ return new Date().toISOString().slice(0,10); }
function renderTasks(){
  const f = state.taskFilter;
  const todayStr = todayDateStr();
  const open = state.tasks.filter(t => t.status === "open");
  const overdue = open.filter(t => t.due_date && t.due_date < todayStr);
  const dueToday = open.filter(t => t.due_date === todayStr);
  const done = state.tasks.filter(t => t.status === "done");
  $("#tasks-stat-open").textContent = open.length;
  $("#tasks-stat-overdue").textContent = overdue.length;
  $("#tasks-stat-today").textContent = dueToday.length;
  $("#tasks-stat-done").textContent = done.length;

  let list = state.tasks.filter(t => {
    if (f.status !== "all" && t.status !== f.status) return false;
    if (f.priority && t.priority !== f.priority) return false;
    return true;
  });
  list = list.sort((a,b) => {
    if (f.sort === "priority") return (TASK_PRIORITIES[b.priority]?.rank||0) - (TASK_PRIORITIES[a.priority]?.rank||0);
    const da = a.due_date ? new Date(a.due_date).getTime() : Infinity;
    const db = b.due_date ? new Date(b.due_date).getTime() : Infinity;
    return da - db;
  });

  const tbody = $("#tasks-tbody");
  if (!tbody) return;
  if (!list.length){ tbody.innerHTML = `<tr><td colspan="6">${emptyState("No tasks match. Add one to get started.")}</td></tr>`; return; }
  tbody.innerHTML = list.map(t => {
    const isOverdue = t.status === "open" && t.due_date && t.due_date < todayStr;
    const linked = [t.contact_id ? contactName(t.contact_id) : "", t.deal_id ? dealTitle(t.deal_id) : ""].filter(Boolean);
    return `
    <tr data-id="${t.id}">
      <td style="width:34px;"><div class="mtr-check task-check ${t.status==='done'?'done':''}" data-action="toggle-task" data-id="${t.id}">${TASK_CHECK_SVG}</div></td>
      <td>
        <div class="row-name" style="${t.status==='done'?'text-decoration:line-through;color:var(--text2);':''}">${escapeHtml(t.title)}</div>
        ${linked.length ? `<div class="row-sub">${linked.map(escapeHtml).join(" · ")}</div>` : ""}
        ${t.notes ? `<div class="row-sub">${escapeHtml(t.notes)}</div>` : ""}
      </td>
      <td><span class="badge ${TASK_PRIORITIES[t.priority]?.cls||'gray'}">${TASK_PRIORITIES[t.priority]?.label||t.priority}</span></td>
      <td style="${isOverdue?'color:var(--danger);font-weight:700;':''}">${t.due_date ? fmtDate(t.due_date) : "-"}${isOverdue?" (overdue)":""}</td>
      <td><span class="badge ${t.status==='done'?'green':'gray'}">${t.status==='done'?'Done':'Open'}</span></td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="icon-btn" data-action="edit-task" data-id="${t.id}" title="Edit">${ICONS.edit}</button>
        <button class="icon-btn" data-action="delete-task" data-id="${t.id}" title="Delete">${ICONS.trash}</button>
      </td>
    </tr>
  `;}).join("");
}

/* ───────── Render: Reporting (Meta Ads client reports) ───────── */
function reportDueLabel(client){
  if (client.report_frequency === "off") return "Off";
  const days = client.report_frequency === "weekly" ? 7 : 30;
  if (!client.last_report_sent_at) return "Due now";
  const dueAt = new Date(client.last_report_sent_at).getTime() + days*24*60*60*1000;
  return dueAt <= Date.now() ? "Due now" : fmtDate(new Date(dueAt));
}
function renderReporting(){
  const tbody = $("#reporting-tbody");
  if (!tbody) return;
  const configured = state.clients.filter(c => c.meta_ad_account_id);
  $("#reporting-stat-configured").textContent = configured.length;
  $("#reporting-stat-due").textContent = configured.filter(c => reportDueLabel(c) === "Due now").length;
  $("#reporting-stat-sent").textContent = state.clientReports.filter(r => r.status === "sent").length;

  if (!configured.length){ tbody.innerHTML = `<tr><td colspan="6">${emptyState("No clients have a Meta Ad Account linked yet. Add one from a client's Edit Client form.")}</td></tr>`; return; }
  tbody.innerHTML = configured.map(c => {
    const reportCount = state.clientReports.filter(r => r.client_id === c.id).length;
    return `
      <tr data-id="${c.id}">
        <td><div class="row-name">${escapeHtml(c.name)}</div><div class="row-sub">${escapeHtml(c.meta_ad_account_id)}</div></td>
        <td><span class="badge gray">${c.report_frequency}</span></td>
        <td>${c.last_report_sent_at ? fmtDate(c.last_report_sent_at) : "Never"}</td>
        <td>${reportDueLabel(c)}</td>
        <td>${escapeHtml(c.report_email || "-")}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="btn ghost" data-action="view-report-history" data-id="${c.id}">History (${reportCount})</button>
          <button class="btn gold" data-action="send-report-now" data-id="${c.id}">Send Now</button>
        </td>
      </tr>
    `;
  }).join("");
}
async function sendReportNow(clientId){
  const client = state.clients.find(c => c.id === clientId);
  if (!client) return;
  if (!client.meta_ad_account_id || !client.report_email){ alert("This client needs a Meta Ad Account ID and a report email set first."); return; }
  if (!IS_CONFIGURED){
    // Demo mode: simulate what the real Edge Function would do, so the flow is testable without live Meta/Resend credentials.
    const periodDays = client.report_frequency === "weekly" ? 7 : 30;
    const periodEnd = new Date(), periodStart = new Date(Date.now() - periodDays*86400e3);
    await DataLayer.insert("client_reports", {
      client_id: clientId,
      period_start: periodStart.toISOString().slice(0,10),
      period_end: periodEnd.toISOString().slice(0,10),
      metrics: { spend:"512.00", impressions:"30120", reach:"14802", clicks:"401", ctr:"1.33", cpc:"1.28", cpm:"17.00", actions:[{action_type:"lead",value:"12"}], cost_per_action_type:[{action_type:"lead",value:"42.67"}] },
      status: "sent",
    });
    await DataLayer.update("clients", clientId, { last_report_sent_at: new Date().toISOString() });
    alert(`Demo mode: simulated sending ${client.name}'s report to ${client.report_email}. Connect Supabase + Meta + Resend for a real send.`);
    return;
  }
  const btn = document.querySelector(`[data-action="send-report-now"][data-id="${clientId}"]`);
  if (btn){ btn.disabled = true; btn.textContent = "Sending..."; }
  const { data, error } = await supabase.functions.invoke("generate-client-reports", { body: { client_id: clientId } });
  if (error){ alert("Couldn't send the report: " + error.message); }
  else if (data?.results?.[0]?.status === "failed"){ alert("Report failed: " + data.results[0].error); }
  else { alert(`Report sent to ${client.report_email}.`); }
  await DataLayer.fetchAll(); renderAll();
}
function renderReportHistoryModal(clientId){
  const client = state.clients.find(c => c.id === clientId);
  if (!client) return;
  $("#report-history-title").textContent = `${client.name} - Report History`;
  const reports = state.clientReports.filter(r => r.client_id === clientId).sort((a,b) => new Date(b.created_at)-new Date(a.created_at));
  const body = $("#report-history-body");
  if (!reports.length){ body.innerHTML = emptyState("No reports sent yet."); return; }
  body.innerHTML = `
    <table>
      <thead><tr><th>Period</th><th>Spend</th><th>Results</th><th>Status</th></tr></thead>
      <tbody>
        ${reports.map(r => {
          const m = r.metrics || {};
          const actions = m.actions || [];
          const resultsText = actions.length ? actions.map(a => `${a.value} ${String(a.action_type).replace(/_/g," ")}`).join(", ") : "-";
          return `<tr>
            <td>${fmtDate(r.period_start)} - ${fmtDate(r.period_end)}</td>
            <td>${m.spend != null ? fmtMoney(m.spend) : "-"}</td>
            <td>${escapeHtml(resultsText)}</td>
            <td><span class="badge ${r.status==='sent'?'green':'red'}">${r.status}</span>${r.error ? `<div class="row-sub">${escapeHtml(r.error)}</div>` : ""}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  `;
  openModal("report-history-modal");
}

/* ───────── Render: Prospecting (by region) ───────── */
function renderRegions(){
  const tbody = $("#regions-tbody");
  if (!tbody) return;
  if (!state.regions.length){ tbody.innerHTML = `<tr><td colspan="6">${emptyState("No regions yet. Add the first region you're calling through.")}</td></tr>`; return; }
  const sorted = [...state.regions].sort((a,b) => (a.region||"").localeCompare(b.region||""));
  tbody.innerHTML = sorted.map(r => {
    const calls = Number(r.calls_made||0);
    const meetings = Number(r.meetings_booked||0);
    const conversion = calls > 0 ? Math.round((meetings/calls)*100) + "%" : "-";
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
  renderRegions();
  renderDialer();
  renderClients();
  renderTasks();
  renderReporting();
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
  $("#qualify-attendees").textContent = (review.attendees || []).join(", ") || "-";
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
    title: `${review.meeting_title || "Meeting"} - ${attendee}`,
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
  const opts = `<option value="">- No contact -</option>` + state.contacts.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  ["deal-contact-select","task-contact-select"].forEach(id => {
    const el = $("#"+id);
    if (el) el.innerHTML = opts;
  });
  const dealOpts = `<option value="">- No deal -</option>` + state.deals.map(d => `<option value="${d.id}">${escapeHtml(d.title)}</option>`).join("");
  const dealEl = $("#task-deal-select");
  if (dealEl) dealEl.innerHTML = dealOpts;
}

const ICONS = {
  edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`,
  trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`,
  calendarCheck: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18M9 16l2 2 4-4"/></svg>`,
  moveToContact: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8l3 3-3 3M23 11h-9"/></svg>`,
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

  $("#add-deal-btn").addEventListener("click", () => {
    $("#deal-form").reset();
    $("#deal-contacts-rows").innerHTML = "";
    addDealContactRow();
    openModal("deal-modal");
  });
  $("#deal-add-contact-row-btn")?.addEventListener("click", () => addDealContactRow());
  $("#deal-detail-save-notes")?.addEventListener("click", () => { if (state.selectedDealId) addDealNote(state.selectedDealId); });
  $("#deal-detail-add-contact-btn")?.addEventListener("click", () => { if (state.selectedDealId) addExistingContactToDeal(state.selectedDealId); });
  $("#deal-contacts-rows")?.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".dc-remove");
    if (removeBtn) removeBtn.closest(".deal-contact-row")?.remove();
  });
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
    const deal = await DataLayer.insert("deals", row);
    if (deal) await saveDealContactRows(deal.id);
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

  $("#dialer-add-btn")?.addEventListener("click", () => {
    $("#prospect-form").reset(); $("#prospect-form-id").value=""; $("#prospect-modal-title").textContent="Add Prospect";
    openModal("prospect-modal");
  });
  $("#prospect-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#prospect-form-id").value;
    const row = {
      name: $("#prospect-name").value.trim(),
      phone: $("#prospect-phone").value.trim(),
      company: $("#prospect-company").value.trim(),
      email: $("#prospect-email").value.trim(),
      region: $("#prospect-region").value.trim(),
      industry: $("#prospect-industry").value.trim(),
      notes: $("#prospect-notes").value.trim(),
    };
    if (!row.name) return;
    if (id){
      row.updated_at = new Date().toISOString();
      await DataLayer.update("dial_prospects", id, row);
    } else {
      row.calls_made = 0; row.last_called_at = null; row.last_outcome = null;
      await DataLayer.insert("dial_prospects", row);
    }
    closeModal("prospect-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-client-btn")?.addEventListener("click", () => { $("#client-form").reset(); $("#client-form-id").value=""; $("#client-modal-title").textContent="Add Client"; openModal("client-modal"); });
  $("#client-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#client-form-id").value;
    const row = {
      name: $("#client-name").value.trim(),
      cost_per_lead: $("#client-cpl").value !== "" ? Number($("#client-cpl").value) : null,
      notes: $("#client-notes").value.trim(),
      meta_ad_account_id: $("#client-meta-account").value.trim(),
      report_frequency: $("#client-report-frequency").value,
      report_email: $("#client-report-email").value.trim(),
      updated_at: new Date().toISOString(),
    };
    if (!row.name) return;
    if (id) await DataLayer.update("clients", id, row);
    else await DataLayer.insert("clients", row);
    closeModal("client-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-content-btn")?.addEventListener("click", () => {
    $("#content-form").reset(); $("#content-form-id").value=""; $("#content-modal-title").textContent="Add Content";
    openModal("content-modal");
  });
  $("#content-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#content-form-id").value;
    const row = {
      client_id: state.selectedClientId,
      title: $("#content-title").value.trim(),
      type: $("#content-type").value,
      status: $("#content-status").value,
      directions: $("#content-directions").value.trim(),
      script: $("#content-script").value.trim(),
      notes: $("#content-notes").value.trim(),
      updated_at: new Date().toISOString(),
    };
    if (!row.title) return;
    if (id) await DataLayer.update("client_content", id, row);
    else await DataLayer.insert("client_content", row);
    closeModal("content-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-ad-creative-btn")?.addEventListener("click", () => {
    $("#ad-creative-form").reset(); $("#ad-creative-form-id").value=""; $("#ad-creative-modal-title").textContent="Add Ad Creative";
    $("#ad-creative-current-image").innerHTML = "";
    openModal("ad-creative-modal");
  });
  $("#ad-creative-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#ad-creative-form-id").value;
    const file = $("#ad-creative-image").files[0];
    const row = {
      client_id: state.selectedClientId,
      name: $("#ad-creative-name").value.trim(),
      result: $("#ad-creative-result").value,
      notes: $("#ad-creative-notes").value.trim(),
    };
    if (!row.name) return;
    if (file){
      const imageUrl = await uploadAdCreativeImage(file);
      if (imageUrl) row.image_url = imageUrl;
    }
    if (id) await DataLayer.update("client_ad_creatives", id, row);
    else await DataLayer.insert("client_ad_creatives", row);
    closeModal("ad-creative-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-campaign-btn")?.addEventListener("click", () => {
    $("#campaign-form").reset(); $("#campaign-form-id").value=""; $("#campaign-modal-title").textContent="Add Campaign";
    openModal("campaign-modal");
  });
  $("#campaign-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#campaign-form-id").value;
    const row = {
      client_id: state.selectedClientId,
      name: $("#campaign-name").value.trim(),
      platform: $("#campaign-platform").value.trim(),
      status: $("#campaign-status").value,
      cost_per_lead: $("#campaign-cpl").value !== "" ? Number($("#campaign-cpl").value) : null,
      notes: $("#campaign-notes").value.trim(),
      updated_at: new Date().toISOString(),
    };
    if (!row.name) return;
    if (id) await DataLayer.update("client_campaigns", id, row);
    else await DataLayer.insert("client_campaigns", row);
    closeModal("campaign-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-task-btn")?.addEventListener("click", () => {
    $("#task-form").reset(); $("#task-form-id").value=""; $("#task-modal-title").textContent="Add Task";
    openModal("task-modal");
  });
  $("#task-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#task-form-id").value;
    const row = {
      title: $("#task-title").value.trim(),
      due_date: $("#task-due-date").value || null,
      priority: $("#task-priority").value,
      notes: $("#task-notes").value.trim(),
      contact_id: $("#task-contact-select").value || null,
      deal_id: $("#task-deal-select").value || null,
      updated_at: new Date().toISOString(),
    };
    if (!row.title) return;
    if (id) await DataLayer.update("tasks", id, row);
    else { row.status = "open"; await DataLayer.insert("tasks", row); }
    closeModal("task-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  document.body.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const { action, id, outcome } = btn.dataset;
    if (action === "delete-contact" && confirm("Delete this contact?")) await DataLayer.remove("contacts", id);
    if (action === "delete-deal" && confirm("Delete this deal?")) await DataLayer.remove("deals", id);
    if (action === "view-deal"){ state.selectedDealId = id; renderDeals(); }
    if (action === "back-to-deals"){ state.selectedDealId = null; renderDeals(); }
    if (action === "mark-deal-called") await markDealCalled(state.selectedDealId);
    if (action === "delete-region" && confirm("Delete this region?")) await DataLayer.remove("prospecting_regions", id);
    if (action === "delete-prospect" && confirm("Delete this prospect?")) await DataLayer.remove("dial_prospects", id);
    if (action === "edit-prospect"){
      const p = state.prospects.find(x => x.id === id);
      if (!p) return;
      $("#prospect-form-id").value = p.id;
      $("#prospect-name").value = p.name||"";
      $("#prospect-phone").value = p.phone||"";
      $("#prospect-company").value = p.company||"";
      $("#prospect-email").value = p.email||"";
      $("#prospect-region").value = p.region||"";
      $("#prospect-industry").value = p.industry||"";
      $("#prospect-notes").value = p.notes||"";
      $("#prospect-modal-title").textContent = "Edit Prospect";
      openModal("prospect-modal");
    }
    if (action === "convert-prospect" && confirm("Move this prospect to Contacts? They'll come off the dial queue.")){
      const p = state.prospects.find(x => x.id === id);
      if (p){
        await DataLayer.insert("contacts", {
          name: p.name, phone: p.phone||"", company: p.company||"", email: p.email||"",
          status: "lead", tags: p.industry||"",
        });
        await DataLayer.remove("dial_prospects", id);
      }
    }
    if (action === "dial-tel") await logDialOutcome(id, "dialed");
    if (action === "start-call") await startCall(id);
    if (action === "dial-outcome") await logDialOutcome(id, outcome);
    if (action === "view-client"){ state.selectedClientId = id; renderClients(); }
    if (action === "back-to-clients"){ state.selectedClientId = null; renderClients(); }
    if (action === "edit-client-header"){
      const c = state.clients.find(x => x.id === state.selectedClientId);
      if (!c) return;
      $("#client-form-id").value = c.id;
      $("#client-name").value = c.name||"";
      $("#client-cpl").value = c.cost_per_lead != null ? c.cost_per_lead : "";
      $("#client-notes").value = c.notes||"";
      $("#client-meta-account").value = c.meta_ad_account_id||"";
      $("#client-report-frequency").value = c.report_frequency||"monthly";
      $("#client-report-email").value = c.report_email||"";
      $("#client-modal-title").textContent = "Edit Client";
      openModal("client-modal");
    }
    if (action === "delete-client" && confirm("Delete this client and all their content pieces / ad creatives?")) {
      await DataLayer.remove("clients", state.selectedClientId);
      state.selectedClientId = null;
      renderClients();
    }
    if (action === "quote-increment" || action === "quote-decrement"){
      const client = state.clients.find(x => x.id === state.selectedClientId);
      if (client){
        const next = Math.max(0, Number(client.quotes_sent||0) + (action === "quote-increment" ? 1 : -1));
        await DataLayer.update("clients", client.id, { quotes_sent: next });
        if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
      }
    }
    if (action === "edit-content"){
      const p = state.clientContent.find(x => x.id === id);
      if (!p) return;
      $("#content-form-id").value = p.id;
      $("#content-title").value = p.title||"";
      $("#content-type").value = p.type||"video";
      $("#content-status").value = p.status||"idea";
      $("#content-directions").value = p.directions||"";
      $("#content-script").value = p.script||"";
      $("#content-notes").value = p.notes||"";
      $("#content-modal-title").textContent = "Edit Content";
      openModal("content-modal");
    }
    if (action === "delete-content" && confirm("Delete this content piece?")) await DataLayer.remove("client_content", id);
    if (action === "edit-ad-creative"){
      const a = state.adCreatives.find(x => x.id === id);
      if (!a) return;
      $("#ad-creative-form-id").value = a.id;
      $("#ad-creative-name").value = a.name||"";
      $("#ad-creative-result").value = a.result||"testing";
      $("#ad-creative-notes").value = a.notes||"";
      $("#ad-creative-image").value = "";
      $("#ad-creative-current-image").innerHTML = a.image_url ? `<img src="${escapeHtml(a.image_url)}" class="ad-creative-thumb">` : "";
      $("#ad-creative-modal-title").textContent = "Edit Ad Creative";
      openModal("ad-creative-modal");
    }
    if (action === "delete-ad-creative" && confirm("Delete this ad creative?")) await DataLayer.remove("client_ad_creatives", id);
    if (action === "view-creative-image"){ window.open(btn.dataset.url, "_blank"); }
    if (action === "edit-campaign"){
      const camp = state.campaigns.find(x => x.id === id);
      if (!camp) return;
      $("#campaign-form-id").value = camp.id;
      $("#campaign-name").value = camp.name||"";
      $("#campaign-platform").value = camp.platform||"";
      $("#campaign-status").value = camp.status||"active";
      $("#campaign-cpl").value = camp.cost_per_lead != null ? camp.cost_per_lead : "";
      $("#campaign-notes").value = camp.notes||"";
      $("#campaign-modal-title").textContent = "Edit Campaign";
      openModal("campaign-modal");
    }
    if (action === "delete-campaign" && confirm("Delete this campaign?")) await DataLayer.remove("client_campaigns", id);
    if (action === "toggle-task"){
      const t = state.tasks.find(x => x.id === id);
      if (!t) return;
      await DataLayer.update("tasks", id, { status: t.status === "done" ? "open" : "done", updated_at: new Date().toISOString() });
    }
    if (action === "edit-task"){
      const t = state.tasks.find(x => x.id === id);
      if (!t) return;
      $("#task-form-id").value = t.id;
      $("#task-title").value = t.title||"";
      $("#task-due-date").value = t.due_date||"";
      $("#task-priority").value = t.priority||"medium";
      $("#task-notes").value = t.notes||"";
      $("#task-contact-select").value = t.contact_id||"";
      $("#task-deal-select").value = t.deal_id||"";
      $("#task-modal-title").textContent = "Edit Task";
      openModal("task-modal");
    }
    if (action === "delete-task" && confirm("Delete this task?")) await DataLayer.remove("tasks", id);
    if (action === "send-report-now") await sendReportNow(id);
    if (action === "view-report-history") renderReportHistoryModal(id);
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
function setupDialerFilters(){
  $("#dialer-search")?.addEventListener("input", (e) => { state.dialerFilter.search = e.target.value; renderDialer(); });
  $("#dialer-filter-region")?.addEventListener("change", (e) => { state.dialerFilter.region = e.target.value; renderDialer(); });
  $("#dialer-filter-industry")?.addEventListener("change", (e) => { state.dialerFilter.industry = e.target.value; renderDialer(); });
}
function setupTaskFilters(){
  $("#task-status-filter")?.addEventListener("change", (e) => { state.taskFilter.status = e.target.value; renderTasks(); });
  $("#task-priority-filter")?.addEventListener("change", (e) => { state.taskFilter.priority = e.target.value; renderTasks(); });
  $("#task-sort")?.addEventListener("change", (e) => { state.taskFilter.sort = e.target.value; renderTasks(); });
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
  setupDialerImport();
  setupDialerFilters();
  setupCallWidget();
  setupTaskFilters();
  initAuth();
});
})();
