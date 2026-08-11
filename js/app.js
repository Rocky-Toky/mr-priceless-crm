/* Mr Priceless CRM - app logic (vanilla JS, no build step) */
(function(){
"use strict";

const { supabase, IS_CONFIGURED } = window.CRM_DB;

// Only these tables actually have a created_by column (see sql/schema.sql) -
// every table added since (clients, client_content, client_ad_creatives,
// client_campaigns, deal_contacts, prospecting_regions) does not, and
// Supabase rejects inserts with an unknown column. dial_prospects got its
// own created_by in 032, once it went back to being a shared list.
const TABLES_WITH_CREATED_BY = new Set(["contacts", "cold_calls", "deals", "dial_prospects"]);
// Tasks stays per-login (see sql/013_per_login_scoping.sql) - every new row
// is stamped with whoever created it so RLS can scope it to just them.
// dial_prospects also stamps user_id for legacy reasons but, since 032, its
// RLS is shared team-wide - the column is unused for access control now.
const TABLES_WITH_USER_ID = new Set(["dial_prospects", "tasks"]);

const STAGES = [
  { key: "qualified", label: "Meeting Booked" },
  { key: "no_show", label: "No Show" },
  { key: "proposal", label: "Proposal Meeting" },
  { key: "negotiation", label: "Negotiation" },
  { key: "pending_results", label: "Pending Results" },
  { key: "closed_won", label: "Closed Won" },
  { key: "closed_lost", label: "Closed Lost" },
];
const CLOSED_STAGES = new Set(["closed_won", "closed_lost"]);
// A meeting counts as "closed" once its deal is far enough along to matter -
// either it's landed in Pending Results or gone all the way to Closed Won.
// Matches the same pair maybeCreateClientFromDeal() already uses to decide
// a deal succeeded enough to spin up a Client record.
const MEETING_CLOSE_STAGES = new Set(["pending_results", "closed_won"]);
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
// Meta's real delivery status per ad, pulled live via sync/refresh - distinct
// from the manually-set AD_RESULTS tag above.
const DELIVERY_STATUS = {
  active: { label: "Active", cls: "green", group: "running" },
  learning: { label: "Learning", cls: "gold", group: "running" },
  learning_limited: { label: "Learning Limited", cls: "gold", group: "running" },
  paused: { label: "Paused", cls: "gray", group: "paused" },
  campaign_paused: { label: "Campaign Paused", cls: "gray", group: "paused" },
  adset_paused: { label: "Ad Set Paused", cls: "gray", group: "paused" },
  archived: { label: "Archived", cls: "gray", group: "paused" },
  deleted: { label: "Deleted", cls: "gray", group: "paused" },
  in_review: { label: "In Review", cls: "gold", group: "attention" },
  preapproved: { label: "Pre-Approved", cls: "gold", group: "attention" },
  in_process: { label: "Processing", cls: "gold", group: "attention" },
  disapproved: { label: "Disapproved", cls: "red", group: "attention" },
  with_issues: { label: "With Issues", cls: "red", group: "attention" },
  pending_billing: { label: "Pending Billing", cls: "red", group: "attention" },
};
// Fatigue is Rocky's own manual call on a creative - never computed from
// performance numbers, so this only ever changes via the dropdown he sets.
const FATIGUE_STATUS = {
  fatiguing: { label: "Fatiguing", cls: "fatiguing" },
  fatigued: { label: "Fully Fatigued", cls: "fatigued" },
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
const ASSIGNEES = {
  rocky: { label: "Rocky", cls: "gold" },
  max: { label: "Max", cls: "black" },
  bailey: { label: "Bailey", cls: "blue" },
  gabriel: { label: "Gabriel", cls: "purple" },
  raheem: { label: "Raheem", cls: "green" },
  thor: { label: "Thor", cls: "red" },
};
// Real login emails don't reliably reduce to their ASSIGNEES key (Max's is
// maximus.smith@..., not max@...), so this is an explicit map rather than a
// guess from the email's local part. Keep in sync with the allowlist.
// Raheem and Thor aren't in here yet - no login emails for them yet, so they
// can be picked as an assignee but can't sign in or be auto-matched from
// call activity until their emails are added here and to the allowlist.
const EMAIL_TO_ASSIGNEE = {
  "rockyoneill02@gmail.com": "rocky",
  "maximus.smith@mrpriceless.com": "max",
  "bailey.hanlon@mrpriceless.com": "bailey",
  "gabriel.irvan@mrpriceless.com": "gabriel",
};
// Bailey and Gabriel are sales-only hires - Service Delivery stays
// Rocky/Max only.
const DELIVERY_RESTRICTED_EMAILS = new Set([
  "bailey.hanlon@mrpriceless.com",
  "gabriel.irvan@mrpriceless.com",
]);
function canAccessDelivery(){
  const email = (state.user?.email || "").toLowerCase();
  return !DELIVERY_RESTRICTED_EMAILS.has(email);
}
function getAssigneeFirstPref(){ return localStorage.getItem("crm_task_assignee_first") || "rocky"; }
function setAssigneeFirstPref(v){ if (ASSIGNEES[v]) localStorage.setItem("crm_task_assignee_first", v); }
// Fixed pick-lists for a prospect's Region and Industry, so everyone picks
// from the same canonical set instead of typing free text that drifts apart
// ("Auckland" vs "Auckalnd" vs "Akl") and never lines up across the team.
const NZ_REGIONS = [
  "Ashburton", "Auckland", "Auckland CBD", "Bay of Plenty", "Blenheim", "Cambridge",
  "Canterbury", "Christchurch", "Dunedin", "East Auckland", "Gisborne", "Gore",
  "Greymouth", "Hamilton", "Hastings", "Hawkes Bay", "Invercargill", "Kapiti Coast",
  "Kerikeri", "Levin", "Lower Hutt", "Manawatu-Whanganui", "Marlborough", "Masterton",
  "Motueka", "Napier", "Nelson", "New Plymouth", "North Shore", "Northland", "Oamaru",
  "Otago", "Paihia", "Palmerston North", "Picton", "Porirua", "Pukekohe", "Queenstown",
  "Rangiora", "Rotorua", "South Auckland", "Southland", "Taranaki", "Tasman", "Taupo",
  "Tauranga", "Timaru", "Upper Hutt", "Waikato", "Wanaka", "Wellington", "West Auckland",
  "West Coast", "Whakatane", "Whangarei", "Whanganui",
];
const AU_REGIONS = [
  "Australian Capital Territory", "New South Wales", "Northern Territory", "Queensland",
  "South Australia", "Tasmania", "Victoria", "Western Australia",
];
// One combined list for region dropdowns - AU states and NZ regions never
// collide by name, so there's no need for a separate country toggle just to
// pick the right one.
const ALL_REGIONS = [...AU_REGIONS, ...NZ_REGIONS];
const HOME_SERVICES_INDUSTRIES = [
  "Aluminium Joinery", "Blinds & Curtains", "Builders", "Carpentry", "Carpet Cleaning",
  "Chimney Sweep", "Concreting", "Construction", "Deck Building", "Demolition",
  "Driveways & Paving", "Electrical", "Excavation", "Fencing", "Flooring",
  "Gardening & Lawn Care", "Glazing", "Guttering", "Handyman Services",
  "Heat Pump Installation", "House Cleaning", "House Painting", "HVAC", "Insulation",
  "Irrigation", "Kitchen & Bathroom Renovation", "Landscaping", "Locksmith",
  "Moving & Removals", "Pest Control", "Plastering", "Plumbing", "Pool Services",
  "Retaining Walls", "Roofing", "Rubbish Removal", "Scaffolding", "Security Systems",
  "Septic Tank Services", "Skip Bin Hire", "Solar Installation", "Tiling",
  "Tree Services", "Waterproofing", "Window Cleaning",
];
function populateStaticSelect(id, options, placeholder){
  const el = $(id);
  if (!el) return;
  el.innerHTML = (placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : "")
    + options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
}
function populateRegionIndustrySelects(){
  populateStaticSelect("#prospect-region", ALL_REGIONS, "- Select a region -");
  populateStaticSelect("#prospect-industry", HOME_SERVICES_INDUSTRIES, "- Select an industry -");
  populateStaticSelect("#log-call-region", ALL_REGIONS, "- Select a region -");
  populateStaticSelect("#import-details-region", ALL_REGIONS, "- Select a region -");
  populateStaticSelect("#import-details-industry", HOME_SERVICES_INDUSTRIES, "- Select an industry -");
}
const OUTCOMES = {
  no_answer: { label: "No Answer", cls: "gray" },
  call_back: { label: "Call Back", cls: "gold" },
  not_interested: { label: "Not Interested", cls: "red" },
  booked_meeting: { label: "Booked Meeting", cls: "black" },
};
const CONTACT_STATUS = {
  lead: { label: "Lead", cls: "gray" },
  active: { label: "Active", cls: "gold" },
  client: { label: "Client", cls: "green" },
  inactive: { label: "Inactive", cls: "red" },
};
const CONTRACT_TYPES = {
  retainer: { label: "Monthly Retainer", cls: "gold" },
  profit_share: { label: "Profit Share", cls: "green" },
  revenue_share: { label: "Revenue Share", cls: "black" },
};
function dealValueLabel(d){
  if (d.contract_type === "profit_share" || d.contract_type === "revenue_share"){
    return `${Number(d.percentage||0)}% ${CONTRACT_TYPES[d.contract_type].label}`;
  }
  return fmtMoney(d.value);
}
const EXPENSE_CATEGORIES = {
  software: "Software & Tools",
  ad_spend: "Ad Spend",
  contractors: "Contractors",
  wages: "Wages",
  office: "Office & Admin",
  other: "Other",
};
const EXPENSE_TYPES = {
  expense: { label: "Expense", cls: "gray" },
  profit: { label: "Profit Share", cls: "green" },
};
const EXPENSE_FREQUENCIES = {
  one_off: { label: "One-off", cls: "gray" },
  monthly: { label: "Monthly", cls: "gold" },
};
const CLIENT_STAGES = [
  { key: "onboarding", label: "Onboarding", days: 30, cls: "gold" },
  { key: "quote_guarantee", label: "Quote Guarantee", days: null, cls: "black" },
  { key: "month_1", label: "Month 1", days: 30, cls: "gold" },
  { key: "month_2", label: "Month 2", days: 30, cls: "gold" },
  { key: "month_3", label: "Month 3", days: 30, cls: "gold" },
  { key: "established", label: "Established", days: null, cls: "green" },
  { key: "at_risk", label: "At Risk", days: null, cls: "red" },
  { key: "churned", label: "Churned", days: null, cls: "gray" },
];
const CLIENT_STAGE_MAP = Object.fromEntries(CLIENT_STAGES.map(s => [s.key, s]));
// The fields that make a client's profile genuinely useful to anyone on the
// team - drives the completeness bar on the Client Info card and kanban card.
const CLIENT_INFO_FIELDS = [
  { key: "services", label: "Services", hint: "What we deliver for them - so anyone can explain it without asking." },
  { key: "renewal_date", label: "Renewal / Review Date", hint: "When to revisit the contract or scope.", isDate: true },
  { key: "client_rules", label: "Client Rules", hint: "Anything they're particular about, so nobody has to learn it the hard way." },
  { key: "key_contacts", label: "Key Contacts", hint: "Who the decision makers are and how to reach them." },
  { key: "communication_preferences", label: "Communication Preferences", hint: "Preferred channel, cadence, response expectations.", wide: true },
  { key: "qualified_lead_structure", label: "Qualified Lead Structure", hint: "What actually counts as a good lead for this client - fills in automatically as you answer the qualifying questions on their Onboarding checklist." },
  { key: "branding_expectations", label: "Branding Expectations", hint: "Tone, colours, logo use - what to avoid." },
];
function clientProfileCompleteness(c){
  const filled = CLIENT_INFO_FIELDS.filter(f => c[f.key] != null && String(c[f.key]).trim() !== "").length;
  return { filled, total: CLIENT_INFO_FIELDS.length, pct: Math.round(filled / CLIENT_INFO_FIELDS.length * 100) };
}
// IMPORTANT: each step's saved progress is keyed by its position
// (section index _ item index - see ONBOARDING_STEPS below). Only ever
// APPEND new items to the end of a section's list (or append a whole new
// section to the end of this array). Inserting one in the middle shifts
// every later item's key and silently un-checks it for every client who'd
// already ticked it - this happened once already (the derived Meta Ad
// Account ID step landing mid-"Before The Call" bumped "Send the welcome
// email" from key 0_2 to 0_3).
const ONBOARDING_SECTIONS = [
  { section: "Before The Call", items: [
    "Book the onboarding call in with them.",
    "Set up their pipeline ahead of time so it's ready to demo.",
    { text: "Add their Meta Ad Account ID to Clients, so their campaigns and creatives start syncing in automatically.", derivedFrom: "meta_ad_account_id" },
    "Send the welcome email.",
    "Set up their Meta integration.",
    "Set up their phone number.",
    "Sync their calendar.",
    "Get them to upload their photos/images.",
    "Get Max to set up the Zapier integration.",
    "Make 3 ad creatives for Meta - 2 proven High Performers and 1 new one to Test.",
    "Halfway between booking the call and the call itself, give them a quick ring to reinforce the excitement, confirm they've got the calendar invite, and let them know we're already setting up their CRM.",
    { text: "Add the date we start running their ads to Clients, so we know when to invoice them.", derivedFrom: "ad_start_date" },
  ]},
  { section: "Open With Energy", items: [
    "Come in genuinely excited - smiling, good energy, stoked to have them on board.",
    "Introduce yourself and the Media Buyer who'll be handling the digital marketing side.",
  ]},
  { section: "Set Honest Expectations", items: [
    "Explain that conversion rates and sales cycles on paid leads run lower than word of mouth - word of mouth is still the best lead source in business, the problem is it's unpredictable and hard to scale, which is exactly the gap paid ads fill.",
    "Be upfront that they might not see a sale in month one if their sales cycle runs a bit longer than that.",
  ]},
  { section: "Define What A Good Lead Looks Like For Them", items: [
    { text: "Ask what they consider a job they're happy to quote for.", answerable: true, fieldLabel: "What Counts As A Good Lead" },
    { text: "Confirm their budget and timeline expectations.", answerable: true, fieldLabel: "Budget & Timeline Expectations" },
    { text: "Confirm their average job value.", answerable: true, fieldLabel: "Average Job Value" },
    { text: "Confirm the type of work they want to chase right now.", answerable: true, fieldLabel: "Ideal Work Right Now" },
    { text: "Confirm how far out from their base they're willing to quote.", answerable: true, fieldLabel: "Service Radius" },
    { text: "Confirm whether they can quote after hours or on weekends.", answerable: true, fieldLabel: "After-Hours / Weekend Quoting" },
  ]},
  { section: "Set Up Their Calendar", items: [
    "Confirm they're on Google Calendar and get the app downloaded on their phone - mention it syncs offline so it works anywhere.",
    "Explain quotes get booked straight into whatever shows as free, so they need to block off every slot they're actually available - including travel time to and from quotes.",
    "Walk them through setting recurring blocks for their regular hours or days off, so they're not manually updating their calendar every week.",
    "Get their calendar synced with GHL, so bookings and their calendar stay lined up on both sides.",
    "Check their Google Calendar sharing is set to \"See all event details\", not \"See only free/busy\" - otherwise quotes booked in just show as a blocked-out busy slot with none of the actual details.",
  ]},
  { section: "Demo The CRM", items: [
    "Walk them through the Tasks section.",
    "Walk them through Opportunities - the leads that sync straight in from Meta.",
    "Show them where to add notes, and stress how important it is to drag leads through the stages - that feedback is what we use to optimise targeting back on Meta.",
    "Let them know Tasks, Opportunities, and Document Storage are really the only sections they'll need to worry about day to day.",
    "Walk through Document Storage - this is where they upload before/after job photos for us, plus a friendly photo of the team (or just themselves) to use in ads.",
    "Get them to pin the CRM tab in their browser so it's always handy.",
  ]},
  { section: "Confirm Access & Notifications", items: [
    "Send their login and confirm they can get in.",
    "Mention they'll get an automated text the moment a quote is booked, plus a reminder an hour before it's due.",
    "Set up full Meta partner access on their ad account.",
  ]},
  { section: "Lock In The Ongoing Cadence", items: [
    "Set up a recurring fortnightly catch-up to go through progress, goals, and the pipeline together.",
    "Set a reminder to call them in 1 week for a quick update - share genuine excitement and let them know how everything's tracking so far.",
  ]},
  { section: "Close It Out", items: [
    "Tell them again how excited we are to work with them - we don't take on just anyone, and we're genuinely looking to build a long-term partnership.",
    "Let them know they can call anytime - if anything feels off, or they want to go deeper on strategy and what's actually happening behind the ads, we're always happy to jump on a call and sort it out together.",
  ]},
];
const ONBOARDING_ANSWER_SUFFIX = "_answer";
const ONBOARDING_STEPS = ONBOARDING_SECTIONS.flatMap((s, si) => s.items.map((item, ii) => {
  const isObj = typeof item === "object";
  return {
    key: `${si}_${ii}`,
    section: s.section,
    label: isObj ? item.text : item,
    answerable: isObj ? Boolean(item.answerable) : false,
    fieldLabel: isObj ? item.fieldLabel : null,
    derivedFrom: isObj ? item.derivedFrom || null : null,
  };
}));
// Builds the client's Qualified Lead Structure text from every answered
// onboarding qualifying question, so it's always a live mirror of what was
// actually said on the call rather than something typed up separately after.
function composeQualifiedLeadStructure(progress){
  return ONBOARDING_STEPS
    .filter(s => s.answerable)
    .map(s => {
      const answer = String(progress?.[s.key + ONBOARDING_ANSWER_SUFFIX] || "").trim();
      return answer ? `${s.fieldLabel}: ${answer}` : null;
    })
    .filter(Boolean)
    .join("\n");
}
async function saveOnboardingAnswer(clientId, stepKey, value){
  const c = state.clients.find(x => x.id === clientId);
  if (!c) return;
  const progress = { ...(c.onboarding_progress || {}) };
  progress[stepKey + ONBOARDING_ANSWER_SUFFIX] = value;
  const qualified_lead_structure = composeQualifiedLeadStructure(progress);
  c.onboarding_progress = progress;
  c.qualified_lead_structure = qualified_lead_structure;
  await DataLayer.update("clients", clientId, { onboarding_progress: progress, qualified_lead_structure });
}

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
  playbooks: [],
  selectedPlaybookId: null,
  rules: [],
  selectedRuleId: null,
  emailTemplates: [],
  selectedEmailTemplateId: null,
  expenses: [],
  callActivity: [],
  creativeSnapshots: [],
  clientLeads: [],
  playbookUsage: [],
  selectedClientId: null,
  selectedOnboardingClientId: null,
  selectedDealId: null,
  dialerFilter: { search: "", region: "", industry: "", caller: "" },
  prospectingView: "active",
  regionDataFilter: "",
  prospectingCollapsedRegions: new Set(),
  teamFocus: { rocky: null, max: null, bailey: null, gabriel: null, raheem: null, thor: null },
  taskFilter: { status: "open", priority: "", sort: "due_date", assignee: "" },
  team: [],
  contactFilter: "",
  contactSearch: "",
  creativeFilter: { client: "", result: "", delivery: "", sort: "top" },
  contentFilter: { search: "", client: "", type: "" },
  clientsGallerySearch: "",
  clientsCollapsedStages: new Set(),
  googleAccessToken: null,
  calendarEvents: [],
  calendarWeekStart: startOfWeek(new Date()),
  statsFilter: { person: "", range: "all", customFrom: "", customTo: "" },
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
// Twilio needs E.164 (+<country code><number>). The Aus Dialler only calls
// Australian numbers, so assume AU (+61) unless a country code is already
// present - either as a leading "+", or as bare digits (e.g. "61412345678"
// or "0061412345678", both missing only the "+"). Imports never had a
// country code prompt (see importProspectRows), so this default is what
// every scraped number actually gets normalized against - a wrong default
// here silently misdials into a real but unrelated stranger's phone, which
// is exactly what happened when this used to default to NZ.
const toE164 = (phone, defaultCountryCode = "61") => {
  const raw = String(phone||"").trim();
  if (!raw) return "";
  if (raw.startsWith("+")) return "+" + raw.replace(/[^0-9]/g, "");
  let digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2); // "0061..." international dialing prefix
  if (digits.startsWith(defaultCountryCode) && digits.length > 9) return "+" + digits;
  const national = digits.replace(/^0+/, "");
  return national ? "+" + defaultCountryCode + national : "";
};
// Splits a stored E.164 number back into {code, local} for editing forms that
// show the country code as its own dropdown (e.g. the Contact modal).
const KNOWN_COUNTRY_CODES = ["61","64","1","44"];
const splitE164 = (phone) => {
  const raw = String(phone||"").trim();
  if (!raw.startsWith("+")) return { code: "61", local: raw };
  const digits = raw.slice(1);
  const code = KNOWN_COUNTRY_CODES.find(c => digits.startsWith(c)) || "61";
  return { code, local: digits.slice(code.length) };
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
  const dealKauriRevShare = uid();
  state.deals = [
    { id:deal1, contact_id:c1, contact_name:"Aroha Ngata", title:"Kauri - Full funnel rebuild", contract_type:"profit_share", percentage:15, value:0, stage:"negotiation", assignee:"rocky", notes:"", created_at:new Date(Date.now()-86400e3*14).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), contact_id:c2, contact_name:"Ben Whitfield", title:"Summit Dental - Meta Ads retainer", contract_type:"retainer", value:2200, stage:"qualified", assignee:"max", notes:"", created_at:new Date(Date.now()-86400e3*20).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), contact_id:c3, contact_name:"Priya Chand", title:"Chand Legal - SEO + Ads", contract_type:"retainer", value:3600, stage:"proposal", assignee:"rocky", notes:"", created_at:new Date(Date.now()-86400e3*1).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), contact_id:null, contact_name:"Marlon Reeve - Reeve Builders", title:"Reeve Builders - 10 quote guarantee", contract_type:"revenue_share", percentage:10, value:0, stage:"pending_results", assignee:"rocky", notes:"Signed to the guarantee - 4 of 10 quotes delivered so far.", created_at:new Date(Date.now()-86400e3*9).toISOString(), updated_at:new Date(Date.now()-86400e3*1).toISOString() },
    { id:uid(), contact_id:null, contact_name:"Grace Nguyen - Nguyen Dental Studio", title:"Nguyen Dental - Google Ads retainer", value:1800, stage:"closed_won", assignee:"max", notes:"", created_at:new Date(Date.now()-86400e3*6).toISOString(), updated_at:new Date(Date.now()-86400e3*2).toISOString() },
    { id:uid(), contact_id:null, contact_name:"Marlon Reeve - Reeve Builders", title:"Reeve Builders - SEO retainer", value:2600, stage:"closed_won", assignee:"rocky", notes:"", created_at:new Date(Date.now()-86400e3*48).toISOString(), updated_at:new Date(Date.now()-86400e3*42).toISOString() },
    { id:dealKauriRevShare, contact_id:c1, contact_name:"Aroha Ngata", title:"Kauri - Spring listings campaign", contract_type:"revenue_share", percentage:8, value:0, stage:"closed_won", assignee:"rocky", notes:"", created_at:new Date(Date.now()-86400e3*30).toISOString(), updated_at:new Date(Date.now()-86400e3*10).toISOString() },
    { id:uid(), contact_id:null, contact_name:"Sina Tuilagi - Tuilagi Landscaping", title:"Tuilagi Landscaping - Meta Ads", value:1200, stage:"closed_lost", notes:"Went with a cheaper freelancer.", created_at:new Date(Date.now()-86400e3*10).toISOString(), updated_at:new Date(Date.now()-86400e3*8).toISOString() },
  ];
  state.calendarEvents = [
    { id:"demo-1", summary:"Discovery call - Reeve Builders", start:{ dateTime:new Date(Date.now()+3600e3*3).toISOString() }, end:{ dateTime:new Date(Date.now()+3600e3*3.5).toISOString() }, attendees:[{ email:"marlon@reevebuilders.co.nz" }] },
    { id:"demo-2", summary:"Internal pipeline review", start:{ dateTime:new Date(Date.now()+86400e3*1).toISOString() }, end:{ dateTime:new Date(Date.now()+86400e3*1+3600e3).toISOString() }, attendees:[{ email:"rockyoneill02@gmail.com" }] },
  ];
  state.regions = [
    { id:uid(), region:"Auckland CBD", calls_made:64, meetings_booked:6, notes:"Worked through the Queen St + Britomart lists.", created_at:new Date(Date.now()-86400e3*12).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), region:"North Shore", calls_made:38, meetings_booked:2, notes:"Started this week, more to go.", created_at:new Date(Date.now()-86400e3*3).toISOString(), updated_at:new Date().toISOString() },
  ];
  const graceProspectId = uid();
  state.prospects = [
    { id:uid(), name:"Marlon Reeve", phone:"021 555 0111", company:"Reeve Builders", email:"marlon@reevebuilders.co.nz", website:"reevebuilders.co.nz", google_rating:"4.8 (63)", region:"Auckland CBD", industry:"Construction", calls_made:1, last_called_at:new Date(Date.now()-3600e3*2).toISOString(), last_outcome:"no_answer", last_called_by:"max@mrpriceless.co.nz", snoozed_until:new Date(Date.now()+86400e3*1).toISOString(), notes:"[Aug 3, 1:30pm - max] No Answer: Left voicemail, said to try after 3pm.", created_by:"max@mrpriceless.co.nz", created_at:new Date(Date.now()-86400e3*3).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), name:"Sina Tuilagi", phone:"022 555 0133", company:"Tuilagi Landscaping", email:"", website:"", google_rating:"4.5 (21)", region:"North Shore", industry:"Landscaping", calls_made:0, last_called_at:null, last_outcome:null, last_called_by:null, snoozed_until:null, notes:"", created_by:"rocky@mrpriceless.co.nz", created_at:new Date(Date.now()-86400e3*1).toISOString(), updated_at:new Date().toISOString() },
    { id:graceProspectId, name:"Grace Nguyen", phone:"027 555 0166", company:"Nguyen Dental Studio", email:"grace@nguyendental.co.nz", website:"nguyendental.co.nz", region:"Auckland CBD", industry:"", calls_made:2, last_called_at:new Date(Date.now()-86400e3*2).toISOString(), last_outcome:"call_back", last_called_by:"rocky@mrpriceless.co.nz", snoozed_until:null, notes:"[Aug 3, 9:00am - rocky] Call Back: Wants a call back next week once their new hygienist starts.", created_by:"rocky@mrpriceless.co.nz", created_at:new Date(Date.now()-86400e3*1).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), name:"M. Reeve", phone:"021 555 0111", company:"Reeve Builders Ltd", email:"", website:"", region:"North Shore", industry:"Construction", calls_made:0, last_called_at:null, last_outcome:null, last_called_by:null, snoozed_until:null, notes:"", created_by:"bailey@mrpriceless.co.nz", created_at:new Date(Date.now()-86400e3*2).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), name:"", phone:"022 555 0177", company:"Coastal Concrete Ltd", email:"", website:"", region:"", industry:"Construction", calls_made:1, last_called_at:new Date(Date.now()-86400e3*4).toISOString(), last_outcome:"not_interested", last_called_by:"max@mrpriceless.co.nz", snoozed_until:null, notes:"[Aug 2, 2:15pm - max] Not Interested: Already locked into a contract with another agency until next year.", created_by:"rocky@mrpriceless.co.nz", created_at:new Date().toISOString(), updated_at:new Date().toISOString() },
  ];
  const cl1 = uid(), cl2 = uid();
  state.clients = [
    { id:cl1, name:"Kauri Property Group", notes:"Real estate. Wants weekly listing videos.", cost_per_lead:38, monthly_ad_spend:1250, meta_ad_account_id:"act_1234567890", report_email:"aroha@kauriproperty.co.nz", report_frequency:"monthly", last_report_sent_at:new Date(Date.now()-86400e3*32).toISOString(), created_at:new Date(Date.now()-86400e3*60).toISOString(), updated_at:new Date().toISOString(),
      services:"Meta Ads management, weekly listing video content, monthly performance report.",
      client_rules:"All creative needs sign-off from Aroha before it goes live. No posting on Fridays (open home day). CC her PA on every email.",
      qualified_lead_structure:"Full name, phone number, and confirmed budget range. Must have viewed at least one listing page before enquiring.",
      branding_expectations:"Warm, premium tone. Gold/cream palette matching their logo. Never use stock photos - only their own listing photography.",
      key_contacts:"Aroha Ngata - Owner, final approval on everything. Reachable by phone, prefers calls over email.",
      communication_preferences:"Weekly check-in call every Monday. Slack for anything urgent same-day.",
      renewal_date:new Date(Date.now()+86400e3*45).toISOString().slice(0,10),
      stage:"established", stage_changed_at:new Date(Date.now()-86400e3*20).toISOString() },
    { id:cl2, name:"Summit Dental", notes:"Healthcare. Focused on Meta lead ads.", cost_per_lead:22, monthly_ad_spend:1250, meta_ad_account_id:"", report_email:"", report_frequency:"monthly", last_report_sent_at:null, created_at:new Date(Date.now()-86400e3*40).toISOString(), updated_at:new Date().toISOString(),
      services:"Meta Ads lead generation.",
      client_rules:"",
      qualified_lead_structure:"Name and phone number, must live within 15km of the practice.",
      branding_expectations:"Clean, clinical, trustworthy. Blue/white palette. Avoid anything that looks too salesy.",
      key_contacts:"Ben Whitfield - Practice manager, main point of contact.",
      communication_preferences:"Email preferred. Monthly report call.",
      renewal_date:new Date(Date.now()+86400e3*8).toISOString().slice(0,10),
      stage:"month_1", stage_changed_at:new Date(Date.now()-86400e3*35).toISOString() },
    { id:uid(), name:"Chand Legal", notes:"Just signed, kicking off this week.", cost_per_lead:null, monthly_ad_spend:1250, meta_ad_account_id:"", report_email:"", report_frequency:"monthly", last_report_sent_at:null, created_at:new Date(Date.now()-86400e3*5).toISOString(), updated_at:new Date().toISOString(),
      services:"SEO + Google Ads.",
      client_rules:"",
      qualified_lead_structure:"",
      branding_expectations:"",
      key_contacts:"Priya Chand - Owner.",
      communication_preferences:"",
      renewal_date:null,
      stage:"onboarding", stage_changed_at:new Date(Date.now()-86400e3*5).toISOString(),
      onboarding_progress:{ "0_0":true, "0_1":true, "0_2":true, "1_0":true } },
    { id:uid(), name:"Reeve Builders", notes:"On the 10 quote guarantee - 4 of 10 delivered so far.", cost_per_lead:65, monthly_ad_spend:1250, meta_ad_account_id:"", report_email:"", report_frequency:"monthly", last_report_sent_at:new Date(Date.now()-86400e3*5).toISOString(), created_at:new Date(Date.now()-86400e3*140).toISOString(), updated_at:new Date().toISOString(),
      services:"Meta Ads + SEO, quote guarantee.",
      client_rules:"",
      qualified_lead_structure:"",
      branding_expectations:"",
      key_contacts:"Marlon Reeve - Owner.",
      communication_preferences:"",
      renewal_date:new Date(Date.now()+86400e3*20).toISOString().slice(0,10),
      stage:"quote_guarantee", quote_target:10, quotes_sent:4, stage_changed_at:new Date(Date.now()-86400e3*10).toISOString() },
  ];
  state.clientContent = [
    { id:uid(), client_id:cl1, type:"video", status:"idea", title:"Listing walkthrough - 14 Marama Rd", directions:"Golden hour, drone opening shot, 45-60s.", script:"", notes:"", created_at:new Date(Date.now()-86400e3*2).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl1, type:"script", status:"scripting", title:"\"5 signs it's time to sell\" talking-head", directions:"", script:"Hook: Most people wait too long to sell. Here's how to know...", notes:"", created_at:new Date(Date.now()-86400e3*5).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl1, type:"video", status:"posted", title:"Open home recap - Britomart apartment", directions:"", script:"", notes:"Posted to IG + FB, did well.", created_at:new Date(Date.now()-86400e3*12).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl2, type:"video", status:"filming", title:"Patient testimonial - Whitening results", directions:"Shoot in the new chair, natural light near window.", script:"", notes:"", created_at:new Date(Date.now()-86400e3*3).toISOString(), updated_at:new Date().toISOString() },
  ];
  const campAucklandLeadGen = uid();
  state.campaigns = [
    { id:campAucklandLeadGen, client_id:cl1, name:"Auckland listings - lead gen", platform:"Meta", status:"active", cost_per_lead:35, notes:"", created_at:new Date(Date.now()-86400e3*18).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl1, name:"Retargeting - open home visitors", platform:"Meta", status:"active", cost_per_lead:22, notes:"", created_at:new Date(Date.now()-86400e3*9).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl1, name:"Google Search - suburb keywords", platform:"Google", status:"paused", cost_per_lead:58, notes:"Paused, CPL too high vs Meta.", created_at:new Date(Date.now()-86400e3*30).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), client_id:cl2, name:"Whitening promo - lead gen", platform:"Meta", status:"active", cost_per_lead:19, notes:"", created_at:new Date(Date.now()-86400e3*6).toISOString(), updated_at:new Date().toISOString() },
  ];
  state.adCreatives = [
    { id:uid(), client_id:cl1, campaign_id:campAucklandLeadGen, name:"Drone listing reel v1", result:"winner", notes:"Lowest CPL so far, keep scaling.", meta_ad_id:"120211234567890123", impressions:18420, clicks:512, spend:284.50, results:11, cost_per_result:25.86, insights_updated_at:new Date(Date.now()-3600e3*3).toISOString(), created_at:new Date(Date.now()-86400e3*20).toISOString() },
    { id:uid(), client_id:cl1, campaign_id:campAucklandLeadGen, name:"Static \"just sold\" carousel", result:"killed", meta_ad_id:"120211234567890124", impressions:9310, clicks:118, spend:96.20, results:2, cost_per_result:48.10, insights_updated_at:new Date(Date.now()-86400e3*14).toISOString(), notes:"CTR too low, paused after 3 days.", created_at:new Date(Date.now()-86400e3*15).toISOString() },
    { id:uid(), client_id:cl2, name:"Before/after smile carousel", result:"testing", notes:"", created_at:new Date(Date.now()-86400e3*2).toISOString() },
  ];
  state.clientLeads = [
    { id:uid(), client_id:cl1, external_lead_id:"1001", name:"Renee Ford", email:"renee.ford@example.com", phone:"021 555 0201", status:"Qualified", form_name:"Free Appraisal Form", lead_created_at:new Date(Date.now()-86400e3*3).toISOString(), imported_at:new Date(Date.now()-86400e3*1).toISOString() },
    { id:uid(), client_id:cl1, external_lead_id:"1002", name:"Tama Wiremu", email:"tama.w@example.com", phone:"021 555 0202", status:"Intake", form_name:"Free Appraisal Form", lead_created_at:new Date(Date.now()-86400e3*2).toISOString(), imported_at:new Date(Date.now()-86400e3*1).toISOString() },
    { id:uid(), client_id:cl1, external_lead_id:"1003", name:"Hana Wilson", email:"hana.wilson@example.com", phone:"021 555 0203", status:"DQ'd", form_name:"Free Appraisal Form", lead_created_at:new Date(Date.now()-86400e3*4).toISOString(), imported_at:new Date(Date.now()-86400e3*1).toISOString() },
    { id:uid(), client_id:cl2, external_lead_id:"2001", name:"Jordan Lee", email:"jordan.lee@example.com", phone:"027 555 0301", status:"Intake", form_name:"Whitening Promo Form", lead_created_at:new Date(Date.now()-86400e3*1).toISOString(), imported_at:new Date(Date.now()-86400e3*1).toISOString() },
    { id:uid(), client_id:cl2, external_lead_id:"2002", name:"Amy Zhang", email:"amy.zhang@example.com", phone:"027 555 0302", status:"Qualified", form_name:"Whitening Promo Form", lead_created_at:new Date(Date.now()-86400e3*5).toISOString(), imported_at:new Date(Date.now()-86400e3*1).toISOString() },
  ];
  state.dealContacts = [];
  state.tasks = [
    { id:uid(), title:"Send Kauri contract for signature", notes:"", due_date:new Date(Date.now()+86400e3*1).toISOString().slice(0,10), priority:"high", assignee:"rocky", status:"open", contact_id:c1, deal_id:deal1, created_at:new Date(Date.now()-86400e3*2).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), title:"Follow up with Priya Chand re: proposal", notes:"She wanted pricing broken out by service.", due_date:new Date(Date.now()-86400e3*1).toISOString().slice(0,10), priority:"urgent", assignee:"max", status:"open", contact_id:c3, deal_id:null, created_at:new Date(Date.now()-86400e3*3).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), title:"Prep Summit Dental ad creative review", notes:"", due_date:new Date(Date.now()+86400e3*5).toISOString().slice(0,10), priority:"medium", assignee:"rocky", status:"open", contact_id:c2, deal_id:null, created_at:new Date(Date.now()-86400e3*1).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), title:"Renew domain for agency site", notes:"", due_date:null, priority:"low", assignee:null, status:"open", contact_id:null, deal_id:null, created_at:new Date(Date.now()-86400e3*6).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), title:"Follow up with Grace Nguyen", notes:"Wants a call back next week once their new hygienist starts.", due_date:new Date(Date.now()+86400e3*4).toISOString().slice(0,10), priority:"medium", assignee:"rocky", status:"open", contact_id:null, deal_id:null, prospect_id:graceProspectId, created_at:new Date(Date.now()-86400e3*2).toISOString(), updated_at:new Date().toISOString() },
  ];
  state.clientReports = [
    { id:uid(), client_id:cl1, period_start:new Date(Date.now()-86400e3*62).toISOString().slice(0,10), period_end:new Date(Date.now()-86400e3*32).toISOString().slice(0,10),
      metrics:{ spend:"842.50", impressions:"48210", reach:"21340", clicks:"612", ctr:"1.27", cpc:"1.38", cpm:"17.47", actions:[{action_type:"lead",value:"19"}], cost_per_action_type:[{action_type:"lead",value:"44.34"}] },
      status:"sent", error:null, created_at:new Date(Date.now()-86400e3*32).toISOString() },
  ];
  const pbCold = uid();
  state.playbooks = [
    { id:pbCold, title:"Cold Calling Script", sort_order:0, created_at:new Date(Date.now()-86400e3*20).toISOString(), updated_at:new Date(Date.now()-86400e3*2).toISOString(), content:
`## Goal
Book a qualified meeting - not sell on the phone.

## Opening (First 10 Seconds)
1. Introduce yourself and the business in one breath.
2. State the reason for the call - be direct, not salesy.
3. Ask a permission-based question to keep them on the line.

## The Script
"Hi [Name], this is [Your Name] calling from [Business]. The reason for my call - we help [industry] businesses [core outcome]. Do you have 30 seconds while I explain why I'm calling?"

## Qualifying Questions
- Are you currently running any paid ads or marketing?
- What's working, and what isn't?
- Who handles this for you right now?

## Handling Objections
**"I'm not interested"** - Totally understand, most people say that before they've heard what it actually is. Can I take 20 seconds to explain, then you can tell me to get lost?

**"Send me an email"** - Happy to, but most people don't get round to reading it. Can we lock in 10 minutes so I can walk you through it properly instead?

**"We already have someone doing this"** - Good to hear - out of curiosity, are you happy with the results, or open to a second opinion?

## Closing for the Meeting
1. Suggest two specific times ("Would Tuesday 10am or Wednesday 2pm work better?").
2. Confirm the best contact number and email.
3. Send the calendar invite immediately after the call, while they're still warm.

## After the Call
- Log the outcome in the Dialer straight away.
- If no answer, schedule a follow-up call for 2-3 days later.` },
    { id:uid(), title:"Meetings to Close", sort_order:1, created_at:new Date(Date.now()-86400e3*18).toISOString(), updated_at:new Date(Date.now()-86400e3*1).toISOString(), content:
`## Goal
Turn the booked meeting into a signed client - not just a nice chat.

## Before the Meeting
- Check their website, socials, and current ads (if any).
- Note 2-3 specific things you'd improve for them.
- Have pricing and case studies ready to share.

## Meeting Agenda
1. Rapport (2 min) - light, genuine, not scripted small talk.
2. Context (3 min) - confirm what you already know about their business.
3. Discovery (10 min) - uncover their real pain points.
4. Present the offer (10 min) - tailored to what you just heard, not a generic pitch.
5. Handle objections (5 min).
6. Close (5 min) - ask for the business directly.

## Discovery Questions
- What's your biggest bottleneck for growth right now?
- What have you tried before, and how did it go?
- If this problem was solved, what would that be worth to you?
- What's stopping you from doing this already?

## Presenting the Offer
- Anchor to the pain point they just told you about - not a generic feature list.
- Show 1-2 relevant results or case studies.
- Present pricing clearly and confidently - don't apologise for the price.

## Handling Objections
**"It's too expensive"** - Compared to what? Let's look at what it's costing you to not solve this.

**"I need to think about it"** - Of course - what specifically do you need to think through? Let's talk it through now while it's fresh.

**"I need to check with my partner/team"** - Makes sense. Can we get them on a quick call before we finish up today?

## Closing
1. Ask directly - "Does this make sense to move forward with?"
2. If yes, send the contract or invoice before the call ends if possible.
3. If not yet, agree a specific next step and date, not a vague "I'll follow up."

## After the Meeting
- Send a follow-up summary within 1 hour, even if they said yes.
- Log the outcome and next step in Deals.
- If they went cold, add a follow-up task for 3-5 days later.` },
    { id:uid(), title:"Service Delivery - Ads", sort_order:3, created_at:new Date(Date.now()-86400e3*10).toISOString(), updated_at:new Date().toISOString(), content:
`## Goal
A single reference for everything needed to run and manage a client's ads properly.

## Access Checklist
- Meta Business Manager - added as Partner/Admin on the ad account.
- Google Ads - added as Manager/Standard access.
- Pixel/conversion tracking installed and verified on their website.
- Access to their brand assets (logo, colours, fonts, photos/video).

## Campaign Setup Basics
- Objective matches their actual goal (leads, calls, bookings - not just "awareness").
- Budget matches their cost-per-lead target from Clients.
- Location/audience targeting matches their real service area.
- Tracking is confirmed working with a test conversion before spending real budget.

## Creative Guidelines
- Lead with the outcome/benefit, not the business name.
- Always include a clear call to action (Call Now, Book Now, Get a Quote).
- Use real photos/video where possible - avoid generic stock imagery.
- Keep it on-brand: their colours, tone, and logo where relevant.
- Test at least 2-3 creative variations per campaign.

## Copy Checklist
- Headline states the outcome clearly in under 6 words if possible.
- Primary text addresses a specific pain point or objection.
- Include social proof (reviews, results, "trusted by X clients") where available.
- Always end with a direct, low-friction call to action.

## Ongoing Management
- Check performance at least every 2-3 days for the first 2 weeks of a new campaign.
- Pause underperforming ads early - don't wait a full week if something isn't working.
- Log ad results in Ad Creatives (winner/testing/killed) so history is tracked.
- Never let a campaign run untouched for more than 7 days.

## Reporting
- Confirm report frequency and format matches what's set in Clients.
- Reports should always include spend, results, cost-per-result, and a plain-English summary.
- Flag any issues (rising costs, tracking problems) proactively - don't wait to be asked.` },
    { id:uid(), title:"Objection Handling", sort_order:4, created_at:new Date(Date.now()-86400e3*5).toISOString(), updated_at:new Date(Date.now()-86400e3*5).toISOString(), content:
`## The Golden Rule
Never argue. Agree with the feeling first, then reframe - arguing makes people defend their position harder, agreeing gets them to lower their guard.

## How To Handle Any Objection
1. Acknowledge - "Totally get that" / "Fair enough" / "Makes sense."
2. Isolate - check it's the only thing in the way ("If we sorted that, is there anything else stopping you?").
3. Reframe - answer the real worry behind the words, not just the words themselves.
4. Confirm - ask directly if that resolves it before moving on.

## Cold Call Objections
**"I'm not interested"** - Totally understand, most people say that before they've heard what it actually is. Can I take 20 seconds to explain, then you can tell me to get lost?

**"Send me an email"** - Happy to, but most people don't get round to reading it. Can we lock in 10 minutes so I can walk you through it properly instead?

**"We already have someone doing this"** - Good to hear - out of curiosity, are you happy with the results, or open to a second opinion?

**"How did you get my number?"** - Public business listing - I do a bit of research before I call so I'm not wasting your time on a generic pitch.

**"Now's not a good time"** - No worries at all - when's better, later today or tomorrow morning?

**"We don't have a marketing budget"** - Understood - can I ask, is that because it hasn't worked before, or because it's genuinely not a priority right now?

## Meeting & Closing Objections
**"It's too expensive"** - Compared to what? Let's look at what it's actually costing you to not solve this.

**"I need to think about it"** - Of course - what specifically do you need to think through? Let's talk it through now while it's fresh.

**"I need to check with my partner/team"** - Makes sense. Can we get them on a quick call before we finish up today?

**"We tried ads before and it didn't work"** - What do you think went wrong last time? Listen first, then explain what's different about this approach.

**"Can you guarantee results?"** - Nobody can honestly guarantee outcomes, but I can guarantee the process, the effort, and full transparency along the way. What I can show you is what's happened for clients in a similar position.

**"I've been burned by an agency before"** - That's exactly why we report weekly and don't lock people into long contracts. What happened last time, so I make sure we don't repeat it?

## Timing Objections
**"Call me back next month/quarter"** - Happy to - can I ask what changes for you then that doesn't apply right now?

**"We're too busy to start something new"** - That's actually usually the best time - the busier you get without a system, the more that gap costs you. What if we set it up now and it runs in the background?

**"Let's revisit after the holidays/season"** - Sounds good - can we lock a specific date in now so it doesn't slip past both of us?

## Price & Contract Objections
**"Can you do it cheaper?"** - The price reflects what it actually takes to get you the result - if I cut corners, I'd be selling you a worse outcome. What's the real concern, budget or value?

**"What if I want to cancel?"** - Explain the actual terms honestly. The goal is you staying because it's working, not because you're locked in.

**"Why is it a monthly retainer, not a one-off?"** - Because results compound over time - one-off work gets you a short spike, ongoing work builds something that keeps growing.

## Reminders
- Silence after a rebuttal is powerful - resist the urge to fill it by talking more.
- If someone objects twice on the exact same thing, that's usually the real issue - dig one level deeper.
- Never sound rehearsed - use these as a guide for the idea, not a script to recite word for word.` },
    { id:uid(), title:"Sales Techniques", sort_order:5, created_at:new Date(Date.now()-86400e3*5).toISOString(), updated_at:new Date(Date.now()-86400e3*5).toISOString(), content:
`## Tone & Delivery
- Smile before you dial - it changes your voice, and they can hear it.
- Slow down - nervous energy speeds up your speech, and a rushed caller sounds unsure.
- Match their energy, don't fight it - a calm prospect gets a calm you, an energetic one gets energy back.

## The Assumptive Frame
- Speak like the meeting is already happening ("When we jump on Tuesday..." not "If you're interested, maybe we could...").
- Assumptive language removes the "should I even bother" decision from the prospect's side of the conversation.

## Active Listening
- Use their own words back to them when presenting the offer - it proves you were actually listening, not just waiting to talk.
- Don't interrupt to sell - let them finish the sentence, then respond to what they actually said.
- Take notes during discovery so you can reference specifics later in the call or meeting.

## Silence Is A Tool
- After asking a big question (price, close), stop talking. The first person to speak after a big ask usually loses leverage.
- A pause feels longer to you than it does to them - count to three in your head before jumping in.

## The Takeaway Technique
- If someone's stalling, it can help to gently take the offer away ("No worries if now's not right - we're pretty booked up for new clients this month anyway").
- This can flip a hesitant prospect from passive to actively wanting back in.

## Framing Price
- Always present price after value, never before.
- Use contrast - compare the investment to the cost of the problem continuing, not to "nothing."
- State the price once, clearly, then stop talking. Don't soften it by immediately discounting or apologising.

## Building Instant Rapport
- Use their name naturally, once or twice per call - more than that starts to sound scripted.
- Mirror their pace and formality - a laid-back tradie doesn't want corporate language, and a corporate client doesn't want slang.
- Find one genuine, specific thing to comment on early - something on their website, a recent review, a job you can see they've done.

## Closing Techniques
1. The Direct Close - "Does this make sense to move forward with?" Ask it plainly, then stop talking.
2. The Alternative Close - offer two positive options instead of yes/no ("Would Tuesday or Wednesday work better to get started?").
3. The Summary Close - recap the pain points and outcomes they've already agreed to before asking for the business, so the "yes" feels like the natural next step, not a big leap.

## Quick Reminders For Every Call
- Energy first, script second - a flat voice with perfect words still loses.
- You're not selling, you're finding out if it's a fit - and if it's not, that's fine too.
- Every "no" gets you closer to a "yes" - don't take a knockback personally, it's not about you.` },
  ];
  state.rules = [
    { id:uid(), title:"Meta Ads", sort_order:0, content:"", created_at:new Date(Date.now()-86400e3*10).toISOString(), updated_at:new Date(Date.now()-86400e3*10).toISOString() },
    { id:uid(), title:"Google Ads", sort_order:1, content:"", created_at:new Date(Date.now()-86400e3*10).toISOString(), updated_at:new Date(Date.now()-86400e3*10).toISOString() },
    { id:uid(), title:"Landing Pages & Websites", sort_order:2, content:"", created_at:new Date(Date.now()-86400e3*10).toISOString(), updated_at:new Date(Date.now()-86400e3*10).toISOString() },
    { id:uid(), title:"SEO", sort_order:3, content:"", created_at:new Date(Date.now()-86400e3*10).toISOString(), updated_at:new Date(Date.now()-86400e3*10).toISOString() },
  ];
  state.emailTemplates = [
    { id:uid(), title:"Welcome Email", sort_order:0, created_at:new Date(Date.now()-86400e3*30).toISOString(), updated_at:new Date(Date.now()-86400e3*30).toISOString(),
      subject: "Welcome to Mr Priceless - here's what happens next",
      body:
`Hi [Name],

Welcome aboard - we're genuinely stoked to be working with [Client]. We don't take on just anyone, so it means we're confident we can get you real results.

Here's what happens next:
1. We'll get your onboarding call booked in for this week.
2. Before that call, keep an eye out for your CRM login - that's where you'll see every lead as it comes in.
3. On the call we'll walk you through everything and get your calendar set up so quotes book straight in.

If anything comes up before then, just reply to this email or give us a call.

Looking forward to it,
[Your Name]` },
    { id:uid(), title:"Onboarding Call Confirmation", sort_order:1, created_at:new Date(Date.now()-86400e3*25).toISOString(), updated_at:new Date(Date.now()-86400e3*25).toISOString(),
      subject: "Confirmed - your onboarding call [Date] at [Time]",
      body:
`Hi [Name],

Confirming our onboarding call for [Date] at [Time].

Quick heads up on what we'll cover:
- What a great lead looks like for you (budget, job size, region)
- Getting your Google Calendar set up so quotes book straight into your free time
- A walkthrough of the CRM - it's genuinely simple, just a couple of sections to know
- Your login and how the automated text notifications work

Should only take about 30 minutes. Talk soon,
[Your Name]` },
    { id:uid(), title:"Monthly Report Cover Note", sort_order:2, created_at:new Date(Date.now()-86400e3*10).toISOString(), updated_at:new Date(Date.now()-86400e3*10).toISOString(),
      subject: "[Client] - your [Month] results",
      body:
`Hi [Name],

Your [Month] report is attached - here's the quick summary:

- Ad spend: $[Spend]
- Leads generated: [Leads]
- Cost per lead: $[CPL]

[One or two lines on what's working, what we're testing next, and any recommendation.]

Let me know if you want to jump on a call to go through it in more detail.

Cheers,
[Your Name]` },
  ];
  state.expenses = [
    { id:uid(), title:"Meta + Google Ads platform fees", category:"software", amount:49, frequency:"monthly", expense_date:new Date(Date.now()-86400e3*3).toISOString().slice(0,10), notes:"", created_at:new Date(Date.now()-86400e3*90).toISOString(), updated_at:new Date(Date.now()-86400e3*3).toISOString() },
    { id:uid(), title:"CRM hosting (Supabase + Cloudflare)", category:"software", amount:35, frequency:"monthly", expense_date:new Date(Date.now()-86400e3*5).toISOString().slice(0,10), notes:"", created_at:new Date(Date.now()-86400e3*90).toISOString(), updated_at:new Date(Date.now()-86400e3*5).toISOString() },
    { id:uid(), title:"Twilio calling minutes", category:"software", amount:60, frequency:"monthly", expense_date:new Date(Date.now()-86400e3*4).toISOString().slice(0,10), notes:"", created_at:new Date(Date.now()-86400e3*60).toISOString(), updated_at:new Date(Date.now()-86400e3*4).toISOString() },
    { id:uid(), title:"Video editor - contractor retainer", category:"contractors", amount:600, frequency:"monthly", expense_date:new Date(Date.now()-86400e3*6).toISOString().slice(0,10), notes:"Edits creative for all clients.", created_at:new Date(Date.now()-86400e3*45).toISOString(), updated_at:new Date(Date.now()-86400e3*6).toISOString() },
    { id:uid(), title:"New MacBook for editing", category:"office", amount:2800, frequency:"one_off", expense_date:new Date(Date.now()-86400e3*12).toISOString().slice(0,10), notes:"", created_at:new Date(Date.now()-86400e3*12).toISOString(), updated_at:new Date(Date.now()-86400e3*12).toISOString() },
    { id:uid(), title:"Contractor - one-off landing page build", category:"contractors", amount:450, frequency:"one_off", expense_date:new Date(Date.now()-86400e3*20).toISOString().slice(0,10), notes:"", created_at:new Date(Date.now()-86400e3*20).toISOString(), updated_at:new Date(Date.now()-86400e3*20).toISOString() },
    { id:uid(), title:"Kauri revenue share - Spring listings campaign", type:"profit", deal_id:dealKauriRevShare, amount:340, frequency:"one_off", expense_date:new Date(Date.now()-86400e3*2).toISOString().slice(0,10), notes:"8% of campaign revenue for the month.", created_at:new Date(Date.now()-86400e3*2).toISOString(), updated_at:new Date(Date.now()-86400e3*2).toISOString() },
  ];

  const seedMonday = startOfWeek(new Date());
  const seedToday = new Date(); seedToday.setHours(0,0,0,0);
  const daysSoFar = Math.floor((seedToday - seedMonday) / 86400e3) + 1;
  const perDayCalls = { rocky:[22,19,25,18,24,20,0], max:[15,20,17,22,19,14,0] };
  const perDayMeetings = { rocky:[2,1,3,2,2,1,0], max:[1,2,1,3,2,1,0] };
  const convoRatio = { rocky:0.32, max:0.28 };
  const callActivitySeed = [];
  for (let i=0;i<daysSoFar;i++){
    const d = new Date(seedMonday); d.setDate(seedMonday.getDate()+i);
    const dateStr = d.toISOString().slice(0,10);
    ["rocky","max"].forEach(person => {
      const calls = perDayCalls[person][i] ?? 0;
      const meetings = perDayMeetings[person][i] ?? 0;
      const conversations = Math.round(calls * convoRatio[person]);
      callActivitySeed.push({ id:uid(), person, activity_date:dateStr, calls, conversations, meetings_booked:meetings, created_at:d.toISOString(), updated_at:d.toISOString() });
    });
  }
  state.callActivity = callActivitySeed;
  state.playbookUsage = [
    { id:uid(), person:"rocky", month:monthKey(new Date()), playbook_id:pbCold, created_at:new Date().toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), person:"max", month:monthKey(new Date()), playbook_id:pbCold, created_at:new Date().toISOString(), updated_at:new Date().toISOString() },
  ];
  state.teamFocus = { rocky:null, max:"Landscaping", bailey:null, gabriel:null, raheem:null, thor:null };
}

/* ───────── Data layer ───────── */
const DataLayer = {
  async fetchAll(){
    if (!IS_CONFIGURED){ return; }
    const [c, cc, d, r, p, cl, ccon, cad, camp, dc, tk, crep, nt, pb, ru, et, ex, ca, pu, tf, cws, clead] = await Promise.all([
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
      supabase.from("playbooks").select("*").order("sort_order",{ascending:true}),
      supabase.from("rules").select("*").order("sort_order",{ascending:true}),
      supabase.from("email_templates").select("*").order("sort_order",{ascending:true}),
      supabase.from("expenses").select("*").order("expense_date",{ascending:false}),
      supabase.from("call_activity").select("*").order("activity_date",{ascending:false}),
      supabase.from("playbook_usage").select("*").order("month",{ascending:false}),
      supabase.from("team_focus").select("*"),
      supabase.from("creative_weekly_snapshots").select("*"),
      supabase.from("client_leads").select("*").order("created_at",{ascending:false}),
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
    state.playbooks = pb.data || [];
    state.rules = ru.data || [];
    state.emailTemplates = et.data || [];
    state.expenses = ex.data || [];
    state.callActivity = ca.data || [];
    state.playbookUsage = pu.data || [];
    state.teamFocus = { rocky: null, max: null, bailey: null, gabriel: null, raheem: null, thor: null };
    (tf.data || []).forEach(row => { state.teamFocus[row.person] = row.industry || null; });
    state.creativeSnapshots = cws.data || [];
    state.clientLeads = clead.data || [];
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
    stateArray(table)?.unshift(data);
    renderAll();
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
    const arr = stateArray(table);
    const idx = arr ? arr.findIndex(x => x.id === id) : -1;
    if (idx > -1) arr[idx] = data;
    renderAll();
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
    const arr = stateArray(table);
    const idx = arr ? arr.findIndex(x => x.id === id) : -1;
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
  }
};
function stateArray(table){
  return {
    contacts: state.contacts, cold_calls: state.coldCalls, deals: state.deals,
    prospecting_regions: state.regions, dial_prospects: state.prospects,
    clients: state.clients, client_content: state.clientContent, client_ad_creatives: state.adCreatives,
    client_campaigns: state.campaigns, deal_contacts: state.dealContacts, tasks: state.tasks,
    client_reports: state.clientReports, notes: state.notes, playbooks: state.playbooks,
    rules: state.rules, email_templates: state.emailTemplates,
    expenses: state.expenses, call_activity: state.callActivity, playbook_usage: state.playbookUsage,
    client_leads: state.clientLeads,
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
    .on("postgres_changes", { event:"*", schema:"public", table:"playbooks" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"rules" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"email_templates" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"expenses" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"call_activity" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"playbook_usage" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"creative_weekly_snapshots" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"team_focus" }, async () => { await DataLayer.fetchAll(); renderAll(); })
    .on("postgres_changes", { event:"*", schema:"public", table:"client_leads" }, async () => { await DataLayer.fetchAll(); renderAll(); })
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
    checkOverdueTasksPopup();
    return;
  }
  const { data:{ session } } = await supabase.auth.getSession();
  if (session) await handleSignedIn(session);
  else showAuth();

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "PASSWORD_RECOVERY"){
      showResetPassword();
    } else if (event === "SIGNED_IN" && session){
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
  checkOverdueTasksPopup();
  loadCalendarWeek();
}

async function isAllowlisted(email){
  const { data } = await supabase.from("allowlist").select("email").eq("email", email).maybeSingle();
  return Boolean(data);
}

function showAuth(){
  $("#auth-screen").style.display = "flex";
  $("#unauthorized-screen").style.display = "none";
  $("#reset-password-screen").style.display = "none";
  $("#app").classList.remove("visible");
}
function showUnauthorized(email){
  $("#auth-screen").style.display = "none";
  $("#unauthorized-screen").style.display = "flex";
  $("#reset-password-screen").style.display = "none";
  $("#app").classList.remove("visible");
  $("#unauthorized-email").textContent = email;
}
function showResetPassword(){
  $("#auth-screen").style.display = "none";
  $("#unauthorized-screen").style.display = "none";
  $("#reset-password-screen").style.display = "flex";
  $("#app").classList.remove("visible");
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
  // setupNav() ran at page load before state.user existed, so the delivery
  // workspace restriction needs re-checking now that we know who's signed in.
  applyWorkspace();
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
    $("#forgot-password-btn").style.display = mode === "signin" ? "" : "none";
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

  $("#forgot-password-btn")?.addEventListener("click", async () => {
    const errBox = $("#auth-error");
    const msgBox = $("#auth-message");
    errBox.classList.remove("visible");
    msgBox.classList.remove("visible");
    const email = $("#auth-email").value.trim();
    if (!email){
      errBox.textContent = "Enter your email above first, then click Forgot password?.";
      errBox.classList.add("visible");
      return;
    }
    if (!IS_CONFIGURED){
      msgBox.textContent = "Demo mode - password reset needs a connected Supabase project.";
      msgBox.classList.add("visible");
      return;
    }
    const btn = $("#forgot-password-btn");
    const originalText = btn.textContent;
    btn.textContent = "Sending...";
    btn.disabled = true;
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
      });
      if (error) throw error;
      msgBox.textContent = `If an account exists for ${email}, a reset link is on its way - check your inbox.`;
      msgBox.classList.add("visible");
    } catch (err){
      errBox.textContent = err.message || "Couldn't send the reset email.";
      errBox.classList.add("visible");
    } finally {
      btn.textContent = originalText;
      btn.disabled = false;
    }
  });

  $("#reset-password-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const errBox = $("#reset-password-error");
    errBox.classList.remove("visible");
    const password = $("#reset-password-input").value;
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;
      alert("Password updated - you're all set.");
      location.reload();
    } catch (err){
      errBox.textContent = err.message || "Couldn't update your password.";
      errBox.classList.add("visible");
    }
  });
}

/* ───────── Navigation ───────── */
const WORKSPACE_KEY = "mp_workspace";
const WORKSPACE_COPY = {
  sales: { title: "Sales", sub: "Prospecting, booking meetings, and closing deals.", dashboardTitle: "Dashboard", dashboardSub: "MRR and closed won jobs at a glance." },
  delivery: { title: "Service Delivery", sub: "Onboarding, delivering, and reporting for won clients.", dashboardTitle: "Dashboard", dashboardSub: "Client health and delivery at a glance." },
};
function getWorkspace(){ return localStorage.getItem(WORKSPACE_KEY) || "sales"; }
function setWorkspace(w){
  try { localStorage.setItem(WORKSPACE_KEY, w); } catch(e){}
  applyWorkspace();
}
function applyWorkspace(){
  let ws = getWorkspace();
  if (ws === "delivery" && !canAccessDelivery()){
    ws = "sales";
    try { localStorage.setItem(WORKSPACE_KEY, ws); } catch(e){}
  }
  const select = $("#workspace-select");
  if (select){
    select.value = ws;
    const deliveryOption = select.querySelector('option[value="delivery"]');
    if (deliveryOption) deliveryOption.style.display = canAccessDelivery() ? "" : "none";
  }
  document.body.classList.toggle("workspace-sales", ws === "sales");
  document.body.classList.toggle("workspace-delivery", ws === "delivery");
  $$("[data-workspace]").forEach(el => {
    el.style.display = (el.dataset.workspace === "both" || el.dataset.workspace === ws) ? "" : "none";
  });
  const copy = WORKSPACE_COPY[ws] || WORKSPACE_COPY.sales;
  const titleEl = $("#workspace-banner-title");
  const subEl = $("#workspace-banner-sub");
  if (titleEl) titleEl.textContent = copy.title;
  if (subEl) subEl.textContent = copy.sub;
  const dashTitleEl = $("#dashboard-title");
  const dashSubEl = $("#dashboard-sub");
  if (dashTitleEl) dashTitleEl.textContent = copy.dashboardTitle;
  if (dashSubEl) dashSubEl.textContent = copy.dashboardSub;
  // If the page we're on isn't part of this workspace, fall back to Dashboard.
  const activeBtn = $(`.nav-item[data-page="${state.page}"]`);
  const btnWorkspace = activeBtn?.dataset.workspace;
  if (btnWorkspace && btnWorkspace !== "both" && btnWorkspace !== ws){
    $('.nav-item[data-page="dashboard"]')?.click();
  }
}
function setupNav(){
  $("#workspace-select")?.addEventListener("change", (e) => setWorkspace(e.target.value));
  $$(".nav-item[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      state.page = btn.dataset.page;
      $$(".nav-item[data-page]").forEach(b => b.classList.toggle("active", b === btn));
      $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + state.page));
    });
  });
  $("#signout-btn")?.addEventListener("click", async () => {
    if (IS_CONFIGURED) await supabase.auth.signOut();
    else location.reload();
  });
  applyWorkspace();
}

/* ───────── Render: Dashboard ───────── */
function renderDashboard(){
  const closedWon = state.deals.filter(d => d.stage === "closed_won");
  const closedLost = state.deals.filter(d => d.stage === "closed_lost");
  const openDeals = state.deals.filter(d => !CLOSED_STAGES.has(d.stage));
  const wonThisMonth = closedWon.filter(d => sameMonth(d.updated_at || d.created_at));
  const mrr = closedWon.reduce((s,d) => s + Number(d.value||0), 0);
  const pipelineValue = openDeals.reduce((s,d) => s + Number(d.value||0), 0);
  const closedTotal = closedWon.length + closedLost.length;
  const winRate = closedTotal ? Math.round(closedWon.length / closedTotal * 100) : null;

  const monthlyExpenses = monthlyRecurringTotal();
  const netMrr = mrr - monthlyExpenses;

  $("#stat-mrr").textContent = fmtMoney(mrr);
  $("#stat-mrr-sub").textContent = `from ${closedWon.length} closed won job${closedWon.length===1?"":"s"}`;
  $("#stat-net-mrr").textContent = `${fmtMoney(netMrr)}/mo net after ${fmtMoney(monthlyExpenses)} expenses`;
  $("#stat-won-month").textContent = wonThisMonth.length;
  $("#stat-won-month-value").textContent = `${fmtMoney(wonThisMonth.reduce((s,d)=>s+Number(d.value||0),0))} added`;
  $("#stat-won-total").textContent = closedWon.length;
  $("#stat-win-rate").textContent = winRate === null ? "No closed deals yet" : `${winRate}% win rate`;
  $("#stat-pipeline").textContent = fmtMoney(pipelineValue);
  $("#stat-pipeline-sub").textContent = `${openDeals.length} active deal${openDeals.length===1?"":"s"}`;

  const recentWins = [...closedWon].sort((a,b) => new Date(b.updated_at||b.created_at) - new Date(a.updated_at||a.created_at)).slice(0,8);
  $("#closed-won-list").innerHTML = recentWins.length ? recentWins.map(d => `
    <div class="activity-row">
      <div class="activity-dot activity-dot-won"></div>
      <div>
        <div class="activity-text"><b>${escapeHtml(d.title)}</b> - ${fmtMoney(d.value)}/mo</div>
        <div class="activity-time">${escapeHtml(d.contact_name||"No contact")} · Won ${timeAgo(d.updated_at||d.created_at)}</div>
      </div>
    </div>
  `).join("") : emptyState("No closed won jobs yet - move a deal to Closed Won on the Deals board.");

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

  // Service Delivery view: client health & delivery instead of agency revenue
  const activeClients = state.clients.filter(c => c.stage !== "churned");
  const onboardingCount = state.clients.filter(c => c.stage === "onboarding").length;
  const adSpendManaged = activeClients.reduce((s,c) => s + (Number(c.monthly_ad_spend)||0), 0);
  $("#stat-ad-spend-managed").textContent = fmtMoney(adSpendManaged);
  $("#stat-active-clients").textContent = activeClients.length;
  $("#stat-active-clients-sub").textContent = `${onboardingCount} currently onboarding`;

  const health = activeClients.map(c => ({ client: c, alerts: getClientAlerts(c), status: clientHealthStatus(c) }));
  const greenCount = health.filter(x => x.status === "green").length;
  $("#stat-clients-green").textContent = greenCount;
  $("#stat-clients-green-sub").textContent = `of ${activeClients.length} active client${activeClients.length===1?"":"s"}`;
  $("#stat-clients-attention").textContent = health.length - greenCount;

  const healthTbody = $("#dashboard-client-health-tbody");
  if (healthTbody){
    if (!health.length){ healthTbody.innerHTML = `<tr><td colspan="5">${emptyState("No active clients yet.")}</td></tr>`; }
    else {
      const rank = s => s === "red" ? 0 : s === "amber" ? 1 : 2;
      const sorted = [...health].sort((a,b) => rank(a.status) - rank(b.status));
      healthTbody.innerHTML = sorted.map(({client:c, alerts, status}) => {
        const stageInfo = CLIENT_STAGE_MAP[c.stage] || CLIENT_STAGES[0];
        const statusBadge = status === "red" ? `<span class="badge red">At Risk</span>` : status === "amber" ? `<span class="badge gold">Needs Attention</span>` : `<span class="badge green">Green</span>`;
        return `<tr data-id="${c.id}" data-action="view-client" style="cursor:pointer;">
          <td><div class="row-name">${escapeHtml(c.name)}</div></td>
          <td>${statusBadge}</td>
          <td><span class="badge ${stageInfo.cls}">${escapeHtml(stageInfo.label)}</span></td>
          <td>${c.cost_per_lead!=null ? fmtMoney(c.cost_per_lead) : "-"}</td>
          <td>${alerts.length ? escapeHtml(alerts.map(a=>a.text).join(", ")) : "-"}</td>
        </tr>`;
      }).join("");
    }
  }
}
function sameMonth(iso){ const d=new Date(iso), n=new Date(); return d.getMonth()===n.getMonth() && d.getFullYear()===n.getFullYear(); }
function withinDays(iso, days){ return (Date.now()-new Date(iso).getTime()) < days*86400e3; }
function daysSince(iso){ return iso ? Math.floor((Date.now()-new Date(iso).getTime())/86400e3) : null; }
function daysUntil(iso){ return iso ? Math.ceil((new Date(iso+"T00:00:00").getTime()-Date.now())/86400e3) : null; }
const REPORT_FREQUENCY_DAYS = { weekly: 7, monthly: 30 };
function getClientAlerts(c){
  const alerts = [];
  if (c.renewal_date){
    const d = daysUntil(c.renewal_date);
    if (d < 0) alerts.push({ type:"danger", text:`Renewal date passed ${Math.abs(d)}d ago` });
    else if (d <= 14) alerts.push({ type:"warn", text:`Renewal in ${d}d` });
  }
  if (c.report_frequency && c.report_frequency !== "off"){
    const cadence = REPORT_FREQUENCY_DAYS[c.report_frequency] || 30;
    const since = daysSince(c.last_report_sent_at || c.created_at);
    if (since != null && since > cadence + 5) alerts.push({ type:"warn", text:`Report overdue (${since}d since last sent)` });
  }
  const stageInfo = CLIENT_STAGE_MAP[c.stage];
  if (stageInfo?.days){
    const inStage = daysSince(c.stage_changed_at);
    if (inStage != null && inStage > stageInfo.days + 5) alerts.push({ type:"warn", text:`${inStage}d in ${stageInfo.label} - overdue to move on` });
  }
  if (c.stage === "at_risk") alerts.push({ type:"danger", text:"Marked At Risk" });
  return alerts;
}
function clientHealthStatus(c){
  if (c.stage === "at_risk") return "red";
  const alerts = getClientAlerts(c);
  if (alerts.some(a => a.type === "danger")) return "red";
  if (alerts.length) return "amber";
  return "green";
}
function emptyState(msg){ return `<div class="empty-state"><p>${escapeHtml(msg)}</p></div>`; }

/* ───────── Render: Call Analytics (Meetings Booked) ───────── */
function monthKey(d){ return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0"); }
// Calls/meetings/conversion breakdowns now live on the Statistics page -
// this just keeps the one input that isn't a report: which playbook each
// person is actually running with this month.
function renderPlaybookUsagePicker(){
  const wrap = $("#playbook-usage-cards");
  if (!wrap) return;
  const people = Object.keys(ASSIGNEES);
  const thisMonth = monthKey(new Date());
  wrap.innerHTML = people.map(p => {
    const usage = state.playbookUsage.find(u => u.person === p && u.month === thisMonth);
    const options = `<option value="">- Not set -</option>` + state.playbooks.map(pb => `<option value="${pb.id}" ${usage?.playbook_id===pb.id?"selected":""}>${escapeHtml(pb.title)}</option>`).join("");
    return `
      <div class="analytics-person-card">
        <h4>${escapeHtml(ASSIGNEES[p].label)}</h4>
        <div class="field"><label>Playbook used this month</label>
          <select data-playbook-person="${p}">${options}</select>
        </div>
      </div>`;
  }).join("");
}
async function savePlaybookUsage(person, playbookId){
  const thisMonth = monthKey(new Date());
  const existing = state.playbookUsage.find(u => u.person === person && u.month === thisMonth);
  const row = { person, month: thisMonth, playbook_id: playbookId || null, updated_at: new Date().toISOString() };
  if (existing) await DataLayer.update("playbook_usage", existing.id, row);
  else await DataLayer.insert("playbook_usage", row);
  if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll();
}
// Which vertical (industry) each person is focused on right now, so their
// pick of the shared prospect list surfaces at the top for them without
// hiding anything from the rest of the team - keyed by person, not id, so
// this bypasses the generic id-based DataLayer and upserts directly.
async function saveTeamFocus(person, industry){
  if (!ASSIGNEES[person]) return;
  state.teamFocus[person] = industry || null;
  if (IS_CONFIGURED){
    try {
      await supabase.from("team_focus").upsert(
        { person, industry: industry || null, updated_at: new Date().toISOString() },
        { onConflict: "person" }
      );
    } catch(e){ console.error("Couldn't save team focus:", e); }
  }
  renderProspectList();
}
window.CRM_CALL_ACTIVITY = {
  async upsertToday(person, patch){
    if (!person) return;
    const today = new Date().toISOString().slice(0,10);
    let row = state.callActivity.find(r => r.person === person && r.activity_date === today);
    if (!row){
      row = { id: uid(), person, activity_date: today, calls:0, conversations:0, meetings_booked:0 };
      state.callActivity.push(row);
    }
    Object.assign(row, patch, { updated_at: new Date().toISOString() });
    if (IS_CONFIGURED){
      try {
        await supabase.from("call_activity").upsert(
          { person, activity_date: today, calls: row.calls, conversations: row.conversations, meetings_booked: row.meetings_booked, updated_at: row.updated_at },
          { onConflict: "person,activity_date" }
        );
      } catch(e){ console.error("Couldn't sync call activity:", e); }
    }
    renderStatistics();
  },
};
// Switching "Tracking as" on the Meetings Booked page changes whose focus
// vertical should be surfacing at the top of the shared Prospecting list -
// meetings-tracker.js calls this after setActivePerson() so that list
// updates immediately instead of waiting for the next unrelated re-render.
window.CRM_REFRESH_PROSPECTING = function(){
  if (typeof renderProspectList === "function") renderProspectList();
};

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

/* ───────── Book Meeting (Meetings Booked page -> Contact + Deal) ───────── */
async function bookMeeting(name, phone, person, extra={}){
  const digits = phone.replace(/\D/g,"");
  let contact = digits ? state.contacts.find(c => (c.phone||"").replace(/\D/g,"") === digits) : null;
  if (!contact) contact = await DataLayer.insert("contacts", { name, phone, company: extra.company||"", email: extra.email||"", status: "lead" });
  if (!contact) return null;
  const stage = extra.stage || "qualified";
  const deal = await DataLayer.insert("deals", {
    title: `${name} - ${STAGES.find(s => s.key === stage)?.label || "Meeting Booked"}`,
    contact_id: contact.id,
    contact_name: name,
    contract_type: "retainer",
    value: 0,
    percentage: null,
    stage,
    assignee: person || null,
    notes: "",
  });
  return deal;
}
function renderMeetingsPipeline(){
  const tbody = $("#meetings-pipeline-tbody");
  if (!tbody) return;
  const booked = [...state.deals].filter(d => d.stage === "qualified")
    .sort((a,b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 15);
  if (!booked.length){ tbody.innerHTML = `<tr><td colspan="5">${emptyState("No meetings booked yet. Use + Book Meeting above.")}</td></tr>`; return; }
  tbody.innerHTML = booked.map(d => {
    const contact = d.contact_id ? state.contacts.find(c => c.id === d.contact_id) : null;
    const a = ASSIGNEES[d.assignee];
    return `
      <tr>
        <td>${escapeHtml(d.contact_name||d.title)}</td>
        <td>${escapeHtml(contact?.phone||"-")}</td>
        <td>${a ? `<span class="badge ${a.cls}">${a.label}</span>` : "-"}</td>
        <td>${fmtDate(d.created_at)}</td>
        <td style="text-align:right;"><button class="btn ghost" data-action="view-meeting-deal" data-id="${d.id}">View Deal</button></td>
      </tr>`;
  }).join("");
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
function renderDealStageCol(stage){
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
            <span class="deal-value">${dealValueLabel(d)}</span>
            ${d.assignee && ASSIGNEES[d.assignee] ? `<span class="badge ${ASSIGNEES[d.assignee].cls}">${ASSIGNEES[d.assignee].label}</span>` : ""}
            <button class="icon-btn" data-action="delete-deal" data-id="${d.id}" title="Delete">${ICONS.trash}</button>
          </div>
        </div>
      `;}).join("")}
    </div>
  `;
}
function renderDealsList(){
  const board = $("#kanban-board");
  const closedBoard = $("#kanban-board-closed");
  const totalEl = $("#pipeline-total");
  if (totalEl) totalEl.textContent = fmtMoney(state.deals.filter(d => !CLOSED_STAGES.has(d.stage)).reduce((s,d) => s + Number(d.value||0), 0));
  board.innerHTML = STAGES.filter(s => !CLOSED_STAGES.has(s.key)).map(renderDealStageCol).join("");
  if (closedBoard) closedBoard.innerHTML = STAGES.filter(s => CLOSED_STAGES.has(s.key)).map(renderDealStageCol).join("");
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
  $("#deal-detail-value").textContent = dealValueLabel(deal);
  $("#deal-detail-delete").dataset.id = deal.id;
  const assigneeEl = $("#deal-detail-assignee");
  if (assigneeEl){
    const a = ASSIGNEES[deal.assignee];
    assigneeEl.style.display = a ? "" : "none";
    if (a){ assigneeEl.textContent = a.label; assigneeEl.className = `badge ${a.cls}`; }
  }

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
  const boards = [$("#kanban-board"), $("#kanban-board-closed")].filter(Boolean);
  if (!boards.length) return;
  boards.forEach(board => {
    board.querySelectorAll(".deal-card").forEach(card => {
      card.addEventListener("dragstart", (e) => {
        draggedId = card.dataset.id;
        card.classList.add("dragging");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => card.classList.remove("dragging"));
    });
    board.querySelectorAll(".kanban-col").forEach(col => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("dragover"); });
      col.addEventListener("dragleave", () => col.classList.remove("dragover"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.classList.remove("dragover");
        if (!draggedId) return;
        const updated = await DataLayer.update("deals", draggedId, { stage: col.dataset.stage, updated_at: new Date().toISOString() });
        await maybeCreateClientFromDeal(updated);
        await maybeCreateNoShowFollowup(updated);
      });
    });
  });
}

function contactName(id){ return state.contacts.find(c => c.id === id)?.name || ""; }
function clientName(id){ return state.clients.find(c => c.id === id)?.name || ""; }
function dealContactsFor(dealId){
  return state.dealContacts.filter(dc => dc.deal_id === dealId).map(dc => ({
    ...dc, name: contactName(dc.contact_id) || "(deleted contact)",
  }));
}
function toggleDealContractFields(){
  const type = $("#deal-contract-type")?.value || "retainer";
  const valueField = $("#deal-value-field");
  const pctField = $("#deal-percentage-field");
  if (valueField) valueField.style.display = type === "retainer" ? "" : "none";
  if (pctField) pctField.style.display = type === "retainer" ? "none" : "";
}
function toggleClientQuoteTargetField(){
  const field = $("#client-quote-target-field");
  if (field) field.style.display = $("#client-stage")?.value === "quote_guarantee" ? "" : "none";
}
function openEditClientModal(c){
  state.selectedClientId = c.id;
  $("#client-form-id").value = c.id;
  $("#client-name").value = c.name||"";
  $("#client-cpl").value = c.cost_per_lead != null ? c.cost_per_lead : "";
  $("#client-monthly-ad-spend").value = c.monthly_ad_spend != null ? c.monthly_ad_spend : "";
  $("#client-notes").value = c.notes||"";
  $("#client-meta-account").value = c.meta_ad_account_id||"";
  $("#client-ad-start-date").value = c.ad_start_date||"";
  $("#client-report-frequency").value = c.report_frequency||"monthly";
  $("#client-report-email").value = c.report_email||"";
  $("#client-stage").innerHTML = CLIENT_STAGES.map(s => `<option value="${s.key}">${s.label}</option>`).join("");
  $("#client-stage").value = c.stage||"onboarding";
  $("#client-quote-target").value = c.quote_target != null ? c.quote_target : "";
  toggleClientQuoteTargetField();
  $("#client-modal-title").textContent = "Edit Client";
  openModal("client-modal");
}
function toggleExpenseTypeFields(){
  const isProfit = $("#expense-type")?.value === "profit";
  const categoryField = $("#expense-category-field");
  const dealField = $("#expense-deal-field");
  if (categoryField) categoryField.style.display = isProfit ? "none" : "";
  if (dealField) dealField.style.display = isProfit ? "" : "none";
}
function populateExpenseDealSelect(){
  const select = $("#expense-deal-select");
  if (!select) return;
  const profitDeals = state.deals.filter(d => d.stage === "closed_won" && (d.contract_type === "profit_share" || d.contract_type === "revenue_share"));
  select.innerHTML = `<option value="">- No linked job -</option>` + profitDeals.map(d => `<option value="${d.id}">${escapeHtml(d.title)}</option>`).join("");
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
  { key:"booked_meeting", label:"Booked Meeting", cls:"gold" },
];
// Logging a call snoozes a prospect for a few days so it drops out of
// everyone's "ready to call" view - the actual mechanism that stops two
// different reps (or the same rep twice) from calling the same business.
function isSnoozed(p){ return !!p.snoozed_until && new Date(p.snoozed_until) > new Date(); }
// Call Back and Not Interested aren't timer-based cooldowns like the rest -
// they park a prospect out of the callable pool indefinitely (into their own
// Follow Up / Not Interested views) until someone actually logs a fresh call
// against them or hits Reactivate, rather than a snoozed_until date expiring.
function isParked(p){ return p.last_outcome === "call_back" || p.last_outcome === "not_interested"; }
// "Returning" = still on a timer-based cooldown (no_answer cadence, or the
// long booked_meeting snooze) - these flow back into the active pool on
// their own once snoozed_until passes, unlike parked prospects.
function isReturning(p){ return !isParked(p) && isSnoozed(p); }
// The Aus Dialler only ever calls Australian numbers - it reads the country
// straight off the phone number itself (E.164 always starts with the
// country code) rather than a separate field, so it can't drift out of
// sync with what would actually get dialed.
function isAuProspect(p){ return (p.phone||"").startsWith("+61"); }
function dialerFilteredProspects(){
  const f = state.dialerFilter;
  const q = f.search.trim().toLowerCase();
  return state.prospects.filter(p => {
    if (f.region && (p.region||"") !== f.region) return false;
    if (f.industry && (p.industry||"") !== f.industry) return false;
    if (f.caller && (p.last_called_by||"") !== f.caller) return false;
    if (q && ![p.name,p.company,p.notes].some(v => (v||"").toLowerCase().includes(q))) return false;
    return true;
  });
}
function dialerDistinctValues(field){
  return [...new Set(state.prospects.map(p => p[field]).filter(Boolean))].sort();
}
function dialerQueue(){
  // The power dialer only ever wants to surface prospects that are actually
  // callable right now - anyone still cooling down after a recent call stays
  // out of the queue until they're due again, and anyone parked (Follow Up /
  // Not Interested) stays out until someone actions them from those views.
  // It's also Australia-only (see isAuProspect) - the Prospecting master
  // list still shows everyone, this queue just never surfaces the rest.
  return dialerFilteredProspects().filter(isAuProspect).filter(p => !isParked(p) && !isSnoozed(p)).sort((a,b) => {
    const ta = a.last_called_at ? new Date(a.last_called_at).getTime() : -Infinity;
    const tb = b.last_called_at ? new Date(b.last_called_at).getTime() : -Infinity;
    return ta - tb;
  });
}
function renderDialerFilters(){
  const regionSel = $("#dialer-filter-region");
  const industrySel = $("#dialer-filter-industry");
  const auProspects = state.prospects.filter(isAuProspect);
  const auDistinctValues = (field) => [...new Set(auProspects.map(p => p[field]).filter(Boolean))].sort();
  if (regionSel){
    const regions = auDistinctValues("region");
    regionSel.innerHTML = `<option value="">All Regions</option>` + regions.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("");
    regionSel.value = state.dialerFilter.region;
  }
  if (industrySel){
    const industries = auDistinctValues("industry");
    industrySel.innerHTML = `<option value="">All Industries</option>` + industries.map(i => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join("");
    industrySel.value = state.dialerFilter.industry;
  }
}
function renderDialer(){
  renderDialerFilters();
  const filtered = dialerFilteredProspects().filter(isAuProspect);
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
      body.innerHTML = emptyState(filtered.length
        ? "Everyone matching this filter has been called recently - check back once their cooldown's up."
        : "Import a CSV/XLS file or add a prospect to start power dialing.");
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
      tbody.innerHTML = `<tr><td colspan="5">${emptyState(filtered.length ? "Everyone's cooling down - nobody's due for a call right now." : "No prospects yet.")}</td></tr>`;
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
// How long a business drops out of the "ready to call" view after a
// logged call, per outcome - short for "try again soon", long for
// "leave this one alone for a good while". No_answer isn't a flat cooldown -
// see NO_ANSWER_CADENCE_BUSINESS_DAYS below for the 3-touch schedule.
// Call Back and Not Interested aren't timer-based at all any more (see
// isParked) - they're parked until actioned rather than snoozed for N days.
const CALL_COOLDOWN_DAYS = { booked_meeting: 365 };
// The no-answer cadence: call 1 happens the day you dial, call 2 two
// business days after that, call 3 four business days after call 2 - then
// the business gets parked (long cooldown) rather than called forever.
// Indexed by attempt number about to be logged (1st, 2nd, 3rd+ no-answer).
const NO_ANSWER_CADENCE_BUSINESS_DAYS = { 1: 2, 2: 4 };
const NO_ANSWER_PARK_DAYS = 60;
function addBusinessDays(date, days){
  const d = new Date(date);
  let added = 0;
  while (added < days){
    d.setDate(d.getDate() + 1);
    const day = d.getDay(); // 0 = Sunday, 6 = Saturday
    if (day !== 0 && day !== 6) added++;
  }
  return d;
}
// Works out when a prospect should next be callable, given the outcome just
// logged and how many times they'd already been called before this call.
// Returns null for outcomes that park a prospect indefinitely instead of on
// a timer (see isParked) - there's no "next call date" for those, only a
// manual reactivation or a fresh call.
function nextCallDate(outcome, priorCallsMade){
  if (outcome === "call_back" || outcome === "not_interested") return null;
  const now = new Date();
  if (outcome === "no_answer"){
    const attempt = priorCallsMade + 1;
    const businessDays = NO_ANSWER_CADENCE_BUSINESS_DAYS[attempt];
    if (businessDays) return addBusinessDays(now, businessDays);
    return new Date(now.getTime() + NO_ANSWER_PARK_DAYS*86400e3);
  }
  const cooldownDays = CALL_COOLDOWN_DAYS[outcome] ?? 4;
  return new Date(now.getTime() + cooldownDays*86400e3);
}
// call_activity/playbook_usage key people by a short handle (rocky/max/...),
// but dial_prospects attribution is a real login email - this bridges the
// two by taking the part before the @, which only works if everyone's email
// actually starts with their ASSIGNEES key (e.g. bailey@...).
function personKeyFromEmail(email){
  const e = (email||"").toLowerCase();
  if (EMAIL_TO_ASSIGNEE[e]) return EMAIL_TO_ASSIGNEE[e];
  // Fallback for anyone not yet in the explicit map: try the email's local
  // part whole, then just its first "."-separated token.
  const local = e.split("@")[0];
  if (ASSIGNEES[local]) return local;
  const first = local.split(".")[0];
  return ASSIGNEES[first] ? first : null;
}
// Every logged call is a call for analytics purposes; a "Booked Meeting"
// outcome additionally counts as a meeting - same shared counter the
// Meetings Booked page's own tap counters feed into.
async function bumpCallActivity(personKey, outcome){
  if (!personKey) return;
  const today = new Date().toISOString().slice(0,10);
  const existing = state.callActivity.find(r => r.person === personKey && r.activity_date === today);
  const patch = { calls: Number(existing?.calls||0) + 1 };
  if (outcome === "booked_meeting") patch.meetings_booked = Number(existing?.meetings_booked||0) + 1;
  await window.CRM_CALL_ACTIVITY.upsertToday(personKey, patch);
}
// Bridges a Prospecting/Dialer "Booked Meeting" outcome into the real Book
// Meeting form - name/phone/company are already known from the prospect
// record, so there's no reason to make whoever's calling retype them; they
// just confirm assignee/stage and submit to create the actual Contact + Deal.
function openBookMeetingModalFromProspect(p){
  if (!p) return;
  $("#book-meeting-form").reset();
  $("#book-meeting-slot-idx").value = "";
  $("#book-meeting-name").value = p.name || p.company || "";
  $("#book-meeting-phone").value = p.phone || "";
  $("#book-meeting-company").value = p.company || "";
  $("#book-meeting-email").value = p.email || "";
  $("#book-meeting-stage").value = "qualified";
  const assigneeSelect = $("#book-meeting-assignee");
  if (assigneeSelect && window.getActivePerson) assigneeSelect.value = window.getActivePerson();
  openModal("book-meeting-modal");
}
async function logDialOutcome(prospectId, outcome, note, region, followupDate){
  const p = state.prospects.find(x => x.id === prospectId);
  if (!p) return;
  const who = state.user ? state.user.email : "demo";
  const stamp = new Date().toLocaleString("en-NZ", { dateStyle: "medium", timeStyle: "short" });
  const label = OUTCOMES[outcome]?.label || outcome;
  const entry = `[${stamp} - ${who.split("@")[0]}] ${label}${note ? ": " + note : ""}`;
  const priorCallsMade = Number(p.calls_made||0);
  const next = nextCallDate(outcome, priorCallsMade);
  const update = {
    calls_made: priorCallsMade + 1,
    last_called_at: new Date().toISOString(),
    last_outcome: outcome,
    last_called_by: who,
    snoozed_until: next ? next.toISOString() : null,
    notes: [entry, p.notes].filter(Boolean).join("\n\n"),
    updated_at: new Date().toISOString(),
  };
  if (region) update.region = region;
  await DataLayer.update("dial_prospects", prospectId, update);
  await bumpCallActivity(personKeyFromEmail(who), outcome);
  // A Call Back isn't just a cooldown any more - it has to leave behind an
  // actual task, since a follow-up you only remember by stumbling back onto
  // the Follow Up list is a follow-up that gets missed.
  if (outcome === "call_back" && followupDate){
    await DataLayer.insert("tasks", {
      title: `Follow up with ${p.name || p.company || "prospect"}`,
      notes: note || "",
      due_date: followupDate,
      priority: "medium",
      assignee: personKeyFromEmail(who),
      prospect_id: prospectId,
      status: "open",
    });
  }
  // Booking a meeting off a prospect is the whole point of the call - jump
  // straight to the Meetings Booked page and pop the actual Book Meeting
  // form, pre-filled with what we already know about them, so the deal
  // gets created right there instead of just leaving a note that says
  // "booked" with nothing to show for it in the pipeline. The prospect
  // itself is already flagged above (snoozed ~a year out) so it drops out
  // of the call queue and nobody rings them again.
  if (outcome === "booked_meeting"){
    $('.nav-item[data-page="cold-calls"]')?.click();
    openBookMeetingModalFromProspect(p);
  }
  if (!IS_CONFIGURED) return;
  await DataLayer.fetchAll(); renderAll();
}
// Clears a parked prospect (Follow Up / Not Interested) back to a clean
// slate, for when someone was marked into one of those pools by mistake, or
// a business that said no last time is worth trying again. Doesn't touch
// any task that was already created off a Call Back - that task's lifecycle
// is its own thing once it exists.
async function reactivateProspect(id){
  await DataLayer.update("dial_prospects", id, { last_outcome: null, snoozed_until: null });
}
// Shared by the Prospecting row's "Log Call" button and the Dialer's
// one-click outcome buttons - Call Back and Not Interested both need a
// required field filled in (a follow-up date, or a reason why) before they
// can be logged, so both entry points open this same modal instead of the
// Dialer being able to fire them off with no note captured at all.
function openLogCallModal(p, outcome){
  if (!p) return;
  $("#log-call-prospect-id").value = p.id;
  $("#log-call-title").textContent = `Log Call - ${p.name || p.company || "Prospect"}`;
  $("#log-call-outcome").value = outcome || "no_answer";
  $("#log-call-notes").value = "";
  const followupInput = $("#log-call-followup-date");
  if (followupInput) followupInput.value = "";
  const regionField = $("#log-call-region-field");
  const regionInput = $("#log-call-region");
  const needsRegion = !p.region;
  if (regionField) regionField.style.display = needsRegion ? "" : "none";
  if (regionInput){ regionInput.required = needsRegion; regionInput.value = ""; }
  updateLogCallModalFields();
  openModal("log-call-modal");
}
// Toggles the Log Call modal's outcome-specific fields - a required reason
// for Not Interested, a required follow-up date for Call Back - based on
// whichever outcome is currently selected in the dropdown.
function updateLogCallModalFields(){
  const outcome = $("#log-call-outcome")?.value;
  const notesInput = $("#log-call-notes");
  const notesLabel = $("#log-call-notes-label");
  const followupField = $("#log-call-followup-field");
  const followupInput = $("#log-call-followup-date");
  const hint = $("#log-call-hint");
  const isNotInterested = outcome === "not_interested";
  const isCallBack = outcome === "call_back";
  if (notesInput) notesInput.required = isNotInterested;
  if (notesLabel) notesLabel.textContent = isNotInterested ? "Notes - why aren't they interested? (required)" : "Notes (optional)";
  if (followupField) followupField.style.display = isCallBack ? "" : "none";
  if (followupInput && !isCallBack) followupInput.value = "";
  if (followupInput) followupInput.required = isCallBack;
  if (hint) hint.textContent = isNotInterested
    ? "This moves them into the Not Interested list - they won't show up to call again unless someone reactivates them."
    : isCallBack
    ? "This moves them into the Follow Up list until the task above is done."
    : "This drops them off the \"ready to call\" list for a few days so nobody calls them again too soon.";
}

/* ───────── Twilio Voice (real outbound calling from the Dialer) ───────── */
let voiceDevice = null;
let activeCall = null;
let activeCallProspectId = null;

async function getVoiceDevice(){
  if (voiceDevice) return voiceDevice;
  if (!IS_CONFIGURED){ alert("Connect Supabase first (see README.md) to enable real calling."); return null; }
  if (typeof Twilio === "undefined"){ alert("Calling isn't available: the Twilio Voice SDK failed to load."); return null; }
  const { data, error } = await supabase.functions.invoke("voice-token");
  if (error || !data?.token){ alert("Couldn't start the call: " + (error?.message || "no token returned.")); return null; }
  try {
    voiceDevice = new Twilio.Device(data.token, { codecPreferences: ["opus", "pcmu"] });
    voiceDevice.on("tokenWillExpire", async () => {
      const refreshed = await supabase.functions.invoke("voice-token");
      if (refreshed.data?.token) voiceDevice.updateToken(refreshed.data.token);
    });
    voiceDevice.on("error", (e) => { alert("Call error: " + (e?.message || "unknown error")); endCall(); });
    await voiceDevice.register();
    return voiceDevice;
  } catch (e) {
    voiceDevice = null;
    alert("Couldn't set up calling: " + (e?.message || e));
    return null;
  }
}

function setCallWidget(open, { name, status } = {}){
  const widget = $("#call-widget");
  if (!widget) return;
  widget.classList.toggle("hidden", !open);
  if (name !== undefined) $("#call-widget-name").textContent = name;
  if (status !== undefined) $("#call-widget-status").textContent = status;
}

async function placeCall(phoneRaw, displayName){
  if (activeCall){ alert("You're already on a call. Hang up first."); return false; }
  const digits = toE164(phoneRaw);
  if (!digits){ alert("That doesn't look like a usable phone number."); return false; }
  const device = await getVoiceDevice();
  if (!device) return false;

  setCallWidget(true, { name: displayName, status: "Calling…" });
  try {
    activeCall = await device.connect({ params: { To: digits } });
  } catch (e) {
    alert("Couldn't place the call: " + (e?.message || e));
    setCallWidget(false);
    activeCallProspectId = null;
    return false;
  }

  activeCall.on("accept", () => setCallWidget(true, { status: "In call" }));
  activeCall.on("disconnect", () => endCall());
  activeCall.on("cancel", () => endCall());
  activeCall.on("reject", () => endCall());
  activeCall.on("error", (e) => { alert("Call error: " + (e?.message || "unknown error")); endCall(); });
  return true;
}

async function startCall(prospectId){
  const p = state.prospects.find(x => x.id === prospectId);
  if (!p || !p.phone) return;
  activeCallProspectId = prospectId;
  const ok = await placeCall(p.phone, p.name);
  if (!ok){ activeCallProspectId = null; return; }
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
function looksLikeRating(s){
  const t = String(s||"").trim();
  return /^\d(\.\d)?\s*(★|stars?)?\s*(\(\s*\d+\s*\))?$/i.test(t) || /^\d(\.\d)?\s*\(\d+\)/.test(t);
}
// Combines a separate star-rating cell and review-count cell into one
// display string ("4.8 (63)") - a scrape often puts these in two different
// columns, and only ever reading one of them is how the review count used
// to silently go missing. Falls back gracefully if only one side is present,
// or if the rating cell already has both combined in it.
function combineRating(starsRaw, reviewsRaw){
  const stars = String(starsRaw||"").trim();
  const reviews = String(reviewsRaw||"").trim().replace(/\D/g,"");
  if (looksLikeRating(stars) && /\(\d+\)/.test(stars)) return stars; // already combined
  const starsOnly = stars.match(/^\d(\.\d)?/)?.[0] || (looksLikeRating(stars) ? stars : "");
  if (starsOnly && reviews) return `${starsOnly} (${reviews})`;
  if (looksLikeRating(stars)) return stars;
  if (reviews) return `${reviews} reviews`;
  return "";
}
// Region/industry are no longer parsed out of import columns at all - a
// scrape's "region" column is just as likely to be a street address, and
// there's no way to tell a real region name from an address by shape alone.
// Instead the whole batch gets asked for a single Region + Industry once at
// import time (see promptImportRegionIndustry) and every row gets tagged
// with that, which also means every row in one import shares one clean value
// instead of whatever inconsistent text the source happened to have.
function mapImportRows(rows){
  if (!rows.length) return [];
  const headers = rows[0].map(h => String(h||"").trim().toLowerCase());
  const findCol = (...names) => headers.findIndex(h => names.some(n => h === n || h.includes(n)));
  const nameIdx = findCol("name","full name","contact");
  const phoneIdx = findCol("phone","mobile","number","tel","cell");
  const companyIdx = findCol("company","organisation","organization","business");
  const emailIdx = findCol("email");
  const websiteIdx = findCol("website","url","site","web");
  const ratingIdx = findCol("rating","stars","google");
  const reviewsIdx = findCol("reviews","review count","num reviews","number of reviews");
  // Require at least 2 columns to look like headers, not just 1 - a single
  // business named e.g. "Test Business" would otherwise false-match the
  // "business" company keyword on its own and get mistaken for a header
  // row, silently swallowing the only row on a one-line import.
  const headerMatchCount = [nameIdx,phoneIdx,companyIdx,emailIdx,websiteIdx,ratingIdx,reviewsIdx].filter(i => i > -1).length;
  // No recognisable header row used to fall back to guessing a prospect out
  // of each unlabeled line by sniffing which cell looked like a phone number
  // or a website - but a raw Google Maps scrape is full of stray lines that
  // don't look like anything (review snippets, "Closed - Opens 7am" hours,
  // "Directions"/"Delivery" UI text), and every one of those silently became
  // a fake prospect with no phone number. Rejecting the import outright and
  // asking for header columns is far safer than guessing.
  if (headerMatchCount < 2) return null;

  return rows.slice(1).map(r => ({
    // We never actually know an owner/contact's name from a business
    // listing scrape, so fall back to the business name rather than a
    // fake "Unknown" placeholder - an empty name still renders fine.
    name: (nameIdx>-1 ? String(r[nameIdx]||"").trim() : "") || (companyIdx>-1 ? String(r[companyIdx]||"").trim() : ""),
    phone: phoneIdx>-1 ? String(r[phoneIdx]||"").trim() : "",
    company: companyIdx>-1 ? String(r[companyIdx]||"").trim() : "",
    email: emailIdx>-1 ? String(r[emailIdx]||"").trim() : "",
    website: websiteIdx>-1 ? String(r[websiteIdx]||"").trim() : "",
    google_rating: combineRating(ratingIdx>-1 ? r[ratingIdx] : "", reviewsIdx>-1 ? r[reviewsIdx] : ""),
  })).filter(p => p.name || p.phone);
}
const digitsOnly = (s) => (s||"").replace(/\D/g,"");
// A prospect's identity for dedup purposes: prefer matching on phone number
// (most reliable - different sources format the same number differently,
// hence stripping to digits), falling back to name+company for rows with
// no phone at all (common with a quick Google Maps scrape).
function prospectDedupKey(p){
  const phoneDigits = digitsOnly(p.phone);
  if (phoneDigits) return "phone:" + phoneDigits;
  return "name:" + (p.name||"").trim().toLowerCase() + "|" + (p.company||"").trim().toLowerCase();
}
// Catches duplicates that make it onto the list some other way than
// importProspectRows (manually added, or imported before this existed) -
// same phone number, or same business/contact name, are both grounds for
// a flag. Two callers ending up with the same lead under a different spelling
// is exactly what this needs to catch, so it checks phone and name separately
// rather than requiring both to match.
function prospectDuplicateIds(list){
  const byPhone = {}, byName = {};
  list.forEach(p => {
    const phoneDigits = digitsOnly(p.phone);
    if (phoneDigits) (byPhone[phoneDigits] = byPhone[phoneDigits] || []).push(p);
    const nameKey = (p.company || p.name || "").trim().toLowerCase();
    if (nameKey) (byName[nameKey] = byName[nameKey] || []).push(p);
  });
  const dupeIds = new Set();
  [byPhone, byName].forEach(groups => {
    Object.values(groups).forEach(g => { if (g.length > 1) g.forEach(p => dupeIds.add(p.id)); });
  });
  return dupeIds;
}
// The whole point of a shared list: two different cold callers uploading
// overlapping Google Maps scrapes should never end up with the same lead
// twice, since that's exactly how someone gets called twice by mistake.
async function importProspectRows(prospects){
  if (!prospects.length){ alert("No rows found to import."); return; }
  const existingKeys = new Set(state.prospects.map(prospectDedupKey));
  const seenInBatch = new Set();
  let imported = 0, skipped = 0;
  for (const p of prospects){
    // Imports never had a country-code prompt like the manual Add Prospect
    // form does, so numbers came in exactly as scraped (e.g. "021 555 0111")
    // and only got a country code guessed at call time - normalize to E.164
    // right away instead, so what's on file is what actually gets dialed.
    p.phone = toE164(p.phone);
    const key = prospectDedupKey(p);
    if (existingKeys.has(key) || seenInBatch.has(key)){ skipped++; continue; }
    seenInBatch.add(key);
    await DataLayer.insert("dial_prospects", {
      name: p.name, phone: p.phone, company: p.company, email: p.email, website: p.website||"",
      region: p.region||"", industry: p.industry||"", google_rating: p.google_rating||"",
      calls_made: 0, last_called_at: null, last_outcome: null, last_called_by: null, snoozed_until: null, notes: p.notes||"",
    });
    imported++;
  }
  if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
  const skippedMsg = skipped ? ` ${skipped} skipped - already on the list.` : "";
  alert(`Imported ${imported} prospect${imported===1?"":"s"}.${skippedMsg}`);
}
// Holds a parsed batch between "file selected" and "Region + Industry
// confirmed" - the import itself doesn't run until that modal is
// submitted, since every row in the batch gets tagged with whatever's typed
// in there.
let pendingImportRows = null;
function promptImportRegionIndustry(rows){
  if (rows === null){
    alert("Couldn't find column headers in that list (Name, Phone, Company, Website, Rating, etc.). Add a header row before pasting or importing so each column lands in the right field - raw scrapes with no headers aren't accepted any more, since they were the cause of stray review text and \"Closed - Opens 7am\" lines getting imported as fake prospects.");
    return;
  }
  if (!rows.length){ alert("No rows found to import."); return; }
  pendingImportRows = rows;
  $("#import-details-count").textContent = rows.length;
  $("#import-details-region").value = "";
  $("#import-details-industry").value = "";
  openModal("import-details-modal");
}
function setupProspectFileImport(btnId, inputId){
  const input = $(inputId);
  $(btnId)?.addEventListener("click", () => input.click());
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
        promptImportRegionIndustry(mapImportRows(rows));
      } else {
        const text = await file.text();
        promptImportRegionIndustry(mapImportRows(parseCsv(text)));
      }
    } catch (err){
      alert("Couldn't read that file: " + err.message);
    }
    input.value = "";
  });
}
function setupDialerImport(){
  setupProspectFileImport("#dialer-import-btn", "#dialer-import-input");
  setupProspectFileImport("#prospecting-import-btn", "#prospecting-import-input");
}
// Shared by both file-import buttons: once a list's rows are parsed, this
// asks once for the Region + Industry that the whole batch gets tagged with.
function setupImportRegionIndustryModal(){
  $("#import-details-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const region = $("#import-details-region").value.trim();
    const industry = $("#import-details-industry").value.trim();
    const rows = pendingImportRows || [];
    pendingImportRows = null;
    closeModal("import-details-modal");
    rows.forEach(p => { p.region = region; p.industry = industry; });
    await importProspectRows(rows);
  });
}

/* ───────── Meta Lead Center import (manual CSV, since Meta's Leads Center
   has no API for its own status field - only the raw lead submission is
   ever exposed via Graph API, so a status breakdown can only come from
   whatever CSV a person exports by hand from Leads Center itself) ───────── */
// Meta's Leads Center CSV column names aren't officially documented and
// can vary, so headers are matched by keyword rather than an exact name.
// Exact matches are tried first (across every candidate, in priority order)
// before falling back to substrings, so a generic word like "id" can't
// accidentally grab an unrelated column like "form_id".
function findLeadCol(headers, ...names){
  for (const n of names){ const i = headers.findIndex(h => h === n); if (i > -1) return i; }
  for (const n of names){ const i = headers.findIndex(h => h.includes(n)); if (i > -1) return i; }
  return -1;
}
function toIsoOrNull(s){
  if (!s) return null;
  const t = Date.parse(s);
  return isNaN(t) ? null : new Date(t).toISOString();
}
function mapLeadImportRows(rows){
  if (!rows.length) return null;
  const headers = rows[0].map(h => String(h||"").trim().toLowerCase());
  const idIdx = findLeadCol(headers, "lead id","leadgen_id","lead_id","id");
  const nameIdx = findLeadCol(headers, "full_name","full name","name");
  const emailIdx = findLeadCol(headers, "email");
  const phoneIdx = findLeadCol(headers, "phone_number","phone number","phone","mobile");
  const statusIdx = findLeadCol(headers, "lead_status","lead status","status","stage");
  const formIdx = findLeadCol(headers, "form_name","form name","form_id","form");
  const createdIdx = findLeadCol(headers, "created_time","created time","created","date");
  const matchCount = [idIdx,nameIdx,emailIdx,phoneIdx,statusIdx,formIdx,createdIdx].filter(i => i > -1).length;
  if (matchCount < 2) return null;
  return rows.slice(1).map(r => ({
    external_lead_id: idIdx>-1 ? String(r[idIdx]||"").trim() : "",
    name: nameIdx>-1 ? String(r[nameIdx]||"").trim() : "",
    email: emailIdx>-1 ? String(r[emailIdx]||"").trim() : "",
    phone: phoneIdx>-1 ? String(r[phoneIdx]||"").trim() : "",
    status: statusIdx>-1 ? String(r[statusIdx]||"").trim() : "",
    form_name: formIdx>-1 ? String(r[formIdx]||"").trim() : "",
    created_time: createdIdx>-1 ? String(r[createdIdx]||"").trim() : "",
  })).filter(l => l.name || l.email || l.phone || l.external_lead_id);
}
// A lead's identity for re-import purposes, since exporting overlapping date
// ranges (or the same range twice) should update a lead's status in place
// rather than create a second row for it.
function leadDedupKey(l){
  if (l.external_lead_id) return "id:" + l.external_lead_id;
  const phoneDigits = digitsOnly(l.phone);
  if (phoneDigits) return "phone:" + phoneDigits;
  if (l.email) return "email:" + l.email.trim().toLowerCase();
  return "name:" + (l.name||"").trim().toLowerCase() + "|" + (l.created_time||"");
}
// Loosely buckets whatever raw status text Leads Center exported into the
// three buckets used for reporting. Disqualified is checked before qualified
// since "qualified" is a substring of "disqualified". Anything that doesn't
// match a known label lands in Other rather than being silently miscounted.
function classifyLeadStatus(raw){
  const s = String(raw||"").trim().toLowerCase();
  if (!s) return "Intake";
  if (s.includes("disqualif") || /\bdq\b/.test(s) || s.includes("not interested") || s.includes("not qualif")) return "DQ'd";
  if (s.includes("qualif")) return "Qualified";
  if (s.includes("intake") || s.includes("new")) return "Intake";
  return "Other";
}
let pendingLeadImportRows = null;
function promptLeadImportClient(leads){
  if (!leads || !leads.length){ alert("Couldn't find recognisable columns (name/email/phone/status) in that file."); return; }
  pendingLeadImportRows = leads;
  $("#lead-import-count").textContent = leads.length;
  const select = $("#lead-import-client");
  if (select) select.innerHTML = state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  openModal("lead-import-modal");
}
async function importClientLeads(clientId, leads){
  if (!leads.length){ alert("No rows found to import."); return; }
  const existing = state.clientLeads.filter(l => l.client_id === clientId);
  const byKey = new Map(existing.map(l => [leadDedupKey(l), l]));
  const toInsert = [], toUpdate = [];
  leads.forEach(l => {
    const patch = {
      client_id: clientId, external_lead_id: l.external_lead_id||"", name: l.name||"",
      email: l.email||"", phone: l.phone||"", status: l.status||"",
      form_name: l.form_name||"", lead_created_at: toIsoOrNull(l.created_time),
    };
    const match = byKey.get(leadDedupKey(l));
    if (match) toUpdate.push({ id: match.id, patch });
    else toInsert.push(patch);
  });
  if (!IS_CONFIGURED){
    toInsert.forEach(patch => state.clientLeads.unshift({ id:uid(), imported_at:new Date().toISOString(), ...patch }));
    toUpdate.forEach(({id,patch}) => { const row = state.clientLeads.find(l => l.id === id); if (row) Object.assign(row, patch); });
    renderAll();
  } else {
    if (toInsert.length){
      const { error } = await supabase.from("client_leads").insert(toInsert);
      if (error){ alert("Import failed: " + error.message); return; }
    }
    for (const { id, patch } of toUpdate){
      await supabase.from("client_leads").update(patch).eq("id", id);
    }
    await DataLayer.fetchAll();
    renderAll();
  }
  alert(`Imported ${toInsert.length} new lead${toInsert.length===1?"":"s"}, updated ${toUpdate.length} existing.`);
}
function setupLeadImport(){
  const input = $("#lead-import-input");
  $("#lead-import-btn")?.addEventListener("click", () => input.click());
  input?.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const isExcel = /\.xlsx?$/i.test(file.name);
      let rows;
      if (isExcel){
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
      } else {
        rows = parseCsv(await file.text());
      }
      promptLeadImportClient(mapLeadImportRows(rows));
    } catch (err){
      alert("Couldn't read that file: " + err.message);
    }
    input.value = "";
  });
  $("#lead-import-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const clientId = $("#lead-import-client").value;
    const leads = pendingLeadImportRows || [];
    pendingLeadImportRows = null;
    closeModal("lead-import-modal");
    await importClientLeads(clientId, leads);
  });
}
function renderLeadCenterImport(){
  const tbody = $("#lead-import-tbody");
  if (!tbody) return;
  const byClient = {};
  state.clientLeads.forEach(l => {
    const client = state.clients.find(c => c.id === l.client_id);
    const key = l.client_id;
    if (!byClient[key]) byClient[key] = { name: client ? client.name : "Unknown client", Intake:0, Qualified:0, "DQ'd":0, Other:0, total:0 };
    byClient[key][classifyLeadStatus(l.status)]++;
    byClient[key].total++;
  });
  const rows = Object.values(byClient).sort((a,b) => b.total - a.total);
  const totals = rows.reduce((acc,r) => {
    acc.Intake += r.Intake; acc.Qualified += r.Qualified; acc["DQ'd"] += r["DQ'd"]; acc.Other += r.Other; acc.total += r.total;
    return acc;
  }, { Intake:0, Qualified:0, "DQ'd":0, Other:0, total:0 });

  $("#lead-import-total").textContent = totals.total;
  $("#lead-import-intake").textContent = totals.Intake;
  $("#lead-import-qualified").textContent = totals.Qualified;
  $("#lead-import-dq").textContent = totals["DQ'd"];

  tbody.innerHTML = rows.length ? rows.map(r => `
    <tr>
      <td>${escapeHtml(r.name)}</td>
      <td>${r.Intake}</td>
      <td>${r.Qualified}</td>
      <td>${r["DQ'd"]}</td>
      <td>${r.Other}</td>
      <td><strong>${r.total}</strong></td>
    </tr>
  `).join("") : `<tr><td colspan="6">${emptyState("No leads imported yet - export a CSV from Meta's Leads Center and import it above.")}</td></tr>`;
}

/* ───────── Render: Clients (retention workspace) ───────── */
function clientAvgCPL(){
  const withCpl = state.clients.filter(c => c.cost_per_lead != null && c.cost_per_lead !== "");
  if (!withCpl.length) return null;
  return withCpl.reduce((s,c) => s + Number(c.cost_per_lead||0), 0) / withCpl.length;
}
function campaignsFor(clientId){ return state.campaigns.filter(x => x.client_id === clientId); }
function campaignName(id){ return state.campaigns.find(c => c.id === id)?.name || ""; }
function runningCampaignsFor(clientId){ return campaignsFor(clientId).filter(x => x.status === "active"); }
// Rolls up real Meta-pulled spend/results from a campaign's linked creatives,
// so Ad Spend and CPL reflect live numbers instead of a manual guess.
function campaignAdStats(campaignId){
  const creatives = state.adCreatives.filter(a => a.campaign_id === campaignId && a.spend != null);
  if (!creatives.length) return null;
  const spend = creatives.reduce((s,a) => s + Number(a.spend||0), 0);
  const results = creatives.reduce((s,a) => s + Number(a.results||0), 0);
  return { spend, results, cpl: results > 0 ? spend / results : null, creativeCount: creatives.length };
}
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
  const withAlerts = state.clients.map(c => ({ c, alerts: getClientAlerts(c) })).filter(x => x.alerts.length);
  $("#clients-stat-total").textContent = state.clients.length;
  $("#clients-stat-cpl").textContent = avg != null ? fmtMoney(avg) : "-";
  $("#clients-stat-content").textContent = state.clientContent.length;
  $("#clients-stat-campaigns").textContent = state.campaigns.filter(c => c.status === "active").length;
  const attnEl = $("#clients-stat-attention");
  if (attnEl) attnEl.textContent = withAlerts.length;

  const alertsPanel = $("#clients-alerts-panel");
  if (alertsPanel){
    if (!withAlerts.length){
      alertsPanel.innerHTML = "";
      alertsPanel.style.display = "none";
    } else {
      alertsPanel.style.display = "";
      const sorted = withAlerts.sort((a,b) => {
        const worst = x => x.alerts.some(al=>al.type==="danger") ? 0 : 1;
        return worst(a) - worst(b);
      });
      alertsPanel.innerHTML = `
        <div class="retention-alerts-head">${ICONS.alert} Retention Alerts <span class="kanban-count">${withAlerts.length}</span></div>
        <div class="retention-alerts-list">
          ${sorted.map(({c, alerts}) => `
            <div class="retention-alert-row" data-action="view-client" data-id="${c.id}">
              <div class="retention-alert-name">${escapeHtml(c.name)}</div>
              <div class="retention-alert-tags">
                ${alerts.map(a => `<span class="badge ${a.type==='danger'?'red':'gold'}">${escapeHtml(a.text)}</span>`).join("")}
              </div>
            </div>
          `).join("")}
        </div>
      `;
    }
  }

  const gallery = $("#clients-gallery");
  if (!gallery) return;
  if (!state.clients.length){ gallery.innerHTML = emptyState("No clients yet. Add your first client to get started."); return; }

  const q = state.clientsGallerySearch.trim().toLowerCase();
  gallery.innerHTML = CLIENT_STAGES.map(stage => {
    const clients = state.clients.filter(c => (c.stage||"onboarding") === stage.key)
      .filter(c => !q || (c.name||"").toLowerCase().includes(q))
      .sort((a,b) => (a.name||"").localeCompare(b.name||""));
    if (q && !clients.length) return "";
    const open = state.clientsCollapsedStages.has(stage.key) ? "" : "open";
    return `
      <details class="clients-stage-section" data-stage="${stage.key}" ${open}>
        <summary class="clients-stage-header">
          <span class="clients-stage-dot"></span>
          <h3>${stage.label}</h3>
          <span class="kanban-count">${clients.length}</span>
        </summary>
        <div class="clients-gallery-grid">
          ${clients.length ? clients.map(c => renderClientGalleryCard(c)).join("") : `<div class="empty-state clients-gallery-empty"><p>No clients in this stage.</p></div>`}
        </div>
      </details>
    `;
  }).join("");
  $$(".clients-stage-section", gallery).forEach(section => {
    section.addEventListener("toggle", () => {
      const key = section.dataset.stage;
      if (section.open) state.clientsCollapsedStages.delete(key);
      else state.clientsCollapsedStages.add(key);
    });
  });
}
function renderClientGalleryCard(c){
  const alerts = getClientAlerts(c);
  const pieces = state.clientContent.filter(x => x.client_id === c.id);
  const creatives = state.adCreatives.filter(x => x.client_id === c.id);
  const running = runningCampaignsFor(c.id).length;
  const quotePct = c.quote_target ? Math.min(100, Math.round((Number(c.quotes_sent||0) / c.quote_target) * 100)) : null;
  const profile = clientProfileCompleteness(c);
  const initial = (c.name||"?").trim().charAt(0).toUpperCase();
  return `
    <div class="client-gallery-card">
      <div class="client-gallery-card-top" data-action="view-client" data-id="${c.id}">
        <span class="client-gallery-avatar">${escapeHtml(initial)}</span>
        <div class="client-gallery-head-text">
          <h4>${escapeHtml(c.name)}</h4>
          <div class="client-gallery-cpl">${c.cost_per_lead!=null ? fmtMoney(c.cost_per_lead)+' CPL' : 'No CPL yet'}</div>
        </div>
      </div>
      ${quotePct != null ? `
        <div class="onboarding-progress-bar"><div class="onboarding-progress-fill" style="width:${quotePct}%;"></div></div>
        <div class="onboarding-progress-label">${c.quotes_sent||0} of ${c.quote_target} quotes</div>
      ` : ""}
      <div class="client-gallery-stats" data-action="view-client" data-id="${c.id}">
        <span>${running} running</span>
        <span>${pieces.length} content</span>
        <span>${creatives.length} creative${creatives.length===1?"":"s"}</span>
      </div>
      <div class="client-gallery-profile" data-action="view-client" data-id="${c.id}" title="Client Info completeness">
        <div class="client-info-progress-bar"><div class="client-info-progress-fill" style="width:${profile.pct}%;"></div></div>
        <span class="client-card-profile ${profile.pct===100?'complete':''}">${profile.pct}% profile</span>
      </div>
      ${alerts.length ? `<div class="client-card-alerts">${alerts.map(a=>`<span class="badge ${a.type==='danger'?'red':'gold'}">${escapeHtml(a.text)}</span>`).join("")}</div>` : ""}
      <div class="client-gallery-foot">
        <label>Stage</label>
        <select class="filter-select client-stage-select" data-id="${c.id}">
          ${CLIENT_STAGES.map(s => `<option value="${s.key}" ${s.key===(c.stage||"onboarding")?"selected":""}>${s.label}</option>`).join("")}
        </select>
      </div>
    </div>
  `;
}
function renderClientInfoGrid(c){
  const grid = $("#client-info-grid");
  if (grid){
    grid.innerHTML = CLIENT_INFO_FIELDS.map(f => {
      const raw = c[f.key];
      const hasValue = raw != null && String(raw).trim() !== "";
      const display = hasValue ? (f.isDate ? fmtDate(raw) : escapeHtml(raw)) : "";
      return `
        <div class="client-info-block${f.wide?' client-info-block-wide':''}">
          <div class="client-info-label">${escapeHtml(f.label)}</div>
          ${hasValue
            ? `<div class="client-info-value">${display}</div>`
            : `<button type="button" class="client-info-value client-info-empty" data-action="edit-client-info">+ Add ${escapeHtml(f.label.toLowerCase())} - ${escapeHtml(f.hint)}</button>`}
        </div>`;
    }).join("");
  }
  const { filled, total, pct } = clientProfileCompleteness(c);
  const fill = $("#client-info-progress-fill");
  const label = $("#client-info-progress-label");
  if (fill) fill.style.width = pct + "%";
  if (label) label.textContent = `${filled} of ${total} filled in - ${pct}% complete`;
}
function renderClientDetail(c){
  $("#client-detail-name").textContent = c.name;
  const stageInfo = CLIENT_STAGE_MAP[c.stage] || CLIENT_STAGES[0];
  const stageBadge = $("#client-detail-stage-badge");
  stageBadge.textContent = stageInfo.label;
  stageBadge.className = `badge ${stageInfo.cls}`;
  $("#client-detail-cpl").textContent = c.cost_per_lead != null ? fmtMoney(c.cost_per_lead) : "Not set";
  const monthlySpendEl = $("#client-detail-monthly-spend");
  if (monthlySpendEl) monthlySpendEl.textContent = c.monthly_ad_spend != null ? fmtMoney(c.monthly_ad_spend) : "Not set";
  const adStartEl = $("#client-detail-ad-start-date");
  if (adStartEl) adStartEl.textContent = c.ad_start_date ? fmtDate(c.ad_start_date) : "Not set";
  $("#client-detail-notes").textContent = c.notes || "No notes yet.";
  $("#client-detail-quotes").textContent = c.quotes_sent || 0;
  const banner = $("#quote-guarantee-banner");
  const isQuoteGuarantee = c.stage === "quote_guarantee" && c.quote_target;
  if (banner){
    banner.style.display = isQuoteGuarantee ? "" : "none";
    if (isQuoteGuarantee){
      const sent = Number(c.quotes_sent || 0);
      const pct = Math.min(100, Math.round((sent / c.quote_target) * 100));
      $("#quote-guarantee-sent").textContent = sent;
      $("#quote-guarantee-target").textContent = c.quote_target;
      $("#quote-guarantee-fill").style.width = pct + "%";
      const remaining = Math.max(0, c.quote_target - sent);
      $("#quote-guarantee-sub").textContent = remaining > 0
        ? `${remaining} more to hit the guarantee`
        : "Guarantee delivered - nice work.";
    }
  }
  const quoteButtons = $("#client-detail-quote-buttons");
  if (quoteButtons) quoteButtons.style.display = isQuoteGuarantee ? "none" : "";

  renderClientInfoGrid(c);

  const campaigns = campaignsFor(c.id).sort((a,b) => new Date(b.created_at)-new Date(a.created_at));
  const running = campaigns.filter(x => x.status === "active");
  $("#client-detail-campaigns-running").textContent = running.length;
  $("#client-detail-campaigns-total").textContent = campaigns.length;
  const campTbody = $("#campaigns-tbody");
  if (!campaigns.length){ campTbody.innerHTML = `<tr><td colspan="6">${emptyState("No campaigns yet. Add one to start tracking CPL.")}</td></tr>`; }
  else {
    campTbody.innerHTML = campaigns.map(camp => {
      const stats = campaignAdStats(camp.id);
      const spendCell = stats ? `${fmtMoney(stats.spend)}<div class="row-sub">${stats.creativeCount} creative${stats.creativeCount===1?"":"s"}</div>` : "-";
      const cplCell = stats?.cpl != null ? `${fmtMoney(stats.cpl)}<div class="row-sub">live</div>` : (camp.cost_per_lead!=null ? fmtMoney(camp.cost_per_lead) : "-");
      return `
      <tr data-id="${camp.id}">
        <td><div class="row-name">${escapeHtml(camp.name)}</div>${camp.notes?`<div class="row-sub">${escapeHtml(camp.notes)}</div>`:""}</td>
        <td>${escapeHtml(camp.platform||"-")}</td>
        <td><span class="badge ${CAMPAIGN_STATUSES[camp.status]?.cls||'gray'}">${CAMPAIGN_STATUSES[camp.status]?.label||camp.status}</span></td>
        <td>${spendCell}</td>
        <td>${cplCell}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="icon-btn" data-action="edit-campaign" data-id="${camp.id}" title="Edit">${ICONS.edit}</button>
          <button class="icon-btn" data-action="delete-campaign" data-id="${camp.id}" title="Delete">${ICONS.trash}</button>
        </td>
      </tr>
    `;
    }).join("");
  }


  const creatives = state.adCreatives.filter(x => x.client_id === c.id).sort((a,b) => new Date(b.created_at)-new Date(a.created_at));
  const tbody = $("#ad-creatives-tbody");
  if (!creatives.length){ tbody.innerHTML = `<tr><td colspan="5">${emptyState("No ad creatives tried yet.")}</td></tr>`; }
  else {
    tbody.innerHTML = creatives.map(a => `
      <tr data-id="${a.id}">
        <td>${a.image_url ? `<img src="${escapeHtml(a.image_url)}" class="ad-creative-thumb" data-action="view-creative-image" data-url="${escapeHtml(a.image_url)}">` : `<div class="ad-creative-thumb ad-creative-thumb-empty"></div>`}</td>
        <td><div class="row-name">${escapeHtml(a.name)}</div>${a.campaign_id?`<div class="row-sub">${escapeHtml(campaignName(a.campaign_id))}</div>`:""}${a.notes?`<div class="row-sub">${escapeHtml(a.notes)}</div>`:""}${creativeInsightsSummary(a)}</td>
        <td><span class="badge ${AD_RESULTS[a.result]?.cls||'gray'}">${AD_RESULTS[a.result]?.label||a.result}</span></td>
        <td>${fmtDate(a.created_at)}</td>
        <td style="text-align:right;white-space:nowrap;">
          ${a.meta_ad_id ? `<button class="icon-btn" data-action="refresh-creative-insights" data-id="${a.id}" title="Refresh live stats">${ICONS.refresh}</button>` : ""}
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

/* ───────── Render: Content Production (content pieces across every client) ───────── */
function contentFilteredPieces(){
  const f = state.contentFilter;
  const q = f.search.trim().toLowerCase();
  return state.clientContent.filter(p => {
    if (f.client && p.client_id !== f.client) return false;
    if (f.type && p.type !== f.type) return false;
    if (q && ![p.title, p.notes, p.directions, p.script].some(v => (v||"").toLowerCase().includes(q))) return false;
    return true;
  });
}
function renderContentProduction(){
  const board = $("#content-production-board");
  if (!board) return;

  const clientSel = $("#content-production-filter-client");
  if (clientSel){
    clientSel.innerHTML = `<option value="">All Clients</option>` + state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    clientSel.value = state.contentFilter.client;
  }
  const typeSel = $("#content-production-filter-type");
  if (typeSel) typeSel.value = state.contentFilter.type;

  const pieces = contentFilteredPieces();
  const st = (id,v) => { const el = $(id); if (el) el.textContent = v; };
  st("#content-stat-total", pieces.length);
  st("#content-stat-idea", pieces.filter(p => p.status === "idea").length);
  st("#content-stat-production", pieces.filter(p => p.status === "scripting" || p.status === "filming").length);
  st("#content-stat-posted", pieces.filter(p => p.status === "posted").length);

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
            <div class="deal-contact">${escapeHtml(clientName(p.client_id) || "No client")}</div>
            <div class="content-card-foot">
              <button class="icon-btn" data-action="delete-content" data-id="${p.id}" title="Delete">${ICONS.trash}</button>
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }).join("");
  setupContentDragDrop();
}

/* ───────── Render: Onboarding (per-client tracker) ───────── */
function isOnboardingStepDone(client, step){
  if (step.derivedFrom) return Boolean(client[step.derivedFrom]);
  const progress = client.onboarding_progress || {};
  return Boolean(progress[step.key]);
}
function onboardingDoneCount(client){
  return ONBOARDING_STEPS.filter(s => isOnboardingStepDone(client, s)).length;
}
function renderOnboarding(){
  const listView = $("#onboarding-list-view");
  const detailView = $("#onboarding-detail-view");
  if (!listView || !detailView) return;
  const selected = state.clients.find(c => c.id === state.selectedOnboardingClientId);
  if (!selected){
    state.selectedOnboardingClientId = null;
    listView.style.display = "";
    detailView.style.display = "none";
    renderOnboardingList();
  } else {
    listView.style.display = "none";
    detailView.style.display = "";
    renderOnboardingDetail(selected);
  }
}
function renderOnboardingList(){
  const clients = state.clients.filter(c => c.stage === "onboarding" || (!c.stage && onboardingDoneCount(c) < ONBOARDING_STEPS.length));
  const grid = $("#onboarding-clients-grid");
  if (!grid) return;
  $("#onboarding-stat-active").textContent = clients.length;
  const overdueCount = clients.filter(c => c.stage_changed_at && daysSince(c.stage_changed_at) > 35).length;
  $("#onboarding-stat-overdue").textContent = overdueCount;
  const avgDone = clients.length ? Math.round(clients.reduce((s,c) => s + onboardingDoneCount(c), 0) / clients.length) : 0;
  $("#onboarding-stat-avg-steps").textContent = clients.length ? `${avgDone}/${ONBOARDING_STEPS.length}` : "-";

  if (!clients.length){ grid.innerHTML = emptyState("No clients currently onboarding. New clients start here automatically when added in the Onboarding stage."); return; }
  grid.innerHTML = clients.map(c => {
    const done = onboardingDoneCount(c);
    const pct = Math.round(done / ONBOARDING_STEPS.length * 100);
    const days = c.stage_changed_at ? daysSince(c.stage_changed_at) : null;
    const isSlow = days != null && days > 35;
    return `
    <div class="onboarding-card" data-action="view-onboarding-client" data-id="${c.id}">
      <div class="onboarding-card-head">
        <h5>${escapeHtml(c.name)}</h5>
        ${isSlow ? `<span class="badge red">${days}d - slow</span>` : (days != null ? `<span class="badge gray">${days}d in</span>` : "")}
      </div>
      <div class="onboarding-progress-bar"><div class="onboarding-progress-fill" style="width:${pct}%"></div></div>
      <div class="onboarding-card-foot">${done} of ${ONBOARDING_STEPS.length} steps complete</div>
    </div>
  `;
  }).join("");
}
function renderOnboardingDetail(c){
  $("#onboarding-detail-name").textContent = c.name;
  const done = onboardingDoneCount(c);
  const pct = Math.round(done / ONBOARDING_STEPS.length * 100);
  $("#onboarding-detail-progress-fill").style.width = pct + "%";
  $("#onboarding-detail-progress-label").textContent = `${done} of ${ONBOARDING_STEPS.length} steps complete`;
  const progress = c.onboarding_progress || {};

  // If a realtime update re-renders this list while someone's mid-typing an
  // answer, preserve their unsaved text + cursor instead of clobbering it.
  const listEl = $("#onboarding-steps-list");
  const activeEl = document.activeElement;
  const isEditingAnswer = listEl && activeEl && activeEl.classList?.contains("onboarding-answer-textarea") && listEl.contains(activeEl);
  const activeStepKey = isEditingAnswer ? activeEl.dataset.step : null;
  const activeValue = isEditingAnswer ? activeEl.value : null;
  const activeSelStart = isEditingAnswer ? activeEl.selectionStart : null;
  const activeSelEnd = isEditingAnswer ? activeEl.selectionEnd : null;

  let lastSection = null;
  const rows = ONBOARDING_STEPS.map(s => {
    const isDone = isOnboardingStepDone(c, s);
    const sectionHeader = s.section !== lastSection ? `<div class="onboarding-section-head">${escapeHtml(s.section)}</div>` : "";
    lastSection = s.section;
    const answerBlock = s.answerable ? `
      <div class="onboarding-step-answer">
        <label>${escapeHtml(s.fieldLabel)}</label>
        <textarea class="onboarding-answer-textarea" rows="2" data-id="${c.id}" data-step="${s.key}" placeholder="Type their answer as you go...">${escapeHtml(progress[s.key + ONBOARDING_ANSWER_SUFFIX] || "")}</textarea>
      </div>` : "";
    if (s.derivedFrom){
      // Auto-detected from the client's own data - no manual toggle, clicking
      // it jumps straight to Edit Client so there's nothing to remember to tick.
      return `${sectionHeader}
        <div class="onboarding-step-row derived ${isDone?'done':''}" data-action="onboarding-edit-client" data-id="${c.id}" title="${isDone?'Already set':'Click to add it'}">
          <div class="mtr-check task-check ${isDone?'done':''}">${TASK_CHECK_SVG}</div>
          <div class="onboarding-step-label">${escapeHtml(s.label)}</div>
          <span class="onboarding-step-auto">${isDone ? 'Auto-detected ✓' : 'Auto-detects - click to add'}</span>
        </div>`;
    }
    return `${sectionHeader}
      <div class="onboarding-step-row ${isDone?'done':''}" data-action="toggle-onboarding-step" data-id="${c.id}" data-step="${s.key}">
        <div class="mtr-check task-check ${isDone?'done':''}">${TASK_CHECK_SVG}</div>
        <div class="onboarding-step-label">${escapeHtml(s.label)}</div>
      </div>${answerBlock}`;
  }).join("");
  $("#onboarding-steps-list").innerHTML = rows;

  if (activeStepKey){
    const restored = listEl.querySelector(`.onboarding-answer-textarea[data-step="${activeStepKey}"]`);
    if (restored){
      restored.value = activeValue;
      restored.focus();
      if (activeSelStart != null) restored.setSelectionRange(activeSelStart, activeSelEnd);
    }
  }

  const completeBtn = $("#onboarding-complete-btn");
  if (completeBtn){
    completeBtn.dataset.id = c.id;
    completeBtn.style.display = done === ONBOARDING_STEPS.length ? "" : "none";
  }
}

/* ───────── Render: Creative Library ───────── */
function creativeInsightsSummary(a){
  if (!a.meta_ad_id) return "";
  if (a.insights_updated_at == null) return `<div class="creative-insights creative-insights-empty">Live stats not fetched yet.</div>`;
  const parts = [];
  if (a.impressions != null) parts.push(`${Number(a.impressions).toLocaleString()} impr`);
  if (a.spend != null) parts.push(`${fmtMoney(a.spend)} spent`);
  if (a.cost_per_result != null) parts.push(`${fmtMoney(a.cost_per_result)}/result`);
  else if (a.clicks != null) parts.push(`${Number(a.clicks).toLocaleString()} clicks`);
  return `<div class="creative-insights">${parts.join(" · ")}<span class="creative-insights-updated">Updated ${timeAgo(a.insights_updated_at)}</span></div>`;
}
async function refreshCreativeInsights(id){
  const a = state.adCreatives.find(x => x.id === id);
  if (!a?.meta_ad_id) return;
  const btn = document.querySelector(`[data-action="refresh-creative-insights"][data-id="${id}"]`);
  if (btn) btn.classList.add("spinning");
  if (!IS_CONFIGURED){
    // Demo mode: simulate what the real Edge Function would do, so the flow is testable without a live Meta token.
    await DataLayer.update("client_ad_creatives", id, {
      impressions: Math.floor(8000 + Math.random()*20000),
      clicks: Math.floor(150 + Math.random()*400),
      spend: Number((150 + Math.random()*350).toFixed(2)),
      results: Math.floor(4 + Math.random()*14),
      cost_per_result: Number((15 + Math.random()*35).toFixed(2)),
      insights_updated_at: new Date().toISOString(),
    });
    renderAll();
    return;
  }
  const { data, error } = await supabase.functions.invoke("creative-insights", { body: { creative_id: id } });
  if (error || data?.error){ alert("Couldn't refresh live stats: " + (data?.error || error.message)); }
  await DataLayer.fetchAll(); renderAll();
}
function populateContentClientSelect(selectedId){
  const sel = $("#content-client");
  if (!sel) return;
  sel.innerHTML = state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  sel.value = selectedId || "";
}
function populateAdCreativeClientSelect(selectedId){
  const sel = $("#ad-creative-client");
  if (!sel) return;
  sel.innerHTML = state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  sel.value = selectedId || "";
}
function populateAdCreativeCampaignSelect(clientId, selectedCampaignId){
  const sel = $("#ad-creative-campaign");
  if (!sel) return;
  const campaigns = clientId ? campaignsFor(clientId) : [];
  sel.innerHTML = `<option value="">- No campaign -</option>` + campaigns.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  sel.value = selectedCampaignId || "";
}
function creativeMetricsBlock(a, tierCls){
  if (!a.meta_ad_id) return "";
  if (a.insights_updated_at == null) return `<div class="creative-metrics-empty">Live stats not fetched yet — hit refresh.</div>`;
  const spend = a.spend != null ? fmtMoney(a.spend) : "-";
  const cpl = a.cost_per_result != null ? fmtMoney(a.cost_per_result) : "-";
  const leads = a.results != null ? Number(a.results).toLocaleString() : "-";
  const cplCls = tierCls || "creative-metric-highlight";
  return `
    <div class="creative-metrics">
      <div class="creative-metric"><span class="creative-metric-value">${spend}</span><span class="creative-metric-label">Ad Spend</span></div>
      <div class="creative-metric ${cplCls}"><span class="creative-metric-value">${cpl}</span><span class="creative-metric-label">Cost / Lead</span></div>
      <div class="creative-metric"><span class="creative-metric-value">${leads}</span><span class="creative-metric-label">Leads</span></div>
    </div>`;
}
function renderCreativeLibrary(){
  const grid = $("#creative-library-grid");
  if (!grid) return;

  const clientSel = $("#creative-filter-client");
  if (clientSel){
    clientSel.innerHTML = `<option value="">All Clients</option>` + state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    clientSel.value = state.creativeFilter.client;
  }
  $("#creative-filter-result").value = state.creativeFilter.result;
  const deliverySel = $("#creative-filter-delivery");
  if (deliverySel) deliverySel.value = state.creativeFilter.delivery || "";
  const sortSel = $("#creative-filter-sort");
  if (sortSel) sortSel.value = state.creativeFilter.sort || "top";

  const all = state.adCreatives;
  $("#creative-stat-total").textContent = all.length;
  $("#creative-stat-winners").textContent = all.filter(a => a.result === "winner").length;
  $("#creative-stat-testing").textContent = all.filter(a => a.result === "testing").length;
  $("#creative-stat-killed").textContent = all.filter(a => a.result === "killed").length;
  const winners = all.filter(a => a.result === "winner").length;
  const decided = winners + all.filter(a => a.result === "killed").length;
  $("#creative-stat-winrate").textContent = decided ? Math.round(winners / decided * 100) + "%" : "-";

  const totalSpend = all.reduce((s,a) => s + (Number(a.spend)||0), 0);
  const totalLeads = all.reduce((s,a) => s + (Number(a.results)||0), 0);
  const spendCreatives = all.filter(a => a.spend != null).length;
  $("#creative-stat-spend").textContent = fmtMoney(totalSpend);
  $("#creative-stat-spend-sub").textContent = `All-time · across ${spendCreatives} synced creative${spendCreatives===1?"":"s"}`;
  $("#creative-stat-cpl").textContent = totalLeads > 0 ? fmtMoney(totalSpend / totalLeads) : "-";
  $("#creative-stat-leads-sub").textContent = `${totalLeads.toLocaleString()} lead${totalLeads===1?"":"s"} generated all-time`;

  // Delivery status breakdown, so it's obvious at a glance how many of these
  // are actually running vs sitting paused/needing attention.
  const strip = $("#creative-status-strip");
  if (strip){
    const synced = all.filter(a => a.meta_ad_id);
    const counts = { running: 0, paused: 0, attention: 0, unsynced: 0 };
    for (const a of synced){
      const group = DELIVERY_STATUS[a.delivery_status]?.group;
      if (group) counts[group]++; else counts.paused++;
    }
    counts.unsynced = all.length - synced.length;
    const parts = [];
    if (synced.length){
      parts.push(`<span><span class="creative-status-dot" style="background:var(--success)"></span><strong>${counts.running}</strong> Running</span>`);
      parts.push(`<span><span class="creative-status-dot" style="background:var(--text2)"></span><strong>${counts.paused}</strong> Not Running</span>`);
      if (counts.attention) parts.push(`<span><span class="creative-status-dot" style="background:var(--danger)"></span><strong>${counts.attention}</strong> Needs Attention</span>`);
    }
    if (counts.unsynced) parts.push(`<span><strong>${counts.unsynced}</strong> not linked to Meta</span>`);
    strip.innerHTML = parts.join("");
  }

  // Performance tiers: rank creatives with real spend+CPL data by percentile
  // on both dimensions, so "Top performers" surfaces high-spend + low-CPL
  // ads first (rather than just one dimension), and color-code each card's
  // Cost/Lead number relative to the library average.
  const perfPool = all.filter(a => Number(a.spend) > 0 && a.cost_per_result != null);
  const bySpendAsc = [...perfPool].sort((a,b) => a.spend - b.spend);
  const byCplDesc = [...perfPool].sort((a,b) => b.cost_per_result - a.cost_per_result);
  const spendRank = new Map();
  bySpendAsc.forEach((a,i) => spendRank.set(a.id, perfPool.length > 1 ? i/(perfPool.length-1) : 1));
  const cplRank = new Map();
  byCplDesc.forEach((a,i) => cplRank.set(a.id, perfPool.length > 1 ? i/(perfPool.length-1) : 1));
  const topScore = (a) => spendRank.has(a.id) ? spendRank.get(a.id) + cplRank.get(a.id) : -1;
  const avgCpl = perfPool.length ? perfPool.reduce((s,a) => s + a.cost_per_result, 0) / perfPool.length : null;
  const tierClsFor = (a) => {
    if (avgCpl == null || a.cost_per_result == null || Number(a.spend) < 20) return null;
    if (a.cost_per_result <= avgCpl * 0.8) return "creative-metric-good";
    if (a.cost_per_result >= avgCpl * 1.3) return "creative-metric-bad";
    return null;
  };

  const filtered = all.filter(a => {
    const matchesClient = !state.creativeFilter.client || a.client_id === state.creativeFilter.client;
    const matchesResult = !state.creativeFilter.result || a.result === state.creativeFilter.result;
    const matchesDelivery = !state.creativeFilter.delivery || a.delivery_status === state.creativeFilter.delivery;
    return matchesClient && matchesResult && matchesDelivery;
  });

  // Priority tier ahead of whatever sort is picked below: fatiguing actives
  // need attention right now, so they always lead; then every other active
  // creative; everything else (paused/attention/unsynced) comes last. This
  // is layered on top of - not instead of - the chosen sort, and never looks
  // at performance numbers to decide fatigue, only the flag Rocky sets.
  const priorityTier = (a) => {
    const running = DELIVERY_STATUS[a.delivery_status]?.group === "running";
    if (running && a.fatigue_status === "fatiguing") return 0;
    if (running) return 1;
    return 2;
  };

  const sort = state.creativeFilter.sort || "top";
  filtered.sort((a,b) => {
    const tierDiff = priorityTier(a) - priorityTier(b);
    if (tierDiff !== 0) return tierDiff;
    if (sort === "top") return topScore(b) - topScore(a);
    if (sort === "cpl"){
      const av = a.cost_per_result, bv = b.cost_per_result;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return av - bv;
    }
    if (sort === "spend") return (Number(b.spend)||0) - (Number(a.spend)||0);
    if (sort === "leads") return (Number(b.results)||0) - (Number(a.results)||0);
    return new Date(b.created_at) - new Date(a.created_at);
  });

  if (!filtered.length){ grid.innerHTML = emptyState("No ad creatives match. Add one from here or from a client's page."); return; }
  grid.innerHTML = filtered.map(a => {
    const client = state.clients.find(c => c.id === a.client_id);
    const initial = (client?.name || "?").trim().charAt(0).toUpperCase();
    const delivery = DELIVERY_STATUS[a.delivery_status];
    const fatigue = FATIGUE_STATUS[a.fatigue_status];
    const cardTierCls = a.fatigue_status === "fatiguing" ? "is-fatiguing" : a.fatigue_status === "fatigued" ? "is-fatigued" : "";
    return `
    <div class="creative-card ${cardTierCls}">
      <div class="creative-card-media">
        ${a.image_url ? `<img src="${escapeHtml(a.image_url)}" class="creative-card-img" data-action="view-creative-image" data-url="${escapeHtml(a.image_url)}">` : `<div class="creative-card-img-empty">${escapeHtml(initial)}</div>`}
        ${delivery ? `<span class="badge creative-card-delivery ${delivery.cls}">${delivery.label}</span>` : ""}
        <span class="badge creative-card-badge ${AD_RESULTS[a.result]?.cls||'gray'}">${AD_RESULTS[a.result]?.label||a.result}</span>
        ${fatigue ? `<span class="badge creative-card-fatigue ${fatigue.cls}">${fatigue.label}</span>` : ""}
      </div>
      <div class="creative-card-body">
        <div class="creative-card-name">${escapeHtml(a.name)}</div>
        <div class="creative-card-client">${escapeHtml(client?.name || "Unknown client")}${a.campaign_id ? ` · ${escapeHtml(campaignName(a.campaign_id))}` : ""}</div>
        ${a.notes ? `<div class="creative-card-notes">${escapeHtml(a.notes)}</div>` : ""}
        ${creativeMetricsBlock(a, tierClsFor(a))}
        <div class="field" style="margin-bottom:11px;">
          <label>Fatigue Status</label>
          <select class="creative-fatigue-select" data-id="${a.id}">
            <option value="" ${!a.fatigue_status ? "selected" : ""}>Not flagged</option>
            <option value="fatiguing" ${a.fatigue_status === "fatiguing" ? "selected" : ""}>Fatiguing</option>
            <option value="fatigued" ${a.fatigue_status === "fatigued" ? "selected" : ""}>Fully Fatigued</option>
          </select>
        </div>
        <div class="creative-card-foot">
          <span>${a.impressions != null ? Number(a.impressions).toLocaleString()+" impr · " : ""}${a.insights_updated_at ? "Updated "+timeAgo(a.insights_updated_at) : fmtDate(a.created_at)}</span>
          <div class="creative-card-foot-actions">
            ${a.meta_ad_id ? `<button class="icon-btn" data-action="refresh-creative-insights" data-id="${a.id}" title="Refresh live stats">${ICONS.refresh}</button>` : ""}
            <button class="icon-btn" data-action="edit-ad-creative" data-id="${a.id}" title="Edit">${ICONS.edit}</button>
            <button class="icon-btn" data-action="delete-ad-creative" data-id="${a.id}" title="Delete">${ICONS.trash}</button>
          </div>
        </div>
      </div>
    </div>
  `;
  }).join("");
}

/* ───────── Auto-create a Client (Onboarding) when a deal wins ───────── */
async function maybeCreateClientFromDeal(deal){
  if (!deal || (deal.stage !== "pending_results" && deal.stage !== "closed_won")) return;
  if (state.clients.some(c => c.source_deal_id === deal.id)) return;
  const contact = deal.contact_id ? state.contacts.find(c => c.id === deal.contact_id) : null;
  const name = (contact?.company || deal.contact_name || deal.title || "").trim();
  if (!name) return;
  if (state.clients.some(c => (c.name||"").trim().toLowerCase() === name.toLowerCase())) return;
  await DataLayer.insert("clients", {
    name,
    stage: "onboarding",
    stage_changed_at: new Date().toISOString(),
    source_deal_id: deal.id,
    notes: `Auto-created when "${deal.title}" landed on ${CLOSED_STAGES.has(deal.stage) ? "Closed Won" : "Pending Results"}.`,
  });
  if (!IS_CONFIGURED) return;
  await DataLayer.fetchAll(); renderAll();
}

/* ───────── Auto-create a follow-up task when a deal lands on No Show ─────────
   A no-show should never rely on someone remembering to chase it up by hand -
   it leaves an actual task behind, same as a prospect's Call Back outcome
   does over on the dialer. */
async function maybeCreateNoShowFollowup(deal){
  if (!deal || deal.stage !== "no_show") return;
  const alreadyOpen = state.tasks.some(t => t.deal_id === deal.id && t.status === "open" && t.title.startsWith("Reach out again"));
  if (alreadyOpen) return;
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  // Build the date from local Y/M/D rather than toISOString(), which
  // converts to UTC first - in NZ (UTC+12/13) that rolls "tomorrow" back
  // to today for most of the day.
  const dueDate = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,"0")}-${String(tomorrow.getDate()).padStart(2,"0")}`;
  await DataLayer.insert("tasks", {
    title: `Reach out again - ${deal.contact_name || deal.title}`,
    notes: `"${deal.title}" was marked No Show - try to get them back on the calendar.`,
    due_date: dueDate,
    priority: "high",
    assignee: deal.assignee || null,
    deal_id: deal.id,
    status: "open",
  });
  if (!IS_CONFIGURED) return;
  await DataLayer.fetchAll(); renderAll();
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

  const assigneeFilterEl = $("#task-assignee-filter");
  if (assigneeFilterEl) assigneeFilterEl.value = f.assignee;

  let list = state.tasks.filter(t => {
    if (f.status !== "all" && t.status !== f.status) return false;
    if (f.priority && t.priority !== f.priority) return false;
    if (f.assignee && t.assignee !== f.assignee) return false;
    return true;
  });
  const firstAssignee = getAssigneeFirstPref();
  list = list.sort((a,b) => {
    if (!f.assignee){
      const rankOf = (t) => t.assignee === firstAssignee ? 0 : (t.assignee ? 1 : 2);
      const ar = rankOf(a), br = rankOf(b);
      if (ar !== br) return ar - br;
    }
    if (f.sort === "priority") return (TASK_PRIORITIES[b.priority]?.rank||0) - (TASK_PRIORITIES[a.priority]?.rank||0);
    const da = a.due_date ? new Date(a.due_date).getTime() : Infinity;
    const db = b.due_date ? new Date(b.due_date).getTime() : Infinity;
    return da - db;
  });

  const tbody = $("#tasks-tbody");
  if (!tbody) return;
  if (!list.length){ tbody.innerHTML = `<tr><td colspan="7">${emptyState("No tasks match. Add one to get started.")}</td></tr>`; return; }
  tbody.innerHTML = list.map(t => {
    const isOverdue = t.status === "open" && t.due_date && t.due_date < todayStr;
    const prospect = t.prospect_id ? state.prospects.find(p => p.id === t.prospect_id) : null;
    const linked = [
      t.contact_id ? contactName(t.contact_id) : "",
      t.deal_id ? dealTitle(t.deal_id) : "",
      prospect ? (prospect.name || prospect.company || "Prospect") + (prospect.company && prospect.company !== prospect.name ? ` - ${prospect.company}` : "") : "",
    ].filter(Boolean);
    return `
    <tr data-id="${t.id}">
      <td style="width:34px;"><div class="mtr-check task-check ${t.status==='done'?'done':''}" data-action="toggle-task" data-id="${t.id}">${TASK_CHECK_SVG}</div></td>
      <td>
        <div class="row-name" style="${t.status==='done'?'text-decoration:line-through;color:var(--text2);':''}">${escapeHtml(t.title)}</div>
        ${linked.length ? `<div class="row-sub">${linked.map(escapeHtml).join(" · ")}</div>` : ""}
        ${t.notes ? `<div class="row-sub">${escapeHtml(t.notes)}</div>` : ""}
      </td>
      <td>${t.assignee ? `<span class="badge ${ASSIGNEES[t.assignee]?.cls||'gray'}">${ASSIGNEES[t.assignee]?.label||t.assignee}</span>` : `<span class="badge gray">Unassigned</span>`}</td>
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
// Shows the prospect a Follow Up task was auto-created from (see
// logDialOutcome's call_back branch) right at the top of the task modal, so
// clicking the task actually surfaces who it's about instead of just a
// title with no context.
function renderTaskProspectInfo(t){
  const infoField = $("#task-prospect-info");
  if (!infoField) return;
  const p = t.prospect_id ? state.prospects.find(x => x.id === t.prospect_id) : null;
  if (!p){ infoField.style.display = "none"; return; }
  infoField.style.display = "";
  const displayName = p.name || p.company || "Prospect";
  const showCompanyLine = p.company && p.company !== displayName;
  $("#task-prospect-name").textContent = displayName;
  $("#task-prospect-details").textContent = [
    showCompanyLine ? p.company : "",
    p.phone || "",
    [p.region, p.industry].filter(Boolean).join(" · "),
  ].filter(Boolean).join(" · ");
  $("#task-prospect-notes").textContent = p.notes || "";
}
function openEditTaskModal(id){
  const t = state.tasks.find(x => x.id === id);
  if (!t) return;
  $("#task-form-id").value = t.id;
  $("#task-title").value = t.title||"";
  $("#task-due-date").value = t.due_date||"";
  $("#task-priority").value = t.priority||"medium";
  $("#task-assignee").value = t.assignee||"";
  $("#task-notes").value = t.notes||"";
  $("#task-contact-select").value = t.contact_id||"";
  $("#task-deal-select").value = t.deal_id||"";
  renderTaskProspectInfo(t);
  $("#task-modal-title").textContent = "Edit Task";
  openModal("task-modal");
}
let overdueTasksPopupShown = false;
function checkOverdueTasksPopup(){
  if (overdueTasksPopupShown) return;
  if ($("#qualify-modal")?.classList.contains("visible")) return;
  overdueTasksPopupShown = true;
  const todayStr = todayDateStr();
  const overdue = state.tasks.filter(t => t.status === "open" && t.due_date && t.due_date < todayStr);
  if (!overdue.length) return;
  const list = $("#overdue-tasks-list");
  if (!list) return;
  list.innerHTML = overdue
    .sort((a,b) => new Date(a.due_date) - new Date(b.due_date))
    .map(t => `
      <div class="overdue-task-row" data-action="view-overdue-task" data-id="${t.id}">
        <div>
          <div class="overdue-task-title">${escapeHtml(t.title)}</div>
          <div class="overdue-task-meta">${t.assignee ? (ASSIGNEES[t.assignee]?.label||t.assignee) + " · " : ""}Due ${fmtDate(t.due_date)}</div>
        </div>
        <span class="badge ${TASK_PRIORITIES[t.priority]?.cls||'gray'}">${TASK_PRIORITIES[t.priority]?.label||t.priority}</span>
      </div>
    `).join("");
  openModal("overdue-tasks-modal");
}

/* ───────── Weekly Report (live creative performance + team results) ─────────
   Meta ad insights are synced as lifetime-cumulative totals (date_preset=
   maximum), so "this week's" spend/results can only be known by diffing
   against a baseline taken at the start of the week - there's no daily
   breakdown stored anywhere. Rather than needing a real cron job for that,
   the baseline is taken lazily the first time anyone loads Reporting after
   a new week starts, so a Monday baseline is always in place well before
   Friday's report is checked. */
function mondayOf(d){
  const date = new Date(d);
  const day = date.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  date.setDate(date.getDate() + diff);
  date.setHours(0,0,0,0);
  return date;
}
function isoDateStr(d){ return d.toISOString().slice(0,10); }
async function ensureWeeklyCreativeSnapshot(){
  if (!IS_CONFIGURED) return;
  const weekStart = isoDateStr(mondayOf(new Date()));
  if (state.creativeSnapshots.some(s => s.week_start === weekStart)) return;
  const synced = state.adCreatives.filter(c => c.insights_updated_at);
  if (!synced.length) return;
  const rows = synced.map(c => ({
    creative_id: c.id, week_start: weekStart,
    spend: Number(c.spend||0), impressions: Number(c.impressions||0),
    clicks: Number(c.clicks||0), results: Number(c.results||0),
  }));
  const { error } = await supabase.from("creative_weekly_snapshots").upsert(rows, { onConflict: "creative_id,week_start" });
  if (!error){ await DataLayer.fetchAll(); renderWeeklyReport(); }
}
function creativeWeeklyDelta(creative){
  const weekStart = isoDateStr(mondayOf(new Date()));
  const baseline = state.creativeSnapshots.find(s => s.creative_id === creative.id && s.week_start === weekStart);
  const base = baseline || { spend:0, impressions:0, clicks:0, results:0 };
  return {
    spend: Math.max(0, Number(creative.spend||0) - Number(base.spend||0)),
    results: Math.max(0, Number(creative.results||0) - Number(base.results||0)),
  };
}
function renderWeeklyReport(){
  const rangeEl = $("#weekly-report-range");
  if (!rangeEl) return;
  const monday = mondayOf(new Date());
  const sunday = new Date(monday); sunday.setDate(sunday.getDate()+6);
  rangeEl.textContent = `Week of ${fmtDate(monday)} - ${fmtDate(sunday)}`;

  const synced = state.adCreatives.filter(c => c.insights_updated_at);
  let totalSpend = 0, totalResults = 0;
  const byClient = {};
  synced.forEach(c => {
    const delta = creativeWeeklyDelta(c);
    totalSpend += delta.spend; totalResults += delta.results;
    const client = state.clients.find(cl => cl.id === c.client_id);
    const key = client ? client.id : "unassigned";
    if (!byClient[key]) byClient[key] = { name: client ? client.name : "Unassigned", spend:0, results:0, lifetimeSpend:0 };
    byClient[key].spend += delta.spend;
    byClient[key].results += delta.results;
    byClient[key].lifetimeSpend += Number(c.spend||0);
  });
  $("#weekly-report-spend").textContent = fmtMoney(totalSpend);
  $("#weekly-report-results").textContent = totalResults.toLocaleString();
  $("#weekly-report-cpl").textContent = totalResults > 0 ? fmtMoney(totalSpend/totalResults) : "-";

  const creativeRows = Object.values(byClient).sort((a,b) => b.spend - a.spend);
  const creativesTbody = $("#weekly-report-creatives-tbody");
  if (creativesTbody){
    creativesTbody.innerHTML = creativeRows.length ? creativeRows.map(r => `
      <tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${fmtMoney(r.spend)}</td>
        <td>${r.results.toLocaleString()}</td>
        <td>${r.results > 0 ? fmtMoney(r.spend/r.results) : "-"}</td>
        <td>${fmtMoney(r.lifetimeSpend)}</td>
      </tr>
    `).join("") : `<tr><td colspan="5">${emptyState("No live-synced creatives yet - sync a creative's insights from the Creative Library to start tracking weekly performance.")}</td></tr>`;
  }
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
  ensureWeeklyCreativeSnapshot();
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
async function syncClientAds(clientId){
  const client = state.clients.find(c => c.id === clientId);
  if (!client) return;
  if (!client.meta_ad_account_id){ alert("This client needs a Meta Ad Account ID set first (Edit Client)."); return; }
  const btn = $("#sync-client-ads-btn");
  if (btn){ btn.disabled = true; btn.textContent = "Syncing..."; }
  if (!IS_CONFIGURED){
    // Demo mode: simulate what the real Edge Function would do - refresh
    // whatever creatives already have a Facebook Ad ID, since there's no
    // live Meta account to actually discover new ads from.
    const withMetaId = state.adCreatives.filter(a => a.client_id === clientId && a.meta_ad_id);
    for (const a of withMetaId){
      await DataLayer.update("client_ad_creatives", a.id, {
        impressions: Math.floor(8000 + Math.random()*20000),
        clicks: Math.floor(150 + Math.random()*400),
        spend: Number((150 + Math.random()*350).toFixed(2)),
        results: Math.floor(4 + Math.random()*14),
        cost_per_result: Number((15 + Math.random()*35).toFixed(2)),
        insights_updated_at: new Date().toISOString(),
      });
    }
    if (btn){ btn.disabled = false; btn.textContent = "Sync Ad Account"; }
    alert(`Demo mode: refreshed ${withMetaId.length} existing creative${withMetaId.length===1?"":"s"}. Connect Supabase + Meta to actually discover and import new ads from the account.`);
    renderAll();
    return;
  }
  const { data, error } = await supabase.functions.invoke("sync-client-ads", { body: { client_id: clientId } });
  if (btn){ btn.disabled = false; btn.textContent = "Sync Ad Account"; }
  if (error || data?.error){ alert("Couldn't sync the ad account: " + (data?.error || error.message)); return; }
  alert(`Synced ${data.ads_found} ad${data.ads_found===1?"":"s"}: ${data.creatives_created} new, ${data.creatives_updated} updated, ${data.campaigns_created} new campaign${data.campaigns_created===1?"":"s"} found.`);
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
// Replaces the old manually-typed-in region rollup rows with a live
// breakdown computed straight from the prospects themselves, picked via a
// dropdown - the numbers can't drift from reality since there's nothing to
// manually keep in sync any more.
function renderRegionData(){
  const select = $("#region-data-select");
  if (!select) return;
  const regions = dialerDistinctValues("region");
  const wanted = state.regionDataFilter || "";
  select.innerHTML = `<option value="">All Regions</option>` + regions.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join("");
  select.value = regions.includes(wanted) ? wanted : "";
  state.regionDataFilter = select.value;

  const filtered = state.regionDataFilter ? state.prospects.filter(p => p.region === state.regionDataFilter) : state.prospects;
  const st = (id,v) => { const el = $(id); if (el) el.textContent = v; };
  st("#region-data-total", filtered.length);
  st("#region-data-calls", filtered.reduce((s,p) => s + Number(p.calls_made||0), 0).toLocaleString());
  st("#region-data-bookings", filtered.filter(p => p.last_outcome === "booked_meeting").length);
  st("#region-data-nevercalled", filtered.filter(p => !p.calls_made).length);
  st("#region-data-followups", filtered.filter(p => p.last_outcome === "call_back").length);
  st("#region-data-notinterested", filtered.filter(p => p.last_outcome === "not_interested").length);
  st("#region-data-returning", filtered.filter(isReturning).length);
  st("#region-data-noanswer", filtered.filter(p => p.last_outcome === "no_answer").length);
}

// Shows which of the canonical Region/Industry combos actually have
// prospects on file yet, so the team can see at a glance where territory
// still hasn't been touched instead of guessing from memory.
function renderCoverageMap(){
  const byRegion = {};
  const industriesSeen = new Set();
  state.prospects.forEach(p => {
    if (!p.region) return;
    if (!byRegion[p.region]) byRegion[p.region] = { total: 0, industries: {} };
    byRegion[p.region].total += 1;
    if (p.industry){
      byRegion[p.region].industries[p.industry] = (byRegion[p.region].industries[p.industry] || 0) + 1;
      industriesSeen.add(p.industry);
    }
  });

  const coveredRegions = Object.keys(byRegion);
  $("#coverage-regions-started").textContent = `${coveredRegions.length} / ${ALL_REGIONS.length}`;
  $("#coverage-industries-started").textContent = `${industriesSeen.size} / ${HOME_SERVICES_INDUSTRIES.length}`;

  const sortedRegions = coveredRegions.sort((a,b) => byRegion[b].total - byRegion[a].total);
  $("#coverage-mapped-list").innerHTML = sortedRegions.length ? sortedRegions.map(r => {
    const data = byRegion[r];
    const chips = Object.entries(data.industries)
      .sort((a,b) => b[1]-a[1])
      .map(([ind,count]) => `<span class="badge gray">${escapeHtml(ind)} (${count})</span>`)
      .join(" ");
    return `
      <div style="padding:10px 0;border-bottom:1px solid var(--line);">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;">
          <strong>${escapeHtml(r)}</strong>
          <span style="color:var(--text2);font-size:12.5px;white-space:nowrap;">${data.total} prospect${data.total===1?"":"s"}</span>
        </div>
        <div style="margin-top:7px;display:flex;flex-wrap:wrap;gap:5px;">${chips || `<span style="color:var(--text2);font-size:12.5px;">No industry tagged yet</span>`}</div>
      </div>
    `;
  }).join("") : `<p style="color:var(--text2);font-size:13px;">No prospects imported yet.</p>`;

  const unmappedRegions = ALL_REGIONS.filter(r => !coveredRegions.includes(r));
  const unmappedIndustries = HOME_SERVICES_INDUSTRIES.filter(i => !industriesSeen.has(i));
  $("#coverage-unmapped-list").innerHTML = `
    <p><strong>Regions:</strong> ${unmappedRegions.length ? escapeHtml(unmappedRegions.join(", ")) : "All regions started!"}</p>
    <p><strong>Industries:</strong> ${unmappedIndustries.length ? escapeHtml(unmappedIndustries.join(", ")) : "All industries started!"}</p>
  `;
}

function prospectCallerLabel(email){
  const key = personKeyFromEmail(email);
  if (key) return ASSIGNEES[key].label;
  return email ? email.split("@")[0] : "";
}
function renderProspectFilters(){
  const regionSel = $("#prospecting-filter-region");
  const industrySel = $("#prospecting-filter-industry");
  const callerSel = $("#prospecting-filter-caller");
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
  if (callerSel){
    // Always list the whole team, not just whoever has actually logged a
    // call so far - otherwise a new hire stays invisible in this filter
    // until their first call.
    const knownEmails = Object.keys(EMAIL_TO_ASSIGNEE);
    const otherCallers = dialerDistinctValues("last_called_by").filter(c => !knownEmails.includes(c));
    const callers = [...knownEmails, ...otherCallers];
    callerSel.innerHTML = `<option value="">Called By - Anyone</option>` + callers.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(prospectCallerLabel(c))}</option>`).join("");
    callerSel.value = state.dialerFilter.caller;
  }
}
function renderProspectRow(p, opts={}){
  const website = p.website ? (/^https?:\/\//i.test(p.website) ? p.website : "https://" + p.website) : "";
  const called = Number(p.calls_made||0);
  // No separate contact name is ever known from a business listing scrape -
  // the company name IS the identity, so it's what shows front and centre
  // when there's no name on file.
  const displayName = p.name || p.company || "";
  const showCompanyLine = p.company && p.company !== displayName;
  const calledLabel = called === 0
    ? "Not Called - Tap to Mark"
    : (called < 3 ? `Called ${called} of 3 - log again` : `Called ${called}x - log again`);
  return `
    <tr data-id="${p.id}">
      <td>
        <div class="row-name">${escapeHtml(displayName)}${opts.dupe ? ` <span class="badge red" title="Shares a phone number or business name with another prospect on the list">Possible Duplicate</span>` : ""}</div>
        <div class="row-sub">${showCompanyLine ? escapeHtml(p.company) : ""}${website ? ` · <a href="${escapeHtml(website)}" target="_blank" rel="noopener">Website ↗</a>` : ""}</div>
        ${p.google_rating ? `<div class="row-sub">⭐ ${escapeHtml(p.google_rating)}</div>` : ""}
      </td>
      <td>${escapeHtml(p.phone||"-")}</td>
      <td>${[p.region,p.industry].filter(Boolean).map(escapeHtml).join(" · ") || "-"}</td>
      <td>
        <button class="btn ${called ? "ghost" : "gold"} prospect-call-btn" data-action="log-prospect-call" data-id="${p.id}">
          ${calledLabel}
        </button>
        ${p.last_outcome === "not_interested" ? `<div class="row-sub" style="margin-top:4px;">Marked Not Interested</div>` : ""}
        ${p.last_outcome === "call_back" ? `<div class="row-sub" style="margin-top:4px;">Follow-up scheduled</div>` : ""}
        ${isReturning(p) ? `<div class="row-sub" style="margin-top:4px;">Cooling down til ${fmtDate(p.snoozed_until)}</div>` : ""}
        ${p.last_called_at ? `<div class="row-sub">${timeAgo(p.last_called_at)}${p.last_called_by ? " by "+escapeHtml(prospectCallerLabel(p.last_called_by)) : ""}</div>` : ""}
      </td>
      <td style="max-width:240px;"><span class="row-sub" style="font-size:12.5px;color:var(--text);white-space:pre-line;">${escapeHtml(p.notes||"")}</span></td>
      <td style="text-align:right;white-space:nowrap;">
        ${isParked(p) ? `<button class="icon-btn" data-action="reactivate-prospect" data-id="${p.id}" title="Move back to active pool">${ICONS.refresh}</button>` : ""}
        <button class="icon-btn" data-action="edit-prospect" data-id="${p.id}" title="Edit">${ICONS.edit}</button>
        <button class="icon-btn" data-action="convert-prospect" data-id="${p.id}" title="Move to Contacts">${ICONS.moveToContact}</button>
        <button class="icon-btn" data-action="delete-prospect" data-id="${p.id}" title="Delete">${ICONS.trash}</button>
      </td>
    </tr>`;
}
function prospectTableSection(rows, opts={}){
  return `<div class="table-wrap"><table><thead><tr><th>Business</th><th>Phone</th><th>Region / Industry</th><th>Status</th><th>Notes</th><th></th></tr></thead><tbody>${rows.map(p => renderProspectRow(p, opts)).join("")}</tbody></table></div>`;
}
function prospectRegionSection({ key, dotColor, title, rows, dupe=false }){
  const open = !state.prospectingCollapsedRegions.has(key) ? "open" : "";
  const sorted = [...rows].sort((a,b) => (a.name||"").localeCompare(b.name||""));
  return `
    <details class="clients-stage-section prospect-region-section${dupe?" prospect-duplicates-section":""}" data-region="${escapeHtml(key)}" ${open}>
      <summary class="clients-stage-header">
        <span class="clients-stage-dot"${dotColor ? ` style="background:${dotColor};"` : ""}></span>
        <h3>${title}</h3>
        <span class="kanban-count">${rows.length}</span>
      </summary>
      <div class="prospect-region-table">${prospectTableSection(sorted, { dupe })}</div>
    </details>`;
}
// The master prospect list, shared team-wide, so everyone dialing off it -
// Rocky, Max, and the new cold callers - can see who's already called who.
// Logging a call snoozes a business out of this view for a few days, which
// is what actually stops the same lead getting called twice. Grouped by
// region so the "map" of where the team is calling is obvious at a glance;
// a person's assigned focus vertical (see team_focus) is pinned above the
// regions without hiding anything else from the shared pool; and anything
// sharing a phone number or business name with another row gets flagged and
// pushed to its own section at the very bottom instead of silently sitting
// in the regular flow, so nobody calls the same business twice.
function renderProspectList(){
  const groupsWrap = $("#prospecting-groups");
  if (!groupsWrap) return;
  renderProspectFilters();
  renderTeamFocusPanel();
  const baseFiltered = dialerFilteredProspects();

  // Not Interested and Call Back are parked out of the normal flow entirely
  // (see isParked) rather than just snoozed on a timer, so they get their
  // own dedicated views instead of cluttering the region-grouped active list
  // or silently resurfacing after a cooldown expires.
  const notInterested = baseFiltered.filter(p => p.last_outcome === "not_interested");
  const followUp = baseFiltered.filter(p => p.last_outcome === "call_back");
  const returning = baseFiltered.filter(isReturning);
  const activePool = baseFiltered.filter(p => !isParked(p) && !isSnoozed(p));

  const neverCalled = baseFiltered.filter(p => !p.calls_made).length;
  const industries = new Set(baseFiltered.map(p => p.industry).filter(Boolean)).size;
  const st = (id,v) => { const el = $(id); if (el) el.textContent = v; };
  st("#prospecting-stat-total", baseFiltered.length);
  st("#prospecting-stat-ready", activePool.length);
  st("#prospecting-stat-snoozed", returning.length);
  st("#prospecting-stat-fresh", neverCalled);
  st("#prospecting-stat-industries", industries);

  const viewCounts = { active: activePool.length, follow_up: followUp.length, not_interested: notInterested.length, returning: returning.length };
  const viewLabels = { active: "Active", follow_up: "Follow Up", not_interested: "Not Interested", returning: "Returning" };
  const viewSelect = $("#prospecting-view-select");
  if (viewSelect){
    Array.from(viewSelect.options).forEach(opt => { opt.textContent = `${viewLabels[opt.value]} (${viewCounts[opt.value]})`; });
    viewSelect.value = state.prospectingView;
  }

  const view = state.prospectingView || "active";
  const filtered = { active: activePool, follow_up: followUp, not_interested: notInterested, returning: returning }[view] || activePool;

  if (!filtered.length){
    const emptyMsg = {
      active: baseFiltered.length ? "Nobody's ready to call right now - check Follow Up or Returning." : "No prospects yet. Import a list above.",
      follow_up: "No follow-ups scheduled.",
      not_interested: "Nobody's been marked Not Interested.",
      returning: "Nobody's currently cooling down.",
    }[view];
    groupsWrap.innerHTML = emptyState(emptyMsg);
    return;
  }

  // Duplicates and the focus-industry pin-to-top only make sense against the
  // active calling pool - the other views are already a narrow, purposeful
  // list, not something to further reorganise.
  let clean = filtered, dupes = [];
  if (view === "active"){
    // Checked against the whole shared list, not just what's currently
    // visible, so a duplicate still gets flagged even when its sibling is
    // parked or cooling down - otherwise the one row left showing would look
    // like a fresh, never-called lead.
    const dupeIds = prospectDuplicateIds(state.prospects);
    clean = filtered.filter(p => !dupeIds.has(p.id));
    dupes = filtered.filter(p => dupeIds.has(p.id));
  }

  const activePerson = window.getActivePerson ? window.getActivePerson() : null;
  const focusIndustry = view === "active" && activePerson ? state.teamFocus[activePerson] : null;
  const focusList = focusIndustry ? clean.filter(p => (p.industry||"") === focusIndustry) : [];
  const restList = focusIndustry ? clean.filter(p => (p.industry||"") !== focusIndustry) : clean;

  // Grouped by region AND industry together, not just region - a region
  // full of several different trades mixed into one flat section is exactly
  // what made a bad import (or just a busy list) hard to work through.
  const regionGroups = {};
  restList.forEach(p => {
    const region = p.region || "No Region Set";
    const industry = p.industry || "No Industry Set";
    const key = `${region} · ${industry}`;
    (regionGroups[key] = regionGroups[key] || []).push(p);
  });
  const regionNames = Object.keys(regionGroups).sort((a,b) => a.localeCompare(b));

  let html = "";
  if (focusList.length){
    html += prospectRegionSection({ key:"__focus__", dotColor:"var(--gold)", title:`⭐ Your Focus - ${escapeHtml(focusIndustry)}`, rows:focusList });
  }
  regionNames.forEach(r => {
    html += prospectRegionSection({ key:r, title:escapeHtml(r), rows:regionGroups[r] });
  });
  if (dupes.length){
    html += prospectRegionSection({ key:"__dupes__", dotColor:"var(--danger)", title:"⚠ Possible Duplicates", rows:dupes, dupe:true });
  }

  groupsWrap.innerHTML = html;
  $$(".prospect-region-section", groupsWrap).forEach(section => {
    section.addEventListener("toggle", () => {
      const key = section.dataset.region;
      if (section.open) state.prospectingCollapsedRegions.delete(key);
      else state.prospectingCollapsedRegions.add(key);
    });
  });
}
// A small panel letting Rocky point a person at a vertical - everyone still
// shares the same underlying list, this just changes what surfaces to the
// top when that person is the one browsing it (see getActivePerson).
function renderTeamFocusPanel(){
  const wrap = $("#prospecting-team-focus");
  if (!wrap) return;
  const industries = dialerDistinctValues("industry");
  const people = Object.keys(ASSIGNEES);
  wrap.innerHTML = people.map(p => {
    const options = `<option value="">No focus - see everything</option>` + industries.map(i => `<option value="${escapeHtml(i)}" ${state.teamFocus[p]===i?"selected":""}>${escapeHtml(i)}</option>`).join("");
    return `
      <div class="field" style="min-width:180px;">
        <label>${escapeHtml(ASSIGNEES[p].label)}</label>
        <select data-team-focus-person="${p}">${options}</select>
      </div>`;
  }).join("");
}

function renderAll(){
  renderDashboard();
  renderPlaybookUsagePicker();
  renderMeetingsPipeline();
  renderContacts();
  renderDeals();
  renderRegionData();
  renderProspectList();
  renderDialer();
  renderClients();
  renderOnboarding();
  renderCreativeLibrary();
  renderContentProduction();
  renderTasks();
  renderReporting();
  renderWeeklyReport();
  renderLeadCenterImport();
  renderTeam();
  renderCalendarGrid();
  renderPlaybooks();
  renderRules();
  renderEmailTemplates();
  renderExpenses();
  renderStatistics();
  fillContactDropdowns();
}

/* ───────── Render: Statistics (long-term, any person / any time range) ───────── */
function statsRangeBounds(range, customFrom, customTo){
  const today = new Date();
  const toStr = d => d.toISOString().slice(0,10);
  const startOfMonth = d => new Date(d.getFullYear(), d.getMonth(), 1);
  const endOfMonth = d => new Date(d.getFullYear(), d.getMonth()+1, 0);
  switch (range){
    case "today": return { from: toStr(today), to: toStr(today) };
    case "yesterday": { const y = new Date(today); y.setDate(y.getDate()-1); return { from: toStr(y), to: toStr(y) }; }
    case "7d": { const f = new Date(today); f.setDate(f.getDate()-6); return { from: toStr(f), to: toStr(today) }; }
    case "30d": { const f = new Date(today); f.setDate(f.getDate()-29); return { from: toStr(f), to: toStr(today) }; }
    case "month": return { from: toStr(startOfMonth(today)), to: toStr(endOfMonth(today)) };
    case "last_month": { const lm = new Date(today.getFullYear(), today.getMonth()-1, 1); return { from: toStr(startOfMonth(lm)), to: toStr(endOfMonth(lm)) }; }
    case "year": return { from: `${today.getFullYear()}-01-01`, to: `${today.getFullYear()}-12-31` };
    case "custom": return { from: customFrom || null, to: customTo || null };
    case "all": default: return { from: null, to: null };
  }
}
function inStatsRange(dateStr, bounds){
  if (!dateStr) return false;
  const d = dateStr.slice(0,10);
  if (bounds.from && d < bounds.from) return false;
  if (bounds.to && d > bounds.to) return false;
  return true;
}
// Meetings booked/closed here are counted from deal records (same approach
// as the Team Analytics "Meeting Conversion" figure) so the two line up;
// Calls/Conversations still come from the daily call_activity tap counters.
function statsForPerson(p, bounds){
  const rows = state.callActivity.filter(r => r.person === p && inStatsRange(r.activity_date, bounds));
  const calls = rows.reduce((s,r) => s + (r.calls||0), 0);
  const convos = rows.reduce((s,r) => s + (r.conversations||0), 0);
  const dealsBooked = state.deals.filter(d => d.assignee === p && inStatsRange(d.created_at, bounds));
  const meetingsBooked = dealsBooked.length;
  const closedMeetings = dealsBooked.filter(d => MEETING_CLOSE_STAGES.has(d.stage)).length;
  const closedDeals = state.deals.filter(d => d.assignee === p && d.stage === "closed_won" && inStatsRange(d.updated_at||d.created_at, bounds)).length;
  const callRate = calls ? Math.round(convos/calls*100) : 0;
  const meetingRate = meetingsBooked ? Math.round(closedMeetings/meetingsBooked*100) : 0;
  return { calls, convos, meetingsBooked, closedMeetings, closedDeals, callRate, meetingRate };
}
function renderStatistics(){
  const grid = $("#stats-summary-grid");
  if (!grid) return;
  const f = state.statsFilter;
  const bounds = statsRangeBounds(f.range, f.customFrom, f.customTo);
  const people = Object.keys(ASSIGNEES);
  const scope = f.person ? [f.person] : people;
  const totals = scope.reduce((acc, p) => {
    const s = statsForPerson(p, bounds);
    acc.calls += s.calls; acc.convos += s.convos; acc.meetingsBooked += s.meetingsBooked;
    acc.closedMeetings += s.closedMeetings; acc.closedDeals += s.closedDeals;
    return acc;
  }, { calls:0, convos:0, meetingsBooked:0, closedMeetings:0, closedDeals:0 });
  const callRate = totals.calls ? Math.round(totals.convos/totals.calls*100) : 0;
  const meetingRate = totals.meetingsBooked ? Math.round(totals.closedMeetings/totals.meetingsBooked*100) : 0;

  grid.innerHTML = `
    <div class="stat-card"><div class="stat-label">Calls</div><div class="stat-value">${totals.calls}</div><div class="stat-sub">${totals.convos} conversations</div></div>
    <div class="stat-card"><div class="stat-label">Call Conversion</div><div class="stat-value">${callRate}%</div><div class="stat-sub">conversations / calls</div></div>
    <div class="stat-card"><div class="stat-label">Meetings Booked</div><div class="stat-value">${totals.meetingsBooked}</div><div class="stat-sub">${totals.closedDeals} closed deals</div></div>
    <div class="stat-card"><div class="stat-label">Meeting Conversion</div><div class="stat-value">${meetingRate}%</div><div class="stat-sub">${totals.closedMeetings} closed meetings</div></div>
  `;

  const tbody = $("#stats-breakdown-tbody");
  if (tbody){
    const rows = scope.map(p => {
      const s = statsForPerson(p, bounds);
      return `<tr>
        <td>${escapeHtml(ASSIGNEES[p].label)}</td>
        <td>${s.calls}</td>
        <td>${s.convos}</td>
        <td>${s.callRate}%</td>
        <td>${s.meetingsBooked}</td>
        <td>${s.closedMeetings}</td>
        <td>${s.meetingRate}%</td>
        <td>${s.closedDeals}</td>
      </tr>`;
    }).join("");
    const totalRow = scope.length > 1 ? `
      <tr style="font-weight:700;">
        <td>Team Total</td>
        <td>${totals.calls}</td>
        <td>${totals.convos}</td>
        <td>${callRate}%</td>
        <td>${totals.meetingsBooked}</td>
        <td>${totals.closedMeetings}</td>
        <td>${meetingRate}%</td>
        <td>${totals.closedDeals}</td>
      </tr>` : "";
    tbody.innerHTML = rows + totalRow;
  }
}

/* ───────── Render: Expenses ───────── */
function monthlyRecurringTotal(){ return state.expenses.filter(e => (e.type||"expense") === "expense" && e.frequency === "monthly").reduce((s,e) => s + Number(e.amount||0), 0); }
function renderExpenses(){
  const tbody = $("#expenses-tbody");
  if (!tbody) return;
  const monthlyTotal = monthlyRecurringTotal();
  const oneOffThisMonth = state.expenses.filter(e => (e.type||"expense") === "expense" && e.frequency === "one_off" && sameMonth(e.expense_date)).reduce((s,e) => s + Number(e.amount||0), 0);
  const profitThisMonth = state.expenses.filter(e => e.type === "profit" && sameMonth(e.expense_date)).reduce((s,e) => s + Number(e.amount||0), 0);
  $("#stat-expenses-monthly").textContent = fmtMoney(monthlyTotal);
  $("#stat-expenses-oneoff").textContent = fmtMoney(oneOffThisMonth);
  $("#stat-expenses-total-month").textContent = fmtMoney(monthlyTotal + oneOffThisMonth);
  const profitEl = $("#stat-expenses-profit-month"); if (profitEl) profitEl.textContent = fmtMoney(profitThisMonth);
  const netEl = $("#stat-expenses-net-month"); if (netEl) netEl.textContent = fmtMoney(profitThisMonth - (monthlyTotal + oneOffThisMonth));

  const list = [...state.expenses].sort((a,b) => new Date(b.expense_date) - new Date(a.expense_date));
  if (!list.length){ tbody.innerHTML = `<tr><td colspan="7">${emptyState("No expenses logged yet. Add your first one.")}</td></tr>`; return; }
  tbody.innerHTML = list.map(e => {
    const isProfit = e.type === "profit";
    const dealName = e.deal_id ? dealTitle(e.deal_id) : "";
    return `
    <tr data-id="${e.id}">
      <td>${fmtDate(e.expense_date)}</td>
      <td><div class="row-name">${escapeHtml(e.title)}</div>${dealName?`<div class="row-sub">${escapeHtml(dealName)}</div>`:""}${e.notes?`<div class="row-sub">${escapeHtml(e.notes)}</div>`:""}</td>
      <td><span class="badge ${EXPENSE_TYPES[e.type||"expense"]?.cls||"gray"}">${EXPENSE_TYPES[e.type||"expense"]?.label||"Expense"}</span></td>
      <td>${isProfit ? "-" : `<span class="badge gray">${escapeHtml(EXPENSE_CATEGORIES[e.category]||e.category)}</span>`}</td>
      <td><span class="badge ${EXPENSE_FREQUENCIES[e.frequency]?.cls||"gray"}">${EXPENSE_FREQUENCIES[e.frequency]?.label||e.frequency}</span></td>
      <td style="font-weight:700;${isProfit?"color:var(--success);":""}">${isProfit?"+":""}${fmtMoney(e.amount)}</td>
      <td style="text-align:right;white-space:nowrap;">
        <button class="icon-btn" data-action="edit-expense" data-id="${e.id}" title="Edit">${ICONS.edit}</button>
        <button class="icon-btn" data-action="delete-expense" data-id="${e.id}" title="Delete">${ICONS.trash}</button>
      </td>
    </tr>
  `;}).join("");
}

/* ───────── Playbooks ───────── */
// Lightweight markdown-lite renderer: "## " headings, "1. "/"- " lists, "- [ ] "
// checklist items, **bold**. Keeps playbook authoring as plain text while
// rendering as a proper doc.
function renderPlaybookMarkdown(raw, checked){
  checked = checked || {};
  const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  const lines = String(raw||"").split("\n");
  let html = "", listType = null, checkIdx = 0;
  const closeList = () => { if (listType){ html += `</${listType}>`; listType = null; } };
  for (const rawLine of lines){
    const line = rawLine.trim();
    if (!line){ closeList(); continue; }
    // Accepts both the toolbar's own output (##, -) and whatever a person
    // types by hand from muscle memory (#, *) - a single "#" or "*" used to
    // just show up literally in the text since only the toolbar's exact
    // syntax matched, which looked broken to anyone who already knows
    // regular markdown.
    const h = line.match(/^#{1,6}\s+(.*)$/);
    if (h){ closeList(); html += `<h4>${inline(h[1])}</h4>`; continue; }
    const task = line.match(/^[-*]\s*\[[ xX]?\]\s+(.*)$/);
    if (task){
      if (listType !== "checklist"){ closeList(); html += `<ul class="pb-checklist">`; listType = "checklist"; }
      const idx = checkIdx++;
      const isChecked = !!checked[idx];
      html += `<li class="pb-check-item${isChecked?" checked":""}" data-action="toggle-checklist-item" data-idx="${idx}">
        <span class="pb-check-box"></span>
        <span class="pb-check-text">${inline(task[1])}</span>
      </li>`;
      continue;
    }
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol){ if (listType !== "ol"){ closeList(); html += "<ol>"; listType = "ol"; } html += `<li>${inline(ol[1])}</li>`; continue; }
    const ul = line.match(/^[-*•]\s+(.*)$/);
    if (ul){ if (listType !== "ul"){ closeList(); html += "<ul>"; listType = "ul"; } html += `<li>${inline(ul[1])}</li>`; continue; }
    closeList();
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  return { html, total: checkIdx };
}
// Shared by every "rich-ish text" editor that uses the Bold/Heading/Bullet
// toolbar (Playbooks, Rules, ...) - textareaId's preview div is always
// textareaId + "-preview" by convention.
function updateLivePreview(textareaId){
  const ta = $("#" + textareaId);
  const preview = $("#" + textareaId + "-preview");
  if (!ta || !preview) return;
  preview.innerHTML = renderPlaybookMarkdown(ta.value, {}).html;
}
function getPlaybookChecklist(id){
  try { return JSON.parse(localStorage.getItem("pb-checklist-"+id) || "{}"); } catch { return {}; }
}
function savePlaybookChecklist(id, state){
  localStorage.setItem("pb-checklist-"+id, JSON.stringify(state));
}
function playbookIcon(title){
  const t = String(title||"").toLowerCase();
  if (t.includes("cold call") || t.includes("dial")) return ICONS.phone;
  if (t.includes("meeting") || t.includes("close") || t.includes("closing")) return ICONS.handshake;
  if (t.includes("onboard")) return ICONS.flag;
  if (t.includes("ad") || t.includes("campaign") || t.includes("delivery")) return ICONS.megaphone;
  return ICONS.book;
}
function renderPlaybooks(){
  const listEl = $("#playbooks-list");
  const viewer = $("#playbook-viewer");
  if (!listEl || !viewer) return;
  const list = [...state.playbooks].sort((a,b) => (a.sort_order||0) - (b.sort_order||0));
  if (!list.length){
    listEl.innerHTML = "";
    viewer.innerHTML = `<div class="playbook-empty"><div class="playbook-empty-icon">${ICONS.book}</div>No playbooks yet.<br>Add your first script or process doc.</div>`;
    return;
  }
  if (!state.selectedPlaybookId || !list.find(p => p.id === state.selectedPlaybookId)){
    state.selectedPlaybookId = list[0].id;
  }
  listEl.innerHTML = list.map(p => {
    const pState = getPlaybookChecklist(p.id);
    const { total, checked } = (() => {
      const r = renderPlaybookMarkdown(p.content, pState);
      return { total: r.total, checked: Object.values(pState).filter(Boolean).length };
    })();
    const sub = total > 0
      ? `${Math.min(checked,total)} of ${total} steps complete`
      : escapeHtml((p.content||"").replace(/[#*\n]/g," ").trim().slice(0,42));
    return `
    <button type="button" class="playbook-list-item ${p.id === state.selectedPlaybookId ? "active" : ""}" data-action="select-playbook" data-id="${p.id}">
      <span class="playbook-list-item-icon">${playbookIcon(p.title)}</span>
      <span class="playbook-list-item-text">
        <div class="playbook-list-item-title">${escapeHtml(p.title)}</div>
        <div class="playbook-list-item-sub">${sub}</div>
      </span>
    </button>
  `;
  }).join("");
  const p = list.find(x => x.id === state.selectedPlaybookId);
  const checklistState = getPlaybookChecklist(p.id);
  const { html: contentHtml, total } = renderPlaybookMarkdown(p.content, checklistState);
  const checkedCount = Object.values(checklistState).filter(Boolean).length;
  const progressHtml = total > 0 ? `
    <div class="playbook-progress">
      <div class="playbook-progress-bar"><div class="playbook-progress-fill" id="playbook-progress-fill" style="width:${Math.round(Math.min(checkedCount,total)/total*100)}%"></div></div>
      <span class="playbook-progress-text" id="playbook-progress-text">${checkedCount} of ${total} steps complete</span>
      <button type="button" class="playbook-reset-btn" data-action="reset-checklist" data-id="${p.id}">Reset</button>
    </div>` : "";
  viewer.innerHTML = `
    <div class="playbook-viewer-head">
      <div class="playbook-viewer-head-title">
        <span class="playbook-viewer-icon">${playbookIcon(p.title)}</span>
        <div><h3>${escapeHtml(p.title)}</h3><p>Updated ${fmtDate(p.updated_at||p.created_at)}</p></div>
      </div>
      <div class="playbook-viewer-actions">
        <button class="icon-btn" data-action="edit-playbook" data-id="${p.id}" title="Edit">${ICONS.edit}</button>
        <button class="icon-btn" data-action="delete-playbook" data-id="${p.id}" title="Delete">${ICONS.trash}</button>
      </div>
    </div>
    ${progressHtml}
    <div class="playbook-content" data-playbook="${p.id}">${contentHtml || `<p style="color:var(--text2);">No content yet - click the edit icon to write it.</p>`}</div>
  `;
}

/* ───────── Rules (per-channel standards, shared with the whole team) ─────────
   Built for "extensive and text-heavy" content specifically: a flat wall of
   text doesn't scale once a category has a dozen rules in it, so each ##
   heading in the content becomes its own collapsible card instead of one
   long scroll - people can scan just the headings, open only what's
   relevant, or search across all of them instead of reading top to bottom
   every time. */
function ruleIcon(title){
  const t = String(title||"").toLowerCase();
  if (t.includes("meta") || t.includes("facebook") || t.includes("instagram")) return ICONS.megaphone;
  if (t.includes("google") && (t.includes("ad") || t.includes("ads"))) return ICONS.megaphone;
  if (t.includes("seo")) return ICONS.search;
  if (t.includes("landing") || t.includes("website") || t.includes("web")) return ICONS.globe;
  return ICONS.shield;
}
// Splits raw ##-headed content into sections instead of one flowing block -
// reuses renderPlaybookMarkdown per-section so bold/bullets/numbering all
// still work exactly the same, just scoped to the lines under each heading.
function parseRuleSections(raw){
  const lines = String(raw||"").split("\n");
  const segments = [];
  let current = { heading: null, lines: [] };
  for (const line of lines){
    const h = line.trim().match(/^##\s+(.*)$/);
    if (h){
      segments.push(current);
      current = { heading: h[1], lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  segments.push(current);
  return segments
    .map(seg => ({ heading: seg.heading, html: renderPlaybookMarkdown(seg.lines.join("\n"), {}).html }))
    .filter(seg => seg.heading || seg.html.trim());
}
function renderRules(){
  const listEl = $("#rules-list");
  const viewer = $("#rule-viewer");
  if (!listEl || !viewer) return;
  const list = [...state.rules].sort((a,b) => (a.sort_order||0) - (b.sort_order||0));
  if (!list.length){
    listEl.innerHTML = "";
    viewer.innerHTML = `<div class="playbook-empty"><div class="playbook-empty-icon">${ICONS.shield}</div>No rule lists yet.<br>Add one for Meta Ads, Google Ads, Landing Pages, SEO, or anything else.</div>`;
    return;
  }
  if (!state.selectedRuleId || !list.find(r => r.id === state.selectedRuleId)){
    state.selectedRuleId = list[0].id;
  }
  listEl.innerHTML = list.map(r => {
    const sectionCount = parseRuleSections(r.content).filter(s => s.heading).length;
    const sub = sectionCount ? `${sectionCount} section${sectionCount===1?"":"s"}` : "No rules written yet";
    return `
    <button type="button" class="playbook-list-item ${r.id === state.selectedRuleId ? "active" : ""}" data-action="select-rule" data-id="${r.id}">
      <span class="playbook-list-item-icon">${ruleIcon(r.title)}</span>
      <span class="playbook-list-item-text">
        <div class="playbook-list-item-title">${escapeHtml(r.title)}</div>
        <div class="playbook-list-item-sub">${sub}</div>
      </span>
    </button>
  `;
  }).join("");
  const r = list.find(x => x.id === state.selectedRuleId);
  const parsed = parseRuleSections(r.content);
  const intro = parsed.find(s => !s.heading);
  const sections = parsed.filter(s => s.heading);
  const bodyHtml = (!intro && !sections.length)
    ? `<p style="color:var(--text2);padding:0 38px 38px;">No rules written yet - click the edit icon to add them.</p>`
    : `
    ${sections.length ? `
    <div class="rule-toolbar">
      <div class="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>
        <input type="text" id="rule-search" placeholder="Search these rules...">
      </div>
      <button type="button" class="btn ghost sm" id="rule-expand-all">Expand All</button>
      <button type="button" class="btn ghost sm" id="rule-collapse-all">Collapse All</button>
    </div>` : ""}
    ${intro ? `<div class="playbook-content rule-intro">${intro.html}</div>` : ""}
    <div class="rule-sections">
      ${sections.map(s => {
        const ruleCount = (s.html.match(/<li|<p>/g)||[]).length;
        return `
        <details class="clients-stage-section rule-section-item">
          <summary class="clients-stage-header">
            <span class="clients-stage-dot"></span>
            <h3>${escapeHtml(s.heading)}</h3>
            <span class="kanban-count">${ruleCount || 0} rule${ruleCount===1?"":"s"}</span>
          </summary>
          <div class="playbook-content rule-section-body">${s.html || `<p style="color:var(--text2);">No detail added yet.</p>`}</div>
        </details>
      `;
      }).join("")}
    </div>
  `;
  viewer.innerHTML = `
    <div class="playbook-viewer-head">
      <div class="playbook-viewer-head-title">
        <span class="playbook-viewer-icon">${ruleIcon(r.title)}</span>
        <div><h3>${escapeHtml(r.title)}</h3><p>Updated ${fmtDate(r.updated_at||r.created_at)}</p></div>
      </div>
      <div class="playbook-viewer-actions">
        <button class="icon-btn" data-action="edit-rule" data-id="${r.id}" title="Edit">${ICONS.edit}</button>
        <button class="icon-btn" data-action="delete-rule" data-id="${r.id}" title="Delete">${ICONS.trash}</button>
      </div>
    </div>
    ${bodyHtml}
  `;
  wireRuleSectionControls();
}
// Search filters which section cards show at all (rather than just
// highlighting text) since the whole point is cutting down what you have to
// scan through - typing "budget" should leave only the relevant card(s)
// visible, open, and ready to read.
function wireRuleSectionControls(){
  const search = $("#rule-search");
  const items = $$(".rule-section-item");
  search?.addEventListener("input", () => {
    const q = search.value.trim().toLowerCase();
    items.forEach(el => {
      if (!q){ el.style.display = ""; el.open = false; return; }
      const matches = el.innerText.toLowerCase().includes(q);
      el.style.display = matches ? "" : "none";
      if (matches) el.open = true;
    });
  });
  $("#rule-expand-all")?.addEventListener("click", () => items.forEach(el => { el.open = true; }));
  $("#rule-collapse-all")?.addEventListener("click", () => items.forEach(el => { el.open = false; }));
}

/* ───────── Email Templates ───────── */
function renderEmailTemplates(){
  const listEl = $("#email-templates-list");
  const viewer = $("#email-template-viewer");
  if (!listEl || !viewer) return;
  const list = [...state.emailTemplates].sort((a,b) => (a.sort_order||0) - (b.sort_order||0));
  if (!list.length){
    listEl.innerHTML = "";
    viewer.innerHTML = `<div class="playbook-empty"><div class="playbook-empty-icon">${ICONS.book}</div>No email templates yet.<br>Add your first one so the whole team sends the same message.</div>`;
    return;
  }
  if (!state.selectedEmailTemplateId || !list.find(p => p.id === state.selectedEmailTemplateId)){
    state.selectedEmailTemplateId = list[0].id;
  }
  listEl.innerHTML = list.map(t => `
    <button type="button" class="playbook-list-item ${t.id === state.selectedEmailTemplateId ? "active" : ""}" data-action="select-email-template" data-id="${t.id}">
      <span class="playbook-list-item-icon">${ICONS.book}</span>
      <span class="playbook-list-item-text">
        <div class="playbook-list-item-title">${escapeHtml(t.title)}</div>
        <div class="playbook-list-item-sub">${escapeHtml(t.subject || "No subject set")}</div>
      </span>
    </button>
  `).join("");
  const t = list.find(x => x.id === state.selectedEmailTemplateId);
  viewer.innerHTML = `
    <div class="playbook-viewer-head">
      <div class="playbook-viewer-head-title">
        <span class="playbook-viewer-icon">${ICONS.book}</span>
        <div><h3>${escapeHtml(t.title)}</h3><p>Updated ${fmtDate(t.updated_at||t.created_at)}</p></div>
      </div>
      <div class="playbook-viewer-actions">
        <button class="icon-btn" data-action="edit-email-template" data-id="${t.id}" title="Edit">${ICONS.edit}</button>
        <button class="icon-btn" data-action="delete-email-template" data-id="${t.id}" title="Delete">${ICONS.trash}</button>
      </div>
    </div>
    <div class="email-template-field">
      <div class="email-template-field-head"><span>Subject</span><button type="button" class="btn ghost sm" data-action="copy-email-subject" data-id="${t.id}">Copy Subject</button></div>
      <div class="email-template-subject">${t.subject ? escapeHtml(t.subject) : `<span style="color:var(--text2);font-style:italic;">No subject set</span>`}</div>
    </div>
    <div class="email-template-field">
      <div class="email-template-field-head"><span>Body</span><button type="button" class="btn gold sm" data-action="copy-email-body" data-id="${t.id}">Copy Body</button></div>
      <div class="email-template-body">${t.body ? escapeHtml(t.body) : `<span style="color:var(--text2);font-style:italic;">No content yet - click the edit icon to write it.</span>`}</div>
    </div>
  `;
}
async function copyToClipboard(text, btn){
  try {
    await navigator.clipboard.writeText(text || "");
    if (btn){
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = original; }, 1500);
    }
  } catch {
    alert("Couldn't copy - your browser may be blocking clipboard access.");
  }
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
  if (!reviewQueue.length) { closeModal("qualify-modal"); checkOverdueTasksPopup(); return; }
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
    stage: answer === "not_qualified" ? "closed_lost" : answer,
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
  book: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 016.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"/></svg>`,
  phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.362 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.338 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>`,
  handshake: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 17l-1.5-1.5a2.12 2.12 0 010-3l4-4a2.12 2.12 0 013 0L18 10"/><path d="M8.5 15.5L4 11l4-4a2.12 2.12 0 013 0l.5.5"/><path d="M14 15l1.5 1.5a2.12 2.12 0 003 0l3-3"/><path d="M6 13l-3-3"/></svg>`,
  flag: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 22V4"/><path d="M4 4h13l-2 4 2 4H4"/></svg>`,
  megaphone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l18-5v12L3 13v-2z"/><path d="M11.6 16.8L13 21a2 2 0 01-3.8 1.3L7 17"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2v6h-6"/><path d="M3 12a9 9 0 0115-6.7L21 8"/><path d="M3 22v-6h6"/><path d="M21 12a9 9 0 01-15 6.7L3 16"/></svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l8 4v6c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6l8-4z"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15 15 0 010 20 15 15 0 010-20z"/></svg>`,
  search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg>`,
};

/* ───────── Modals ───────── */
function openModal(id){ $("#"+id).classList.add("visible"); }
function closeModal(id){ $("#"+id).classList.remove("visible"); }
function setupModals(){
  $("#onboarding-steps-list")?.addEventListener("focusout", async (e) => {
    const ta = e.target.closest?.(".onboarding-answer-textarea");
    if (!ta) return;
    await saveOnboardingAnswer(ta.dataset.id, ta.dataset.step, ta.value);
  });
  // Belt and braces: also autosave a moment after typing stops, rather than
  // only on blur - a re-render (realtime, or just switching clients) landing
  // before the field ever loses focus shouldn't be able to drop an answer.
  const onboardingAnswerTimers = {};
  $("#onboarding-steps-list")?.addEventListener("input", (e) => {
    const ta = e.target.closest?.(".onboarding-answer-textarea");
    if (!ta) return;
    const timerKey = ta.dataset.id + ":" + ta.dataset.step;
    clearTimeout(onboardingAnswerTimers[timerKey]);
    onboardingAnswerTimers[timerKey] = setTimeout(() => {
      saveOnboardingAnswer(ta.dataset.id, ta.dataset.step, ta.value);
    }, 800);
  });

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
      phone: toE164($("#contact-phone").value.trim(), $("#contact-country-code").value),
      status: $("#contact-status").value,
      tags: $("#contact-tags").value.trim(),
    };
    if (!row.name) return;
    if (id) await DataLayer.update("contacts", id, row);
    else await DataLayer.insert("contacts", row);
    closeModal("contact-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-playbook-btn")?.addEventListener("click", () => {
    $("#playbook-form").reset(); $("#playbook-form-id").value=""; $("#playbook-modal-title").textContent="Add Playbook";
    updateLivePreview("playbook-content");
    openModal("playbook-modal");
  });
  $("#playbook-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#playbook-form-id").value;
    const row = {
      title: $("#playbook-title").value.trim(),
      content: $("#playbook-content").value.trim(),
    };
    if (!row.title) return;
    if (id) await DataLayer.update("playbooks", id, row);
    else {
      row.sort_order = state.playbooks.length;
      const created = await DataLayer.insert("playbooks", row);
      if (created) state.selectedPlaybookId = created.id;
    }
    closeModal("playbook-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });
  // Nobody writing a playbook or rule should need to know the **bold**/##
  // markdown syntax by heart - these buttons apply it to the textarea
  // selection so juniors can format docs without a syntax guide. The
  // textarea itself can only ever show plain text (asterisks and hashes,
  // not actual bold), so without the live preview below it these buttons
  // look like they do nothing - the preview is what proves the click
  // actually worked. Scoped by the toolbar's data-target so the same markup
  // and handler serve every editor that includes it (Playbooks, Rules, ...).
  $$(".pb-toolbar-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const targetId = btn.closest(".pb-editor-toolbar")?.dataset.target;
      const ta = $("#" + targetId);
      if (!ta) return;
      const format = btn.dataset.pbFormat;
      const start = ta.selectionStart, end = ta.selectionEnd;
      const value = ta.value;
      if (format === "bold"){
        const selected = value.slice(start, end) || "bold text";
        ta.value = value.slice(0, start) + "**" + selected + "**" + value.slice(end);
        ta.focus();
        ta.setSelectionRange(start + 2, start + 2 + selected.length);
      } else {
        const lineStart = value.lastIndexOf("\n", start - 1) + 1;
        const prefix = format === "heading" ? "## " : "- ";
        ta.value = value.slice(0, lineStart) + prefix + value.slice(lineStart);
        const cursor = start + prefix.length;
        ta.focus();
        ta.setSelectionRange(cursor, cursor);
      }
      updateLivePreview(targetId);
    });
  });
  $("#playbook-content")?.addEventListener("input", () => updateLivePreview("playbook-content"));

  $("#add-rule-btn")?.addEventListener("click", () => {
    $("#rule-form").reset(); $("#rule-form-id").value=""; $("#rule-modal-title").textContent="Add Rule List";
    updateLivePreview("rule-content");
    openModal("rule-modal");
  });
  $("#rule-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#rule-form-id").value;
    const row = {
      title: $("#rule-title").value.trim(),
      content: $("#rule-content").value.trim(),
    };
    if (!row.title) return;
    if (id) await DataLayer.update("rules", id, row);
    else {
      row.sort_order = state.rules.length;
      const created = await DataLayer.insert("rules", row);
      if (created) state.selectedRuleId = created.id;
    }
    closeModal("rule-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });
  $("#rule-content")?.addEventListener("input", () => updateLivePreview("rule-content"));

  $("#add-email-template-btn")?.addEventListener("click", () => {
    $("#email-template-form").reset(); $("#email-template-form-id").value=""; $("#email-template-modal-title").textContent="Add Email Template";
    openModal("email-template-modal");
  });
  $("#email-template-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#email-template-form-id").value;
    const row = {
      title: $("#email-template-name").value.trim(),
      subject: $("#email-template-subject").value.trim(),
      body: $("#email-template-body").value.trim(),
    };
    if (!row.title) return;
    if (id) await DataLayer.update("email_templates", id, row);
    else {
      row.sort_order = state.emailTemplates.length;
      const created = await DataLayer.insert("email_templates", row);
      if (created) state.selectedEmailTemplateId = created.id;
    }
    closeModal("email-template-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-expense-btn")?.addEventListener("click", () => {
    $("#expense-form").reset(); $("#expense-form-id").value=""; $("#expense-date").value = todayDateStr(); $("#expense-modal-title").textContent="Add Expense";
    $("#expense-type").value = "expense";
    populateExpenseDealSelect();
    toggleExpenseTypeFields();
    openModal("expense-modal");
  });
  $("#expense-type")?.addEventListener("change", toggleExpenseTypeFields);
  $("#expense-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#expense-form-id").value;
    const type = $("#expense-type").value || "expense";
    const row = {
      title: $("#expense-title").value.trim(),
      type,
      category: $("#expense-category").value,
      amount: Number($("#expense-amount").value) || 0,
      frequency: $("#expense-frequency").value,
      expense_date: $("#expense-date").value || todayDateStr(),
      deal_id: type === "profit" ? ($("#expense-deal-select").value || null) : null,
      notes: $("#expense-notes").value.trim(),
    };
    if (!row.title) return;
    if (id) await DataLayer.update("expenses", id, row);
    else await DataLayer.insert("expenses", row);
    closeModal("expense-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#book-meeting-btn")?.addEventListener("click", () => {
    $("#book-meeting-form").reset();
    $("#book-meeting-slot-idx").value = "";
    $("#book-meeting-stage").value = "qualified";
    const assigneeSelect = $("#book-meeting-assignee");
    if (assigneeSelect && window.getActivePerson) assigneeSelect.value = window.getActivePerson();
    openModal("book-meeting-modal");
  });
  // Also opened directly from a "Meeting booked N" checklist row (see
  // window.openMeetingBookedPrompt below) - same modal, but pre-armed with
  // which slot to mark done so the celebration lands on the right row.
  window.openMeetingBookedPrompt = function(idx, x, y){
    $("#book-meeting-form").reset();
    $("#book-meeting-slot-idx").value = idx;
    $("#book-meeting-stage").value = "qualified";
    const assigneeSelect = $("#book-meeting-assignee");
    if (assigneeSelect && window.getActivePerson) assigneeSelect.value = window.getActivePerson();
    $("#book-meeting-form").dataset.x = x; $("#book-meeting-form").dataset.y = y;
    openModal("book-meeting-modal");
  };
  $("#book-meeting-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const name = $("#book-meeting-name").value.trim();
    const phone = $("#book-meeting-phone").value.trim();
    const company = $("#book-meeting-company").value.trim();
    const email = $("#book-meeting-email").value.trim();
    const person = $("#book-meeting-assignee").value;
    const stage = $("#book-meeting-stage").value;
    const slotIdx = $("#book-meeting-slot-idx").value;
    if (!name) return;
    const btnRect = $("#book-meeting-btn").getBoundingClientRect();
    const x = form.dataset.x ? Number(form.dataset.x) : btnRect.left + btnRect.width/2;
    const y = form.dataset.y ? Number(form.dataset.y) : btnRect.top + btnRect.height/2;
    delete form.dataset.x; delete form.dataset.y;
    const deal = await bookMeeting(name, phone, person, { company, email, stage });
    closeModal("book-meeting-modal");
    if (deal) window.bookMeetingInTracker?.(name, x, y, slotIdx);
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-deal-btn").addEventListener("click", () => {
    $("#deal-form").reset();
    $("#deal-form-id").value = "";
    $("#deal-contract-type").value = "retainer";
    $("#deal-assignee").value = "";
    toggleDealContractFields();
    $("#deal-modal-title").textContent = "New Deal";
    $("#deal-contacts-rows").innerHTML = "";
    addDealContactRow();
    openModal("deal-modal");
  });
  $("#deal-contract-type")?.addEventListener("change", toggleDealContractFields);
  $("#deal-add-contact-row-btn")?.addEventListener("click", () => addDealContactRow());
  $("#deal-detail-save-notes")?.addEventListener("click", () => { if (state.selectedDealId) addDealNote(state.selectedDealId); });
  $("#deal-detail-add-contact-btn")?.addEventListener("click", () => { if (state.selectedDealId) addExistingContactToDeal(state.selectedDealId); });
  $("#deal-contacts-rows")?.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".dc-remove");
    if (removeBtn) removeBtn.closest(".deal-contact-row")?.remove();
  });
  $("#deal-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#deal-form-id").value;
    const contactId = $("#deal-contact-select").value || null;
    const contractType = $("#deal-contract-type").value;
    const row = {
      title: $("#deal-title").value.trim(),
      contract_type: contractType,
      value: contractType === "retainer" ? Number($("#deal-value").value || 0) : 0,
      percentage: contractType === "retainer" ? null : Number($("#deal-percentage").value || 0),
      stage: $("#deal-stage").value,
      contact_id: contactId,
      contact_name: contactId ? contactName(contactId) : "",
      assignee: $("#deal-assignee").value || null,
      updated_at: new Date().toISOString(),
    };
    if (!row.title) return;
    const deal = id ? await DataLayer.update("deals", id, row) : await DataLayer.insert("deals", { ...row, notes: "" });
    if (deal) await saveDealContactRows(deal.id);
    if (deal) await maybeCreateClientFromDeal(deal);
    if (deal) await maybeCreateNoShowFollowup(deal);
    closeModal("deal-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#region-data-select")?.addEventListener("change", (e) => {
    state.regionDataFilter = e.target.value;
    renderRegionData();
  });

  $("#prospecting-coverage-btn")?.addEventListener("click", () => {
    renderCoverageMap();
    openModal("coverage-modal");
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

  $$("#dialer-add-btn, #prospecting-add-btn").forEach(btn => btn.addEventListener("click", () => {
    $("#prospect-form").reset(); $("#prospect-form-id").value=""; $("#prospect-modal-title").textContent="Add Prospect";
    openModal("prospect-modal");
  }));
  $("#prospect-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#prospect-form-id").value;
    const row = {
      name: $("#prospect-name").value.trim(),
      phone: toE164($("#prospect-phone").value.trim(), $("#prospect-country-code").value),
      company: $("#prospect-company").value.trim(),
      email: $("#prospect-email").value.trim(),
      website: $("#prospect-website").value.trim(),
      region: $("#prospect-region").value.trim(),
      industry: $("#prospect-industry").value.trim(),
      google_rating: $("#prospect-google-rating").value.trim(),
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

  $("#log-call-outcome")?.addEventListener("change", updateLogCallModalFields);
  $("#log-call-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#log-call-prospect-id").value;
    const outcome = $("#log-call-outcome").value;
    const note = $("#log-call-notes").value.trim();
    const region = $("#log-call-region").value.trim();
    const followupDate = $("#log-call-followup-date").value || null;
    closeModal("log-call-modal");
    await logDialOutcome(id, outcome, note, region, followupDate);
  });
  $("#prospecting-view-select")?.addEventListener("change", (e) => {
    state.prospectingView = e.target.value;
    renderProspectList();
  });

  $("#add-client-btn")?.addEventListener("click", () => {
    $("#client-form").reset(); $("#client-form-id").value="";
    $("#client-stage").innerHTML = CLIENT_STAGES.map(s => `<option value="${s.key}">${s.label}</option>`).join("");
    toggleClientQuoteTargetField();
    $("#client-modal-title").textContent="Add Client"; openModal("client-modal");
  });
  $("#client-stage")?.addEventListener("change", toggleClientQuoteTargetField);
  $("#client-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#client-form-id").value;
    const existing = id ? state.clients.find(x => x.id === id) : null;
    const stage = $("#client-stage").value || "onboarding";
    const row = {
      name: $("#client-name").value.trim(),
      cost_per_lead: $("#client-cpl").value !== "" ? Number($("#client-cpl").value) : null,
      monthly_ad_spend: $("#client-monthly-ad-spend").value !== "" ? Number($("#client-monthly-ad-spend").value) : null,
      quote_target: $("#client-quote-target").value !== "" ? Number($("#client-quote-target").value) : null,
      notes: $("#client-notes").value.trim(),
      meta_ad_account_id: $("#client-meta-account").value.trim(),
      ad_start_date: $("#client-ad-start-date").value || null,
      report_frequency: $("#client-report-frequency").value,
      report_email: $("#client-report-email").value.trim(),
      stage,
      updated_at: new Date().toISOString(),
    };
    if (!existing || existing.stage !== stage) row.stage_changed_at = new Date().toISOString();
    if (!row.name) return;
    if (id) await DataLayer.update("clients", id, row);
    else await DataLayer.insert("clients", row);
    closeModal("client-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#client-info-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#client-info-form-id").value;
    if (!id) return;
    const row = {
      services: $("#client-info-services-input").value.trim(),
      renewal_date: $("#client-info-renewal-input").value || null,
      client_rules: $("#client-info-rules-input").value.trim(),
      qualified_lead_structure: $("#client-info-qls-input").value.trim(),
      branding_expectations: $("#client-info-branding-input").value.trim(),
      key_contacts: $("#client-info-contacts-input").value.trim(),
      communication_preferences: $("#client-info-comms-input").value.trim(),
      updated_at: new Date().toISOString(),
    };
    await DataLayer.update("clients", id, row);
    closeModal("client-info-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-content-production-btn")?.addEventListener("click", () => {
    $("#content-form").reset(); $("#content-form-id").value=""; $("#content-modal-title").textContent="Add Content";
    populateContentClientSelect(state.contentFilter.client);
    openModal("content-modal");
  });
  $("#content-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#content-form-id").value;
    const row = {
      client_id: $("#content-client").value,
      title: $("#content-title").value.trim(),
      type: $("#content-type").value,
      status: $("#content-status").value,
      directions: $("#content-directions").value.trim(),
      script: $("#content-script").value.trim(),
      notes: $("#content-notes").value.trim(),
      updated_at: new Date().toISOString(),
    };
    if (!row.title || !row.client_id) return;
    if (id) await DataLayer.update("client_content", id, row);
    else await DataLayer.insert("client_content", row);
    closeModal("content-modal");
    if (!IS_CONFIGURED) return; renderAll();
  });
  $("#content-production-search")?.addEventListener("input", (e) => { state.contentFilter.search = e.target.value; renderContentProduction(); });
  $("#content-production-filter-client")?.addEventListener("change", (e) => { state.contentFilter.client = e.target.value; renderContentProduction(); });
  $("#content-production-filter-type")?.addEventListener("change", (e) => { state.contentFilter.type = e.target.value; renderContentProduction(); });

  $("#clients-gallery-search")?.addEventListener("input", (e) => { state.clientsGallerySearch = e.target.value; renderClientsList(); });
  $("#clients-gallery")?.addEventListener("change", async (e) => {
    const sel = e.target.closest(".client-stage-select");
    if (!sel) return;
    await DataLayer.update("clients", sel.dataset.id, { stage: sel.value, stage_changed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll();
  });

  $("#add-ad-creative-btn")?.addEventListener("click", () => {
    $("#ad-creative-form").reset(); $("#ad-creative-form-id").value=""; $("#ad-creative-modal-title").textContent="Add Ad Creative";
    $("#ad-creative-current-image").innerHTML = "";
    populateAdCreativeClientSelect(state.selectedClientId);
    populateAdCreativeCampaignSelect(state.selectedClientId);
    openModal("ad-creative-modal");
  });
  $("#add-creative-lib-btn")?.addEventListener("click", () => {
    $("#ad-creative-form").reset(); $("#ad-creative-form-id").value=""; $("#ad-creative-modal-title").textContent="Add Ad Creative";
    $("#ad-creative-current-image").innerHTML = "";
    populateAdCreativeClientSelect(state.creativeFilter.client);
    populateAdCreativeCampaignSelect(state.creativeFilter.client);
    openModal("ad-creative-modal");
  });
  $("#ad-creative-client")?.addEventListener("change", (e) => populateAdCreativeCampaignSelect(e.target.value));
  $("#creative-filter-client")?.addEventListener("change", (e) => { state.creativeFilter.client = e.target.value; renderCreativeLibrary(); });
  $("#creative-filter-result")?.addEventListener("change", (e) => { state.creativeFilter.result = e.target.value; renderCreativeLibrary(); });
  $("#creative-filter-delivery")?.addEventListener("change", (e) => { state.creativeFilter.delivery = e.target.value; renderCreativeLibrary(); });
  $("#creative-filter-sort")?.addEventListener("change", (e) => { state.creativeFilter.sort = e.target.value; renderCreativeLibrary(); });
  $("#creative-library-grid")?.addEventListener("change", async (e) => {
    const sel = e.target.closest(".creative-fatigue-select");
    if (!sel) return;
    await DataLayer.update("client_ad_creatives", sel.dataset.id, { fatigue_status: sel.value || null });
    if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll();
  });
  $("#ad-creative-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#ad-creative-form-id").value;
    const file = $("#ad-creative-image").files[0];
    const row = {
      client_id: $("#ad-creative-client").value,
      campaign_id: $("#ad-creative-campaign").value || null,
      name: $("#ad-creative-name").value.trim(),
      meta_ad_id: $("#ad-creative-meta-id").value.trim() || null,
      result: $("#ad-creative-result").value,
      notes: $("#ad-creative-notes").value.trim(),
    };
    if (!row.name || !row.client_id) return;
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
  $("#sync-client-ads-btn")?.addEventListener("click", () => syncClientAds(state.selectedClientId));
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
    renderTaskProspectInfo({});
    openModal("task-modal");
  });
  $("#task-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#task-form-id").value;
    const row = {
      title: $("#task-title").value.trim(),
      due_date: $("#task-due-date").value || null,
      priority: $("#task-priority").value,
      assignee: $("#task-assignee").value || null,
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
    if (action === "select-playbook"){ state.selectedPlaybookId = id; renderPlaybooks(); }
    if (action === "edit-playbook"){
      const p = state.playbooks.find(x => x.id === id);
      if (!p) return;
      $("#playbook-form-id").value = p.id;
      $("#playbook-title").value = p.title||"";
      $("#playbook-content").value = p.content||"";
      $("#playbook-modal-title").textContent = "Edit Playbook";
      updateLivePreview("playbook-content");
      openModal("playbook-modal");
    }
    if (action === "delete-playbook" && confirm("Delete this playbook?")){
      if (state.selectedPlaybookId === id) state.selectedPlaybookId = null;
      await DataLayer.remove("playbooks", id);
    }
    if (action === "select-rule"){ state.selectedRuleId = id; renderRules(); }
    if (action === "edit-rule"){
      const r = state.rules.find(x => x.id === id);
      if (!r) return;
      $("#rule-form-id").value = r.id;
      $("#rule-title").value = r.title||"";
      $("#rule-content").value = r.content||"";
      $("#rule-modal-title").textContent = "Edit Rule List";
      updateLivePreview("rule-content");
      openModal("rule-modal");
    }
    if (action === "delete-rule" && confirm("Delete this rule list?")){
      if (state.selectedRuleId === id) state.selectedRuleId = null;
      await DataLayer.remove("rules", id);
    }
    if (action === "select-email-template"){ state.selectedEmailTemplateId = id; renderEmailTemplates(); }
    if (action === "edit-email-template"){
      const t = state.emailTemplates.find(x => x.id === id);
      if (!t) return;
      $("#email-template-form-id").value = t.id;
      $("#email-template-name").value = t.title||"";
      $("#email-template-subject").value = t.subject||"";
      $("#email-template-body").value = t.body||"";
      $("#email-template-modal-title").textContent = "Edit Email Template";
      openModal("email-template-modal");
    }
    if (action === "delete-email-template" && confirm("Delete this email template?")){
      if (state.selectedEmailTemplateId === id) state.selectedEmailTemplateId = null;
      await DataLayer.remove("email_templates", id);
    }
    if (action === "copy-email-subject"){
      const t = state.emailTemplates.find(x => x.id === id);
      await copyToClipboard(t?.subject, btn);
    }
    if (action === "copy-email-body"){
      const t = state.emailTemplates.find(x => x.id === id);
      await copyToClipboard(t?.body, btn);
    }
    if (action === "edit-expense"){
      const ex = state.expenses.find(x => x.id === id);
      if (!ex) return;
      $("#expense-form-id").value = ex.id;
      $("#expense-type").value = ex.type||"expense";
      $("#expense-title").value = ex.title||"";
      $("#expense-category").value = ex.category||"other";
      $("#expense-amount").value = ex.amount||0;
      $("#expense-frequency").value = ex.frequency||"one_off";
      $("#expense-date").value = ex.expense_date||todayDateStr();
      populateExpenseDealSelect();
      $("#expense-deal-select").value = ex.deal_id||"";
      $("#expense-notes").value = ex.notes||"";
      toggleExpenseTypeFields();
      $("#expense-modal-title").textContent = "Edit Expense";
      openModal("expense-modal");
    }
    if (action === "delete-expense" && confirm("Delete this expense?")) await DataLayer.remove("expenses", id);
    if (action === "toggle-checklist-item"){
      const container = btn.closest(".playbook-content");
      const pbId = container?.dataset.playbook;
      const idx = btn.dataset.idx;
      if (pbId != null && idx != null){
        const st = getPlaybookChecklist(pbId);
        st[idx] = !st[idx];
        savePlaybookChecklist(pbId, st);
        btn.classList.toggle("checked", !!st[idx]);
        const items = container.querySelectorAll(".pb-check-item");
        const doneCount = container.querySelectorAll(".pb-check-item.checked").length;
        const fill = $("#playbook-progress-fill");
        const text = $("#playbook-progress-text");
        if (fill) fill.style.width = Math.round(doneCount / items.length * 100) + "%";
        if (text) text.textContent = `${doneCount} of ${items.length} steps complete`;
      }
    }
    if (action === "reset-checklist" && confirm("Reset progress on this checklist?")){
      savePlaybookChecklist(id, {});
      renderPlaybooks();
    }
    if (action === "delete-deal" && confirm("Delete this deal?")) await DataLayer.remove("deals", id);
    if (action === "view-deal"){ state.selectedDealId = id; renderDeals(); }
    if (action === "view-meeting-deal"){ state.selectedDealId = id; $('.nav-item[data-page="deals"]')?.click(); renderDeals(); }
    if (action === "edit-deal"){
      const d = state.deals.find(x => x.id === (id || state.selectedDealId));
      if (!d) return;
      $("#deal-form-id").value = d.id;
      $("#deal-title").value = d.title||"";
      $("#deal-contact-select").value = d.contact_id||"";
      $("#deal-contract-type").value = d.contract_type||"retainer";
      $("#deal-value").value = d.value||0;
      $("#deal-percentage").value = d.percentage||0;
      $("#deal-stage").value = d.stage||"qualified";
      $("#deal-assignee").value = d.assignee||"";
      toggleDealContractFields();
      $("#deal-contacts-rows").innerHTML = "";
      $("#deal-modal-title").textContent = "Edit Deal";
      openModal("deal-modal");
      // Demo mode re-renders after every click, which rebuilds this dropdown's
      // options and wipes the selection just set above - reapply on next tick.
      setTimeout(() => { $("#deal-contact-select").value = d.contact_id||""; }, 0);
    }
    if (action === "back-to-deals"){ state.selectedDealId = null; renderDeals(); }
    if (action === "mark-deal-called") await markDealCalled(state.selectedDealId);
    if (action === "delete-prospect" && confirm("Delete this prospect?")) await DataLayer.remove("dial_prospects", id);
    if (action === "edit-prospect"){
      const p = state.prospects.find(x => x.id === id);
      if (!p) return;
      $("#prospect-form-id").value = p.id;
      $("#prospect-name").value = p.name||"";
      const { code, local } = splitE164(p.phone);
      $("#prospect-country-code").value = code;
      $("#prospect-phone").value = local;
      $("#prospect-company").value = p.company||"";
      $("#prospect-email").value = p.email||"";
      $("#prospect-website").value = p.website||"";
      $("#prospect-region").value = p.region||"";
      $("#prospect-industry").value = p.industry||"";
      $("#prospect-google-rating").value = p.google_rating||"";
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
    if (action === "log-prospect-call"){
      openLogCallModal(state.prospects.find(x => x.id === id), "no_answer");
    }
    if (action === "dial-tel") await logDialOutcome(id, "dialed");
    if (action === "start-call") await startCall(id);
    if (action === "dial-outcome"){
      // Call Back and Not Interested both need a required field captured
      // (a follow-up date, or a reason why) that a one-click button can't
      // supply, so those two route through the same modal Prospecting uses
      // instead of logging instantly like No Answer / Booked Meeting do.
      if (outcome === "call_back" || outcome === "not_interested"){
        openLogCallModal(state.prospects.find(x => x.id === id), outcome);
      } else {
        await logDialOutcome(id, outcome);
      }
    }
    if (action === "reactivate-prospect") await reactivateProspect(id);
    if (action === "view-client"){ state.selectedClientId = id; renderClients(); $('.nav-item[data-page="clients"]')?.click(); }
    if (action === "back-to-clients"){ state.selectedClientId = null; renderClients(); }
    if (action === "view-onboarding-client"){ state.selectedOnboardingClientId = id; renderOnboarding(); }
    if (action === "back-to-onboarding"){ state.selectedOnboardingClientId = null; renderOnboarding(); }
    if (action === "toggle-onboarding-step"){
      const c = state.clients.find(x => x.id === id);
      if (!c) return;
      const stepKey = btn.dataset.step;
      const progress = { ...(c.onboarding_progress || {}) };
      if (progress[stepKey]) delete progress[stepKey]; else progress[stepKey] = true;
      await DataLayer.update("clients", id, { onboarding_progress: progress });
      if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll();
    }
    if (action === "complete-onboarding" && confirm("Mark onboarding complete and move this client to Month 1?")){
      await DataLayer.update("clients", id, { stage: "month_1", stage_changed_at: new Date().toISOString() });
      state.selectedOnboardingClientId = null;
      if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll();
    }
    if (action === "edit-client-header"){
      const c = state.clients.find(x => x.id === state.selectedClientId);
      if (c) openEditClientModal(c);
    }
    if (action === "onboarding-edit-client"){
      const c = state.clients.find(x => x.id === id);
      if (c) openEditClientModal(c);
    }
    if (action === "edit-client-info"){
      const c = state.clients.find(x => x.id === state.selectedClientId);
      if (!c) return;
      $("#client-info-form-id").value = c.id;
      $("#client-info-services-input").value = c.services||"";
      $("#client-info-renewal-input").value = c.renewal_date||"";
      $("#client-info-rules-input").value = c.client_rules||"";
      $("#client-info-qls-input").value = c.qualified_lead_structure||"";
      $("#client-info-branding-input").value = c.branding_expectations||"";
      $("#client-info-contacts-input").value = c.key_contacts||"";
      $("#client-info-comms-input").value = c.communication_preferences||"";
      openModal("client-info-modal");
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
      populateContentClientSelect(p.client_id);
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
      populateAdCreativeClientSelect(a.client_id);
      populateAdCreativeCampaignSelect(a.client_id, a.campaign_id);
      $("#ad-creative-name").value = a.name||"";
      $("#ad-creative-meta-id").value = a.meta_ad_id||"";
      $("#ad-creative-result").value = a.result||"testing";
      $("#ad-creative-notes").value = a.notes||"";
      $("#ad-creative-image").value = "";
      $("#ad-creative-current-image").innerHTML = a.image_url ? `<img src="${escapeHtml(a.image_url)}" class="ad-creative-thumb">` : "";
      $("#ad-creative-modal-title").textContent = "Edit Ad Creative";
      openModal("ad-creative-modal");
    }
    if (action === "delete-ad-creative" && confirm("Delete this ad creative?")) await DataLayer.remove("client_ad_creatives", id);
    if (action === "refresh-creative-insights") await refreshCreativeInsights(id);
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
    if (action === "edit-task") openEditTaskModal(id);
    if (action === "view-overdue-task"){ closeModal("overdue-tasks-modal"); openEditTaskModal(id); }
    if (action === "delete-task" && confirm("Delete this task?")) await DataLayer.remove("tasks", id);
    if (action === "send-report-now") await sendReportNow(id);
    if (action === "view-report-history") renderReportHistoryModal(id);
    if (action === "edit-contact"){
      const c = state.contacts.find(x => x.id === id);
      if (!c) return;
      $("#contact-form-id").value = c.id;
      $("#contact-name").value = c.name||"";
      $("#contact-company").value = c.company||"";
      $("#contact-email").value = c.email||"";
      const { code, local } = splitE164(c.phone);
      $("#contact-country-code").value = code;
      $("#contact-phone").value = local;
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
// Dialer and Prospecting both read/filter the same shared prospect list, so
// a filter changed on either page re-renders both.
function renderProspectViews(){ renderDialer(); renderProspectList(); }
function setupDialerFilters(){
  $("#dialer-search")?.addEventListener("input", (e) => { state.dialerFilter.search = e.target.value; renderProspectViews(); });
  $("#dialer-filter-region")?.addEventListener("change", (e) => { state.dialerFilter.region = e.target.value; renderProspectViews(); });
  $("#dialer-filter-industry")?.addEventListener("change", (e) => { state.dialerFilter.industry = e.target.value; renderProspectViews(); });
  $("#prospecting-search")?.addEventListener("input", (e) => { state.dialerFilter.search = e.target.value; renderProspectViews(); });
  $("#prospecting-filter-region")?.addEventListener("change", (e) => { state.dialerFilter.region = e.target.value; renderProspectViews(); });
  $("#prospecting-filter-industry")?.addEventListener("change", (e) => { state.dialerFilter.industry = e.target.value; renderProspectViews(); });
  $("#prospecting-filter-caller")?.addEventListener("change", (e) => { state.dialerFilter.caller = e.target.value; renderProspectViews(); });
  // Delegated because the focus selects are rebuilt on every render (see
  // renderTeamFocusPanel) - a direct per-id listener would be wiped out.
  $("#prospecting-team-focus")?.addEventListener("change", (e) => {
    const select = e.target.closest("[data-team-focus-person]");
    if (select) saveTeamFocus(select.dataset.teamFocusPerson, select.value || null);
  });
}
function setupTaskFilters(){
  $("#task-status-filter")?.addEventListener("change", (e) => { state.taskFilter.status = e.target.value; renderTasks(); });
  $("#task-priority-filter")?.addEventListener("change", (e) => { state.taskFilter.priority = e.target.value; renderTasks(); });
  $("#task-sort")?.addEventListener("change", (e) => { state.taskFilter.sort = e.target.value; renderTasks(); });
  $("#task-assignee-filter")?.addEventListener("change", (e) => {
    state.taskFilter.assignee = e.target.value;
    setAssigneeFirstPref(e.target.value || getAssigneeFirstPref());
    renderTasks();
  });
}

function setupAnalyticsFilters(){
  // Delegated because the playbook selects are rebuilt on every render
  // (see renderPlaybookUsagePicker) - a direct per-id listener would only
  // survive until the first re-render wiped it out.
  $("#playbook-usage-cards")?.addEventListener("change", (e) => {
    const select = e.target.closest("[data-playbook-person]");
    if (select) savePlaybookUsage(select.dataset.playbookPerson, select.value || null);
  });
}

function setupStatisticsFilters(){
  const fromField = $("#stats-custom-from-field");
  const toField = $("#stats-custom-to-field");
  $("#stats-person-filter")?.addEventListener("change", (e) => {
    state.statsFilter.person = e.target.value;
    renderStatistics();
  });
  $("#stats-range-filter")?.addEventListener("change", (e) => {
    state.statsFilter.range = e.target.value;
    const isCustom = e.target.value === "custom";
    if (fromField) fromField.style.display = isCustom ? "" : "none";
    if (toField) toField.style.display = isCustom ? "" : "none";
    renderStatistics();
  });
  $("#stats-custom-from")?.addEventListener("change", (e) => { state.statsFilter.customFrom = e.target.value; renderStatistics(); });
  $("#stats-custom-to")?.addEventListener("change", (e) => { state.statsFilter.customTo = e.target.value; renderStatistics(); });
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
  populateRegionIndustrySelects();
  setupSearchFilters();
  setupTeam();
  setupQualifyModal();
  setupCalendarNav();
  setupDialerImport();
  setupImportRegionIndustryModal();
  setupLeadImport();
  setupDialerFilters();
  setupCallWidget();
  setupTaskFilters();
  setupAnalyticsFilters();
  setupStatisticsFilters();
  initAuth();
});
})();
