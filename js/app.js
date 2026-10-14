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
  { key: "onboarding", label: "Onboarding" },
  { key: "pending_results", label: "Pending Results" },
  { key: "closed_won", label: "Closed Won MRR" },
  { key: "closed_won_adhoc", label: "Closed Won Adhoc" },
  { key: "closed_lost", label: "Closed Lost" },
  { key: "disqualified", label: "Disqualified" },
  { key: "ghosted", label: "Ghosted" },
];
const CLOSED_STAGES = new Set(["closed_won", "closed_won_adhoc", "closed_lost", "disqualified", "ghosted"]);
// Closed Won Adhoc = one-off jobs. They count as wins everywhere (win rate,
// stats) but never as MRR, and stay out of Commission / auto-Client creation.
const ADHOC_STAGE = "closed_won_adhoc";
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
// How a creative is performing. The stored values are the original ones
// (winner / testing / killed) so every existing creative keeps its rating;
// only the labels changed. "engagement" is retired - no longer offered, but
// old engagement posts keep their tag.
const AD_RESULTS = {
  winner: { label: "Top Performer", cls: "green" },
  testing: { label: "Average Performer", cls: "gold" },
  killed: { label: "Low Performer", cls: "red" },
  engagement: { label: "Engagement Post", cls: "blue", retired: true },
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
  gabriel: { label: "Gabriel", cls: "purple" },
  raheem: { label: "Randy", cls: "green" },
  thor: { label: "Thor", cls: "red" },
};
// Real login emails don't reliably reduce to their ASSIGNEES key (Max's is
// maximus.smith@..., not max@...), so this is an explicit map rather than a
// guess from the email's local part. Keep in sync with the allowlist.
// The "raheem" key is Randy - his email is raheem.raza.khawaja@..., but he
// goes by Randy, so the key stayed as-is (renaming it would orphan any
// historical data already tagged "raheem") and only the display label
// changed.
const EMAIL_TO_ASSIGNEE = {
  "rockyoneill02@gmail.com": "rocky",
  "maximus.smith@mrpriceless.com": "max",
  "gabriel.irvan@mrpriceless.com": "gabriel",
  "thrkamhadi810@gmail.com": "thor",
  "raheem.raza.khawaja@gmail.com": "raheem",
};
// Gabriel is a sales-only hire - Service Delivery stays Rocky/Max only.
const DELIVERY_RESTRICTED_EMAILS = new Set([
  "gabriel.irvan@mrpriceless.com",
]);
function canAccessDelivery(){
  const email = (state.user?.email || "").toLowerCase();
  return !DELIVERY_RESTRICTED_EMAILS.has(email);
}
// Team Focus (who's pointed at which vertical) is Rocky's call to make, not
// something everyone should be able to reassign for each other.
function isRocky(){
  return (state.user?.email || "").toLowerCase() === "rockyoneill02@gmail.com";
}
function isMax(){
  return (state.user?.email || "").toLowerCase() === "maximus.smith@mrpriceless.com";
}
// Lead Engine (vertical assignments + region coverage) is Rocky and Max
// only - everyone else just works whatever vertical they've been pointed
// at from Prospecting, they don't get to reassign it.
function canAccessLeadEngine(){
  return isRocky() || isMax();
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
// The country a region is in decides the country code a phone number
// without one gets - an NZ list imported under an NZ region must come out
// +64, not the AU default.
function countryCodeForRegion(region){
  if (NZ_REGIONS.includes(region)) return "64";
  return "61";
}
// One-off repair for prospects imported before the fix above: an NZ-region
// prospect saved as +61 gets its country code swapped to +64, but only when
// the rest of the number is shaped like an NZ number (mobile 02x, 8-digit
// landline, 0800/0508) - a genuinely Australian number (e.g. an AU mobile,
// 9 digits starting with 4) is left alone. Runs after each sign-in and is a
// no-op once nothing matches.
const NZ_NATIONAL_NUMBER = /^(2\d{7,9}|[34679]\d{7}|800\d{6,7}|508\d{6})$/;
function nzFixedPhone(p){
  if (!NZ_REGIONS.includes(p.region) || !(p.phone||"").startsWith("+61")) return null;
  const national = p.phone.slice(3);
  return NZ_NATIONAL_NUMBER.test(national) ? "+64" + national : null;
}
async function repairNzProspectCountryCodes(){
  const fixes = state.prospects.map(p => ({ p, phone: nzFixedPhone(p) })).filter(x => x.phone);
  if (!fixes.length) return 0;
  const now = new Date().toISOString();
  for (const { p, phone } of fixes){
    if (IS_CONFIGURED){
      const { error } = await supabase.from("dial_prospects").update({ phone, updated_at: now }).eq("id", p.id);
      if (error){ console.warn("NZ phone repair failed for", p.id, error.message); continue; }
    }
    p.phone = phone; p.updated_at = now;
  }
  console.info(`Fixed ${fixes.length} NZ prospect number(s) that had an AU +61 prefix.`);
  return fixes.length;
}
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
  const indList = $("#client-industry-options"); if (indList) indList.innerHTML = [...HOME_SERVICES_INDUSTRIES, "Real Estate", "Dental", "Legal", "Other"].map(o => `<option value="${escapeHtml(o)}">`).join("");
}
const OUTCOMES = {
  no_answer: { label: "No Answer", cls: "gray" },
  dm_unavailable: { label: "Decision Maker Unavailable", cls: "gray" },
  call_back: { label: "Call Back", cls: "gold" },
  not_interested: { label: "Not Interested", cls: "red" },
  disqualified: { label: "Disqualified", cls: "purple" },
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
  ppl: { label: "Pay Per Lead", cls: "purple" },
};
function dealValueLabel(d){
  if (d.contract_type === "profit_share" || d.contract_type === "revenue_share"){
    return `${Number(d.percentage||0)}% ${CONTRACT_TYPES[d.contract_type].label}`;
  }
  if (d.contract_type === "ppl") return `${fmtMoney(d.value)} / lead`;
  return fmtMoney(d.value);
}
// What the business actually nets after the rep's cut - only meaningful for
// a flat monthly retainer value (percentage-based profit/revenue share deals
// have no fixed $ to net against, so this returns null for those).
function dealNetValue(d){
  const commission = Number(d.commission_initial_amount || 0);
  if (!commission || d.contract_type === "profit_share" || d.contract_type === "revenue_share") return null;
  return Number(d.value||0) - commission;
}
// Commission is monthly and tied to the client's own invoice cycle (due at
// the end of every month) rather than a fixed post-close schedule - that's
// why the due date has to be computed off each deal's own invoice date
// instead of just deal.created_at. The elevated rate varies deal to deal
// (set manually, no fixed formula), so it's stored per deal; the steady
// rate it steps down to after 6 months is the same for everyone.
const COMMISSION_STEADY_RATE = 250;
const COMMISSION_ELEVATED_MONTHS = 6;
function monthsBetween(anchor, ref){
  return (ref.getFullYear()-anchor.getFullYear())*12 + (ref.getMonth()-anchor.getMonth()) - (ref.getDate()<anchor.getDate()?1:0);
}
// A won/pending deal gets a real Client record spun up automatically (see
// maybeCreateClientFromDeal) linked back via client.source_deal_id - this is
// what lets the deal's own commission_invoice_date and the client's own Ad
// Start Date ("so we know when to invoice them") stay one and the same
// date instead of two fields someone has to remember to keep in sync.
function clientForDeal(dealId){
  return state.clients.find(c => c.source_deal_id === dealId) || null;
}
// Returns null for a deal with no commission set up yet. monthsIn is how
// many full months have passed since the client's invoice date - once that
// hits 6, the rate drops from the deal's own elevated amount to the flat
// steady rate. dueDate is always the end of the relevant month: the current
// month once the invoice date has passed, or the invoice date's own month
// if it's still upcoming.
function commissionForDeal(d, refDate = new Date()){
  const invoiceDate = clientForDeal(d.id)?.ad_start_date || d.commission_invoice_date;
  if (!invoiceDate || d.commission_initial_amount == null) return null;
  const anchor = new Date(invoiceDate);
  const monthsIn = Math.max(0, monthsBetween(anchor, refDate));
  const elevated = monthsIn < COMMISSION_ELEVATED_MONTHS;
  const amount = elevated ? Number(d.commission_initial_amount) : COMMISSION_STEADY_RATE;
  const base = refDate < anchor ? anchor : refDate;
  const dueDate = new Date(base.getFullYear(), base.getMonth()+1, 0);
  return { amount, elevated, monthsIn, dueDate };
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
  { key: "live", label: "Live", days: null, cls: "green" },
  { key: "at_risk", label: "At Risk", days: null, cls: "red" },
  { key: "churned", label: "Churned", days: null, cls: "gray" },
];
// The old Month 1/2/3, Established and New Creatives Due stages are all just
// "Live" now (the card shows which month they're in), so older clients map across.
const LEGACY_LIVE_STAGES = new Set(["month_1", "month_2", "month_3", "established", "creatives_due"]);
const normalizeClientStage = (s) => LEGACY_LIVE_STAGES.has(s) ? "live" : (s || "onboarding");
// Which month of ads they're in, from when ads started (or when they went live).
function clientMonthNumber(c){
  const start = c.ad_start_date || (c.onboarding_progress || {}).live_at;
  if (!start) return null;
  const d = new Date(String(start).slice(0, 10) + "T00:00:00"), now = new Date();
  return Math.max(1, (now.getFullYear() - d.getFullYear()) * 12 + now.getMonth() - d.getMonth() + (now.getDate() >= d.getDate() ? 1 : 0));
}
const CLIENT_STAGE_MAP = Object.fromEntries(CLIENT_STAGES.map(s => [s.key, s]));
const ARCHIVED_STAGE = "archived";
const archivedClientName = (id) => (state.archivedClients || []).find(c => c.id === id)?.name || "";
// An archived client's campaigns, content, reports and leads stay in the
// database but out of the CRM - only their ad creatives stay visible.
function dropArchivedClientData(){
  const gone = new Set((state.archivedClients || []).map(c => c.id));
  if (!gone.size) return;
  const keep = (x) => !gone.has(x.client_id);
  state.clientContent = state.clientContent.filter(keep);
  state.campaigns = state.campaigns.filter(keep);
  state.clientReports = (state.clientReports || []).filter(keep);
  state.clientLeads = (state.clientLeads || []).filter(keep);
}
// The fields that make a client's profile genuinely useful to anyone on the
// team - drives the completeness bar on the Client Info card and kanban card.
const CLIENT_INFO_FIELDS = [
  { key: "services", label: "Services", hint: "What we deliver for them - so anyone can explain it without asking." },
  // Optional: ad-hoc clients have no contract to renew, so it never counts
  // against their profile completeness.
  { key: "renewal_date", label: "Renewal / Review Date", hint: "When to revisit the contract or scope.", isDate: true, optional: true },
  { key: "key_contacts", label: "Key Contacts", hint: "Who the decision makers are and how to reach them." },
  { key: "qualified_lead_structure", label: "Qualified Lead Structure", hint: "What actually counts as a good lead for this client - fills in automatically from the lead essentials on their Onboarding launch." },
];
function clientProfileCompleteness(c){
  const required = CLIENT_INFO_FIELDS.filter(f => !f.optional);
  const filled = required.filter(f => c[f.key] != null && String(c[f.key]).trim() !== "").length;
  return { filled, total: required.length, pct: Math.round(filled / required.length * 100) };
}
// IMPORTANT: each step's saved progress is keyed by its own explicit `key`
// below (not its position in this array) - so items can be freely reordered,
// moved between sections, or have new ones inserted anywhere, without
// disturbing any client's already-ticked progress. A key must never be
// reused for a different step or renamed once clients have real progress
// against it - add a new key instead and leave the old one retired.
const ONBOARDING_SECTIONS = [
  { section: "Get Started", items: [
    { key: "welcome_email", text: "Send the welcome email." },
    { key: "client_website", text: "Add their website link.", derivedFrom: "website" },
    { key: "client_phone", text: "Add their phone number.", derivedFrom: "phone" },
    { key: "client_email", text: "Add their email address.", derivedFrom: "email" },
    { key: "ghl_template", text: "Set up their GHL CRM pipeline template ahead of time, so it's ready to demo." },
  ]},
  { section: "Set Honest Expectations", items: [
    { key: "honest_expect_1", text: "Explain that conversion rates and sales cycles on paid leads run lower than word of mouth - word of mouth is still the best lead source in business, the problem is it's unpredictable and hard to scale, which is exactly the gap paid ads fill." },
    { key: "honest_expect_2", text: "Be upfront that they might not see a sale in month one if their sales cycle runs a bit longer than that." },
  ]},
  { section: "Define What A Good Lead Looks Like For Them", items: [
    { key: "good_lead_1", text: "Ask what they consider a job they're happy to quote for.", answerable: true, fieldLabel: "What Counts As A Good Lead" },
    { key: "good_lead_2", text: "Confirm their budget and timeline expectations.", answerable: true, fieldLabel: "Budget & Timeline Expectations" },
    { key: "good_lead_3", text: "Confirm their average job value.", answerable: true, fieldLabel: "Average Job Value" },
    { key: "good_lead_5", text: "Confirm how far out from their base they're willing to quote.", answerable: true, fieldLabel: "Service Radius" },
    { key: "good_lead_6", text: "Confirm whether they can quote after hours or on weekends.", answerable: true, fieldLabel: "After-Hours / Weekend Quoting" },
  ]},
  { section: "Meta & CRM Access", items: [
    { key: "meta_partner_access", text: "Get full partner access on their Meta ad account." },
    { key: "fb_page_access", text: "On their Facebook Page, get access to Content, Ads, Insights, Leads, Creator Content, and Creator Management." },
    { key: "meta_ad_account_id", text: "Add their Meta Ad Account ID to Clients, so their campaigns and creatives start syncing in automatically.", derivedFrom: "meta_ad_account_id" },
    { key: "ghl_report_connect", text: "Sync GHL with the CRM for reporting." },
    { key: "crm_login", text: "Send their login and confirm they can get in." },
    { key: "crm_auto_text", text: "Mention they'll get an automated text the moment a quote is booked, plus a reminder an hour before it's due." },
  ]},
  { section: "Demo The CRM", items: [
    { key: "demo_2", text: "Walk them through Opportunities - the leads that sync straight in from Meta." },
    { key: "demo_3", text: "Show them where to add notes, and stress how important it is to drag leads through the stages - that feedback is what we use to optimise targeting back on Meta." },
    { key: "demo_5", text: "Walk through Document Storage - this is where they upload before/after job photos for us, plus a photo of themselves and one of the whole team, to use in ads." },
  ]},
  { section: "Set Up Their Calendar", items: [
    { key: "cal_block_slots", text: "Explain that quotes get booked straight into whatever shows as free, so every slot they're not available - including travel to and from quotes - needs to be blocked off, and they can set this up as recurring events for their regular hours." },
    { key: "cal_share_max", text: "Share their calendar access with Max." },
    { key: "cal_sync_ghl", text: "Set up 2-way calendar sync with GHL, so bookings and their calendar stay lined up on both sides." },
  ]},
  { section: "Lock In The Ongoing Cadence", items: [
    { key: "cadence_catchup", text: "Set up a recurring fortnightly catch-up to go through progress, goals, and the pipeline together." },
  ]},
  { section: "Launch Prep", items: [
    { key: "launch_creatives", text: "Add 2 proven High Performer ad creatives, plus 1 new Test creative, into their ad account." },
    { key: "fb_lead_form", text: "Create a Facebook Lead Form based on their requirements." },
    { key: "zapier_setup", text: "Get Max to set up the Zapier integration, connecting the new lead form through to GHL." },
    { key: "ad_start_date", text: "Add the date we start running their ads to Clients, so we know when to invoice them.", derivedFrom: "ad_start_date" },
  ]},
];
const ONBOARDING_ANSWER_SUFFIX = "_answer";
const ONBOARDING_STEPS = ONBOARDING_SECTIONS.flatMap((s) => s.items.map((item) => ({
  key: item.key,
  section: s.section,
  label: item.text,
  answerable: Boolean(item.answerable),
  fieldLabel: item.fieldLabel || null,
  derivedFrom: item.derivedFrom || null,
  targetField: item.targetField || null,
})));
// Builds the client's Qualified Lead Structure text from every answered
// onboarding qualifying question, so it's always a live mirror of what was
// actually said on the call rather than something typed up separately after.
// Steps with their own targetField (e.g. Key Contacts) write straight to
// that field instead and are excluded from this composite.
function composeQualifiedLeadStructure(progress){
  return ONBOARDING_STEPS
    .filter(s => s.answerable && !s.targetField)
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
  const step = ONBOARDING_STEPS.find(s => s.key === stepKey);
  const progress = { ...(c.onboarding_progress || {}) };
  progress[stepKey + ONBOARDING_ANSWER_SUFFIX] = value;
  c.onboarding_progress = progress;
  const updates = { onboarding_progress: progress };
  if (step && step.targetField){
    c[step.targetField] = value;
    updates[step.targetField] = value;
  } else {
    const qualified_lead_structure = composeQualifiedLeadStructure(progress);
    c.qualified_lead_structure = qualified_lead_structure;
    updates.qualified_lead_structure = qualified_lead_structure;
  }
  await DataLayer.update("clients", clientId, updates);
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
  archivedClients: [],
  creativeSnapshots: [],
  clientLeads: [],
  completedVerticals: [],
  playbookUsage: [],
  selectedClientId: null,
  selectedDealId: null,
  coverageIndustry: "",
  expandedStages: {},
  dialerFilter: { search: "", region: "", industry: "", caller: "" },
  dialerCountry: (() => { try { const c = localStorage.getItem("mp_dialer_country"); return c === "NZ" || c === "AU" ? c : "AU"; } catch(e){ return "AU"; } })(),
  // Separate from dialerFilter (which is shared with the Prospecting page's
  // deliberately-shared master list) - this only scopes the Dialler itself,
  // defaulting to whoever's currently dialing so one person's freshly
  // imported leads don't show up mixed into a teammate's queue by surprise.
  // null (not "") is the "never touched yet" sentinel - see renderDialer(),
  // which re-defaults it to the active person on every render until the
  // user explicitly picks something (including "Everyone's Leads", which
  // sets it to "" - an actual, sticky choice, not the same as null).
  dialerOwnerFilter: null,
  dialerQueueView: "active",
  prospectingView: "active",
  regionDataFilter: "",
  prospectingCollapsedRegions: new Set(),
  teamFocus: { rocky: null, max: null, gabriel: null, raheem: null, thor: null },
  taskFilter: { status: "open", priority: "", sort: "due_date", assignee: "" },
  team: [],
  contactFilter: "",
  contactSearch: "",
  creativeFilter: { client: "", result: "", delivery: "", sort: "top" },
  creativeSegOpen: new Set(),
  contentFilter: { search: "", client: "", type: "" },
  clientsGallerySearch: "",
  clientsStageFilter: "all",
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

// Display-only: spaces a stored number into the groups people actually read
// it in ("+64 21 555 0111", "+61 412 345 678", "+64 9 835 1234") instead of
// one unbroken run of digits. Storage and dialling still use the raw value.
function formatPhone(phone){
  const raw = String(phone||"").trim();
  if (!raw) return "";
  if (!raw.startsWith("+")) return raw.replace(/\s+/g, " ");
  const { code, local } = splitE164(raw);
  const n = local.replace(/\D/g, "");
  const group = (...sizes) => {
    const out = []; let i = 0;
    for (const s of sizes){ if (i >= n.length) break; out.push(n.slice(i, i + s)); i += s; }
    if (i < n.length) out[out.length - 1] += n.slice(i);
    return out.join(" ");
  };
  let body;
  if (code === "64"){
    if (/^(800|508|900)/.test(n)) body = group(3, 3, 4);
    else if (n.startsWith("2")) body = group(2, 3, 4);
    else body = group(1, 3, 4);
  } else if (code === "61"){
    if (/^1[38]00/.test(n)) body = group(4, 3, 3);
    else if (n.startsWith("4") || n.startsWith("5")) body = group(3, 3, 3);
    else body = group(1, 4, 4);
  } else if (code === "1"){
    body = group(3, 3, 4);
  } else {
    body = group(4, 3, 3);
  }
  return `+${code} ${body}`;
}
// A phone number as it appears in tables, cards and the dialler.
function phoneHtml(phone, cls = ""){
  if (!phone) return `<span class="phone-num phone-num-empty">-</span>`;
  return `<span class="phone-num ${cls}">${escapeHtml(formatPhone(phone))}</span>`;
}

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
    { id:uid(), name:"M. Reeve", phone:"021 555 0111", company:"Reeve Builders Ltd", email:"", website:"", region:"North Shore", industry:"Construction", calls_made:0, last_called_at:null, last_outcome:null, last_called_by:null, snoozed_until:null, notes:"", created_by:"max@mrpriceless.co.nz", created_at:new Date(Date.now()-86400e3*2).toISOString(), updated_at:new Date().toISOString() },
    { id:uid(), name:"", phone:"022 555 0177", company:"Coastal Concrete Ltd", email:"", website:"", region:"", industry:"Construction", calls_made:1, last_called_at:new Date(Date.now()-86400e3*4).toISOString(), last_outcome:"not_interested", last_called_by:"max@mrpriceless.co.nz", snoozed_until:null, notes:"[Aug 2, 2:15pm - max] Not Interested: Already locked into a contract with another agency until next year.", created_by:"rocky@mrpriceless.co.nz", created_at:new Date().toISOString(), updated_at:new Date().toISOString() },
  ];
  const cl1 = uid(), cl2 = uid();
  state.clients = [
    { id:cl1, name:"Kauri Property Group", notes:"Real estate. Wants weekly listing videos.", cost_per_lead:38, monthly_ad_spend:1250, meta_ad_account_id:"act_1234567890", report_email:"aroha@kauriproperty.co.nz", last_report_sent_at:new Date(Date.now()-86400e3*32).toISOString(), created_at:new Date(Date.now()-86400e3*60).toISOString(), updated_at:new Date().toISOString(),
      services:"Meta Ads management, weekly listing video content, monthly performance report.",
      qualified_lead_structure:"Full name, phone number, and confirmed budget range. Must have viewed at least one listing page before enquiring.",
      key_contacts:"Aroha Ngata - Owner, final approval on everything. Reachable by phone, prefers calls over email.",
      renewal_date:new Date(Date.now()+86400e3*45).toISOString().slice(0,10),
      stage:"established", stage_changed_at:new Date(Date.now()-86400e3*20).toISOString() },
    { id:cl2, name:"Summit Dental", notes:"Healthcare. Focused on Meta lead ads.", cost_per_lead:22, monthly_ad_spend:1250, meta_ad_account_id:"", report_email:"", last_report_sent_at:null, created_at:new Date(Date.now()-86400e3*40).toISOString(), updated_at:new Date().toISOString(),
      services:"Meta Ads lead generation.",
      qualified_lead_structure:"Name and phone number, must live within 15km of the practice.",
      key_contacts:"Ben Whitfield - Practice manager, main point of contact.",
      renewal_date:new Date(Date.now()+86400e3*8).toISOString().slice(0,10),
      stage:"month_1", stage_changed_at:new Date(Date.now()-86400e3*35).toISOString() },
    { id:uid(), name:"Chand Legal", notes:"Just signed, kicking off this week.", cost_per_lead:null, monthly_ad_spend:1250, meta_ad_account_id:"", report_email:"", last_report_sent_at:null, created_at:new Date(Date.now()-86400e3*5).toISOString(), updated_at:new Date().toISOString(),
      services:"SEO + Google Ads.",
      qualified_lead_structure:"",
      key_contacts:"Priya Chand - Owner.",
      renewal_date:null,
      stage:"onboarding", stage_changed_at:new Date(Date.now()-86400e3*5).toISOString(),
      onboarding_progress:{ "0_0":true, "0_1":true, "0_2":true, "1_0":true } },
    { id:uid(), name:"Reeve Builders", notes:"On the 10 quote guarantee - 4 of 10 delivered so far.", cost_per_lead:65, monthly_ad_spend:1250, meta_ad_account_id:"", report_email:"", last_report_sent_at:new Date(Date.now()-86400e3*5).toISOString(), created_at:new Date(Date.now()-86400e3*140).toISOString(), updated_at:new Date().toISOString(),
      services:"Meta Ads + SEO, quote guarantee.",
      qualified_lead_structure:"",
      key_contacts:"Marlon Reeve - Owner.",
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
    ...(window.MP_BUILTIN_PLAYBOOKS || []).map(p => ({ id:uid(), ...p, created_at:new Date().toISOString(), updated_at:new Date().toISOString() })),
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
    ...(window.MP_BUILTIN_EMAIL_TEMPLATES || []).map(t => ({ id:uid(), ...t, created_at:new Date().toISOString(), updated_at:new Date().toISOString() })),
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
  state.teamFocus = { rocky:null, max:"Landscaping", gabriel:null, raheem:null, thor:null };
}

/* ───────── Data layer ───────── */
// Supabase hands back at most 1,000 rows per request, so a big table (the
// Dialler's prospects passed that) silently lost whatever sorted last - for
// prospects, the ones called most recently. This pages through until every
// row is in. The id tiebreaker keeps page boundaries stable when rows tie.
const FETCH_PAGE = 1000;
async function allRows(build){
  let rows = [];
  for (let from = 0; ; from += FETCH_PAGE){
    const { data, error } = await build().order("id", { ascending: true }).range(from, from + FETCH_PAGE - 1);
    if (error) return { data: rows.length ? rows : null, error };
    rows = rows.concat(data || []);
    if (!data || data.length < FETCH_PAGE) return { data: rows, error: null };
  }
}
// Any ad costing more than $50 a lead is a Low performer - automatically,
// every time the ads load (after each Meta sync). Engagement posts aren't
// lead-gen, and an ad someone has put back by hand (result_manual) stays put.
const LOW_CPL_LIMIT = 50;
function autoLowPerformers(){
  const hits = state.adCreatives.filter(a => Number(a.cost_per_result) > LOW_CPL_LIMIT && !["killed", "engagement"].includes(a.result) && !a.result_manual);
  if (!hits.length) return;
  hits.forEach(a => { a.result = "killed"; });
  if (IS_CONFIGURED) supabase.from("client_ad_creatives").update({ result: "killed" }).in("id", hits.map(a => a.id))
    .then(({ error }) => { if (error) console.warn("Couldn't move $50+ CPL ads to Low:", error.message); });
}
// Reloads are shared: while one is running, every other caller waits on a
// single follow-up that starts once it finishes (so it still sees their
// write). A burst of saves or realtime events is a couple of reloads, not dozens.
let fetchRun = null, fetchQueued = null, fetchStartedAt = 0;
const DataLayer = {
  fetchAll(){
    if (!fetchRun){
      fetchStartedAt = Date.now();
      fetchRun = DataLayer._fetchAllNow().finally(() => { fetchRun = null; });
      return fetchRun;
    }
    if (!fetchQueued) fetchQueued = fetchRun.catch(() => {}).then(() => { fetchQueued = null; return DataLayer.fetchAll(); });
    return fetchQueued;
  },
  async _fetchAllNow(){
    if (!IS_CONFIGURED){ return; }
    const [c, cc, d, r, p, cl, ccon, cad, camp, dc, tk, crep, nt, pb, ru, et, ex, ca, pu, tf, cws, clead, cv] = await Promise.all([
      allRows(() => supabase.from("contacts").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("cold_calls").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("deals").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("prospecting_regions").select("*").order("region",{ascending:true})),
      // Secondary order key matters: a lot of prospects tie on last_called_at
      // (every never-called one is null), and without a deterministic
      // tiebreaker Postgres can return tied rows in a different order on
      // every fetch - which looked like prospects randomly jumping around
      // the queue on every realtime refresh (claims, outcomes logged, etc).
      allRows(() => supabase.from("dial_prospects").select("*").order("last_called_at",{ascending:true,nullsFirst:true}).order("created_at",{ascending:true})),
      allRows(() => supabase.from("clients").select("*").order("name",{ascending:true})),
      allRows(() => supabase.from("client_content").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("client_ad_creatives").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("client_campaigns").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("deal_contacts").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("tasks").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("client_reports").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("notes").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("playbooks").select("*").order("sort_order",{ascending:true})),
      allRows(() => supabase.from("rules").select("*").order("sort_order",{ascending:true})),
      allRows(() => supabase.from("email_templates").select("*").order("sort_order",{ascending:true})),
      allRows(() => supabase.from("expenses").select("*").order("expense_date",{ascending:false})),
      allRows(() => supabase.from("call_activity").select("*").order("activity_date",{ascending:false})),
      allRows(() => supabase.from("playbook_usage").select("*").order("month",{ascending:false})),
      supabase.from("team_focus").select("*"),
      allRows(() => supabase.from("creative_weekly_snapshots").select("*")),
      allRows(() => supabase.from("client_leads").select("*").order("created_at",{ascending:false})),
      allRows(() => supabase.from("completed_verticals").select("*").order("completed_at",{ascending:false})),
    ]);
    state.contacts = c.data || [];
    state.coldCalls = cc.data || [];
    state.deals = d.data || [];
    state.regions = r.data || [];
    state.prospects = p.data || [];
    // "Deleted" clients that still have ad creatives are archived instead, so
    // their creatives stay in the Creative Library - keep them out of everything else.
    state.archivedClients = (cl.data || []).filter(c => c.stage === ARCHIVED_STAGE);
    state.clients = (cl.data || []).filter(c => c.stage !== ARCHIVED_STAGE);
    state.clients.forEach(c => { c.stage = normalizeClientStage(c.stage); });
    state.clientContent = ccon.data || [];
    state.adCreatives = cad.data || [];
    autoLowPerformers();
    state.campaigns = camp.data || [];
    state.dealContacts = dc.data || [];
    state.tasks = tk.data || [];
    state.clientReports = crep.data || [];
    state.notes = nt.data || [];
    state.playbooks = pb.data || [];
    state.playbooksLoaded = !pb.error;
    state.rules = ru.data || [];
    state.emailTemplates = et.data || [];
    state.emailTemplatesLoaded = !et.error;
    state.expenses = ex.data || [];
    state.callActivity = ca.data || [];
    state.playbookUsage = pu.data || [];
    state.teamFocus = { rocky: null, max: null, gabriel: null, raheem: null, thor: null };
    (tf.data || []).forEach(row => { state.teamFocus[row.person] = row.industry || null; });
    state.creativeSnapshots = cws.data || [];
    state.clientLeads = clead.data || [];
    state.completedVerticals = cv.data || [];
    dropArchivedClientData();
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
        state.campaigns = state.campaigns.filter(x => x.client_id !== id);
      }
      if (table === "deals"){
        state.dealContacts = state.dealContacts.filter(x => x.deal_id !== id);
      }
      renderAll();
      return;
    }
    const { data: gone, error } = await supabase.from(table).delete().eq("id", id).select("id");
    if (error){ alert(error.message); return; }
    // No error but nothing deleted means the database quietly said no (row permissions).
    if (!gone || !gone.length){ alert("The database didn't delete that - your account may not have permission to delete it. Nothing was changed."); return; }
    const arr = stateArray(table);
    const idx = arr ? arr.findIndex(x => x.id === id) : -1;
    if (idx > -1) arr.splice(idx,1);
    if (table === "clients"){
      state.clientContent = state.clientContent.filter(x => x.client_id !== id);
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
    client_leads: state.clientLeads, completed_verticals: state.completedVerticals,
  }[table];
}

/* ───────── Realtime ───────── */
let realtimeSubscribed = false;
function subscribeRealtime(){
  if (!IS_CONFIGURED || realtimeSubscribed) return;
  realtimeSubscribed = true;
  // Changes arrive in bursts (an ad sync touches every creative), so they're
  // gathered up and the CRM reloads once - and not at all if a reload already
  // started after the latest change (our own saves reload themselves).
  let liveTimer = null, liveSince = 0;
  const liveRefresh = () => {
    liveSince = Date.now();
    clearTimeout(liveTimer);
    liveTimer = setTimeout(async () => {
      liveTimer = null;
      if (fetchStartedAt > liveSince) return;
      await DataLayer.fetchAll(); renderAll();
    }, 350);
  };
  const LIVE_TABLES = ["contacts", "cold_calls", "deals", "prospecting_regions", "dial_prospects", "clients", "client_content", "client_ad_creatives", "client_campaigns", "deal_contacts", "tasks", "client_reports", "notes", "playbooks", "rules", "email_templates", "expenses", "call_activity", "playbook_usage", "creative_weekly_snapshots", "team_focus", "client_leads", "completed_verticals"];
  const channel = supabase.channel("crm-live");
  LIVE_TABLES.forEach(table => channel.on("postgres_changes", { event:"*", schema:"public", table }, liveRefresh));
  channel
    .on("postgres_changes", { event:"INSERT", schema:"public", table:"meeting_reviews" }, () => { checkPendingMeetingReviews(); })
    .subscribe();
}

/* ───────── Auth (Google sign-in + allowlist gate) ───────── */
function authFailed(msg){
  const btn = $("#auth-submit");
  if (btn){ btn.disabled = false; btn.textContent = "Sign In"; }
  const box = $("#auth-error");
  if (box){ box.textContent = msg; box.classList.add("visible"); }
}
async function initAuth(){
  if (!IS_CONFIGURED){
    seedDemo(); autoLowPerformers();
    state.clients.forEach(c => { c.stage = normalizeClientStage(c.stage); });
    await repairNzProspectCountryCodes();
    state.user = { email: "demo@mrpriceless.co.nz" };
    state.team = [{ email: "demo@mrpriceless.co.nz", invited_by: "setup", created_at: new Date().toISOString() }];
    showApp();
    reviewQueue = [{ id:"demo-review-1", meeting_title:"Discovery call - Reeve Builders", attendees:["marlon@reevebuilders.co.nz"] }];
    showNextReview();
    checkOverdueTasksPopup();
    return;
  }
  if (!supabase){ showAuth(); return; }
  const { data:{ session } } = await supabase.auth.getSession();
  if (session){
    try { await handleSignedIn(session); }
    catch (err){ console.error(err); showAuth(); authFailed("The CRM couldn't load: " + (err.message || err) + ". Refresh to try again."); }
  }
  else showAuth();

  supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === "PASSWORD_RECOVERY"){
      showResetPassword();
    } else if (event === "SIGNED_IN" && session){
      try { await handleSignedIn(session, /*freshLogin*/ true); }
      catch (err){ console.error(err); authFailed("Signed in, but the CRM couldn't load: " + (err.message || err) + ". Refresh to try again."); }
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
  window.CRM_TRACKER_DEFAULT_PERSON?.(personKeyFromEmail(session.user.email));

  await DataLayer.fetchAll();
  await repairNzProspectCountryCodes();
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
    const btn = $("#auth-submit"), label = btn.textContent;
    btn.disabled = true; btn.textContent = mode === "signin" ? "Signing in…" : "Creating account…";
    // Loading everything after sign-in can take a few seconds; never leave the button looking dead.
    const slow = setTimeout(() => { if (!state.user || $("#auth-screen")?.offsetParent){ btn.textContent = "Still loading…"; } }, 8000);
    const restore = () => { clearTimeout(slow); btn.disabled = false; btn.textContent = label; };
    try {
      if (!supabase) throw new Error("Couldn't load the sign-in tools. Refresh the page and try again.");
      if (mode === "signin"){
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        btn.textContent = "Loading your CRM…";
        clearTimeout(slow);
      } else {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        errBox.textContent = "Account created. Check your email if confirmation is required, then sign in.";
        errBox.classList.add("visible");
        restore();
        return;
      }
    } catch (err){
      restore();
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
  // Lead Engine is Rocky/Max only regardless of workspace - override the
  // workspace loop above rather than fold it into data-workspace, since
  // this restriction is per-person, not per-workspace.
  $$('.nav-item[data-page="lead-engine"]').forEach(el => {
    if (!canAccessLeadEngine()) el.style.display = "none";
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
  const pageBtns = $$(`.nav-item[data-page="${state.page}"]`);
  if (pageBtns.length && !pageBtns.some(b => b.dataset.workspace === "both" || b.dataset.workspace === ws)){
    $(`.nav-item[data-page="dashboard"][data-workspace="${ws}"]`)?.click();
  }
  if (state.page === "lead-engine" && !canAccessLeadEngine()){
    $('.nav-item[data-page="dashboard"]')?.click();
  }
}
function setupNav(){
  $("#workspace-select")?.addEventListener("change", (e) => setWorkspace(e.target.value));
  $("#coverage-industry-select")?.addEventListener("change", (e) => { state.coverageIndustry = e.target.value; renderRegionCoverage(); });
  $$(".nav-item[data-page]").forEach(btn => {
    btn.addEventListener("click", () => {
      flushRenders();
      state.page = btn.dataset.page;
      $$(".nav-item[data-page]").forEach(b => b.classList.toggle("active", b === btn));
      $$(".page").forEach(p => p.classList.toggle("active", p.id === "page-" + state.page));
      showJarvisFab();
      $$(".nav-dropdown.open").forEach(d => d.classList.remove("open"));
    });
  });
  // Each workspace has its own "More" group - wire them all the same way.
  const closeNavDropdowns = (except) => $$(".nav-dropdown.open").forEach(d => { if (d !== except) d.classList.remove("open"); });
  $$(".nav-group-toggle").forEach(toggle => toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const dropdown = toggle.closest(".nav-group")?.querySelector(".nav-dropdown");
    if (!dropdown) return;
    closeNavDropdowns(dropdown);
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
  }));
  document.addEventListener("click", (e) => {
    if (!e.target.closest?.(".nav-group")) closeNavDropdowns();
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
  const closedAdhoc = state.deals.filter(d => d.stage === ADHOC_STAGE);
  const closedLost = state.deals.filter(d => d.stage === "closed_lost");
  const openDeals = state.deals.filter(d => !CLOSED_STAGES.has(d.stage));
  const wonThisMonth = closedWon.filter(d => sameMonth(d.updated_at || d.created_at));
  const mrr = closedWon.reduce((s,d) => s + Number(d.value||0), 0);
  const pipelineValue = openDeals.reduce((s,d) => s + Number(d.value||0), 0);
  const adhocThisMonth = closedAdhoc.filter(d => sameMonth(d.updated_at || d.created_at));
  const adhocTotal = closedAdhoc.reduce((s,d) => s + Number(d.value||0), 0);
  const wonCount = closedWon.length + closedAdhoc.length;
  const closedTotal = wonCount + closedLost.length;
  const winRate = closedTotal ? Math.round(wonCount / closedTotal * 100) : null;

  const monthlyExpenses = monthlyRecurringTotal();
  const netMrr = mrr - monthlyExpenses;

  $("#stat-mrr").textContent = fmtMoney(mrr);
  $("#stat-mrr-sub").textContent = `from ${closedWon.length} closed won job${closedWon.length===1?"":"s"}`;
  $("#stat-net-mrr").textContent = `${fmtMoney(netMrr)}/mo net after ${fmtMoney(monthlyExpenses)} expenses`;
  $("#stat-adhoc").textContent = fmtMoney(adhocTotal);
  $("#stat-adhoc-sub").textContent = `${closedAdhoc.length} job${closedAdhoc.length===1?"":"s"} · ${fmtMoney(adhocThisMonth.reduce((s,d)=>s+Number(d.value||0),0))} this month`;
  $("#stat-won-month").textContent = wonThisMonth.length;
  $("#stat-won-month-value").textContent = `${fmtMoney(wonThisMonth.reduce((s,d)=>s+Number(d.value||0),0))} added`;
  $("#stat-won-total").textContent = closedWon.length;
  $("#stat-win-rate").textContent = winRate === null ? "No closed deals yet" : `${winRate}% win rate`;
  $("#stat-pipeline").textContent = fmtMoney(pipelineValue);
  $("#stat-pipeline-sub").textContent = `${openDeals.length} active deal${openDeals.length===1?"":"s"}`;

  const recentWins = [...closedWon, ...closedAdhoc].sort((a,b) => new Date(b.updated_at||b.created_at) - new Date(a.updated_at||a.created_at)).slice(0,8);
  $("#closed-won-list").innerHTML = recentWins.length ? recentWins.map(d => `
    <div class="activity-row">
      <div class="activity-dot activity-dot-won"></div>
      <div>
        <div class="activity-text"><b>${escapeHtml(d.title)}</b> - ${fmtMoney(d.value)}${d.stage === ADHOC_STAGE ? " one-off" : "/mo"}</div>
        <div class="activity-time">${escapeHtml(d.contact_name||"No contact")} · Won ${timeAgo(d.updated_at||d.created_at)}</div>
      </div>
    </div>
  `).join("") : emptyState("No closed won jobs yet - move a deal to Closed Won MRR or Closed Won Adhoc on the Deals board.");

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
// Every client reports on the same fixed fortnightly cadence - used for the
// Reporting page's "Next Due" column. (No overdue reminders/alerts.)
const REPORT_CADENCE_DAYS = 14;
function getClientAlerts(c){
  const alerts = [];
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
// The calendar day where the person is (NZ), not UTC - otherwise anything
// logged before ~1pm lands on yesterday's row.
function localDayStr(d = new Date()){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}
window.CRM_CALL_ACTIVITY = {
  // Adds to today's counts (e.g. { calls: 1 }). Both the Dialer and the
  // Meetings Booked tap counters feed this same row, so it only ever adds -
  // overwriting it with one side's own totals wiped out the other's calls.
  async bump(person, deltas){
    if (!person) return;
    const today = localDayStr();
    let row = state.callActivity.find(r => r.person === person && r.activity_date === today);
    if (!row){
      row = { id: uid(), person, activity_date: today, calls:0, conversations:0, meetings_booked:0 };
      state.callActivity.push(row);
    }
    for (const [k, v] of Object.entries(deltas)) row[k] = Math.max(0, Number(row[k]||0) + v);
    row.updated_at = new Date().toISOString();
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
      <td>${phoneHtml(c.phone)}</td>
      <td><span class="badge ${CONTACT_STATUS[c.status]?.cls||"gray"}">${CONTACT_STATUS[c.status]?.label||c.status}</span></td>
      <td style="text-align:right;white-space:nowrap;">
        ${callButtonHtml(c.phone, c.name)}
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
    title: (extra.company || name).trim(),
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
        <td>${phoneHtml(contact?.phone)}</td>
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
const KANBAN_PREVIEW_COUNT = 2;
function renderDealStageCol(stage){
  const deals = state.deals.filter(d => d.stage === stage.key);
  const expanded = !!state.expandedStages[stage.key];
  // Net of rep commission where it's known, same as the pipeline total above
  // the board - a column footer that only ever showed gross was overstating
  // what actually lands once commission's paid out.
  const stageValue = deals.reduce((s,d) => { const net = dealNetValue(d); return s + (net != null ? net : Number(d.value||0)); }, 0);
  return `
    <div class="kanban-col" data-stage="${stage.key}">
      <div class="kanban-col-head">
        <h4>${stage.label}</h4>
        <span class="kanban-count">${deals.length}</span>
      </div>
      <div class="kanban-col-value">${fmtMoney(stageValue)}</div>
      ${(expanded ? deals : deals.slice(0, KANBAN_PREVIEW_COUNT)).map(d => {
        const extraContacts = dealContactsFor(d.id);
        const primaryContact = d.contact_id ? state.contacts.find(c => c.id === d.contact_id) : null;
        const netValue = dealNetValue(d);
        return `
        <div class="deal-card" draggable="true" data-id="${d.id}" data-action="view-deal">
          <h5>${escapeHtml(d.title)}</h5>
          <div class="deal-contact">${escapeHtml(d.contact_name||"No contact")}</div>
          ${extraContacts.length ? `<div class="deal-extra-contacts">${extraContacts.map(dc => `${escapeHtml(dc.role||"Contact")}: ${escapeHtml(dc.name)}`).join(", ")}</div>` : ""}
          <div class="deal-card-foot">
            <span class="deal-value">${dealValueLabel(d)}</span>
            ${d.assignee && ASSIGNEES[d.assignee] ? `<span class="badge ${ASSIGNEES[d.assignee].cls}">${ASSIGNEES[d.assignee].label}</span>` : ""}
            ${callButtonHtml(primaryContact?.phone, primaryContact?.name || d.contact_name)}
            <button class="icon-btn" data-action="delete-deal" data-id="${d.id}" title="Delete">${ICONS.trash}</button>
          </div>
          ${netValue != null ? `<div class="deal-net-value">Net ${fmtMoney(netValue)}/mo after ${fmtMoney(d.commission_initial_amount)} commission</div>` : ""}
        </div>
      `;}).join("")}
      ${deals.length > KANBAN_PREVIEW_COUNT ? `<button type="button" class="kanban-more" data-action="toggle-stage-expand" data-stage="${stage.key}">${expanded ? "Show less" : `Show ${deals.length - KANBAN_PREVIEW_COUNT} more`}</button>` : ""}
    </div>
  `;
}
function renderDealsList(){
  const board = $("#kanban-board");
  const closedBoard = $("#kanban-board-closed");
  const totalEl = $("#pipeline-total");
  if (totalEl) totalEl.textContent = fmtMoney(state.deals.filter(d => !CLOSED_STAGES.has(d.stage)).reduce((s,d) => { const net = dealNetValue(d); return s + (net != null ? net : Number(d.value||0)); }, 0));
  board.innerHTML = STAGES.filter(s => !CLOSED_STAGES.has(s.key)).map(renderDealStageCol).join("");
  if (closedBoard) closedBoard.innerHTML = STAGES.filter(s => CLOSED_STAGES.has(s.key)).map(renderDealStageCol).join("");
  setupDragDrop();
}
// Commission by rep, grouped like the Clients gallery - one collapsible
// section per rep, each deal showing this cycle's amount, whether it's
// still on the elevated rate or has stepped down, and when it's next due.
// Scoped to MEETING_CLOSE_STAGES (pending_results + closed_won), same "won
// enough to count" bar maybeCreateClientFromDeal already uses - plenty of
// real, actively-invoiced clients sit in Pending Results rather than ever
// getting manually dragged to Closed Won, and they still owe commission.
// Thor's the only rep on commission right now, so this is just his deals,
// flat - no per-rep grouping to page through for a list of one.
function renderCommission(){
  const wrap = $("#commission-groups");
  if (!wrap) return;
  const deals = state.deals.filter(d => MEETING_CLOSE_STAGES.has(d.stage) && d.assignee === "thor");
  const withCommission = deals.filter(d => commissionForDeal(d));
  const totalDue = withCommission.reduce((s,d) => s + commissionForDeal(d).amount, 0);
  const dueEl = $("#commission-stat-due");
  if (dueEl) dueEl.textContent = fmtMoney(totalDue);
  const unsetEl = $("#commission-stat-unset");
  if (unsetEl) unsetEl.textContent = deals.length - withCommission.length;

  if (!deals.length){ wrap.innerHTML = emptyState("No won deals of Thor's yet - commission tracking kicks in once one closes."); return; }

  // Set-up deals first (the actual report), unset ones trail at the bottom
  // as a short to-do list rather than interrupting the read.
  const sorted = [...deals].sort((a,b) => {
    const ca = commissionForDeal(a), cb = commissionForDeal(b);
    if (!!ca !== !!cb) return ca ? -1 : 1;
    return (a.contact_name||a.title).localeCompare(b.contact_name||b.title);
  });
  wrap.innerHTML = `
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>Client / Deal</th><th>Monthly Commission</th><th>Next Due</th><th></th></tr></thead>
          <tbody>
            ${sorted.map(d => {
              const c = commissionForDeal(d);
              return `
              <tr${c ? "" : ` class="commission-row-unset"`}>
                <td><div class="row-name">${escapeHtml(d.contact_name||d.title)}</div><div class="row-sub">${escapeHtml(d.title)}</div></td>
                <td>${c
                  ? `${fmtMoney(c.amount)}/mo <span class="badge ${c.elevated?'gold':'gray'}" style="margin-left:6px;">${c.elevated ? `Elevated · Mo ${c.monthsIn+1}/${COMMISSION_ELEVATED_MONTHS}` : "Steady"}</span>`
                  : `<span style="color:var(--text2);">Not set up yet</span>`}</td>
                <td>${c ? fmtDate(c.dueDate) : "-"}</td>
                <td style="text-align:right;"><button class="icon-btn" data-action="edit-deal" data-id="${d.id}" title="${c ? "Edit deal" : "Set up commission"}">${ICONS.edit}</button></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>
    </div>
  `;
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
  const netEl = $("#deal-detail-net");
  if (netEl){
    const net = dealNetValue(deal);
    netEl.style.display = net != null ? "" : "none";
    if (net != null) netEl.textContent = `Net ${fmtMoney(net)} after ${fmtMoney(deal.commission_initial_amount)} commission`;
  }
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
    ? rows.map(r => `<div style="margin-bottom:8px;display:flex;align-items:center;gap:6px;"><b>${escapeHtml(r.name)}</b> ${r.phone ? "· " + phoneHtml(r.phone) : ""} <span class="badge gray">${escapeHtml(r.role)}</span> ${callButtonHtml(r.phone, r.name)}</div>`).join("")
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
// Module-level (not local to setupDragDrop) since setupDragDrop reruns on
// every Deals render - a local "draggedId" would just get thrown away and
// recreated each time, but the drag itself spans renders (nothing re-renders
// mid-drag, only on drop), so both this and the auto-scroll listener below
// need to survive across calls.
let dealDragId = null;
let dealDragAutoScrollWired = false;
function setupDragDrop(){
  const boards = [$("#kanban-board"), $("#kanban-board-closed")].filter(Boolean);
  if (!boards.length) return;
  // Native HTML5 drag auto-scroll near the viewport edge is unreliable
  // (sluggish in Chrome, largely absent in Firefox/Safari) - with more than
  // a screenful of deals piled into one stage, that made it impossible to
  // drag a card sitting deep in a long column back up to a stage whose
  // column had scrolled out of view. Wired once (not per-render, since this
  // listener needs to outlive any single render) to manually scroll the
  // window while a card is being dragged near the top/bottom edge.
  if (!dealDragAutoScrollWired){
    dealDragAutoScrollWired = true;
    const EDGE = 90, MAX_SPEED = 22;
    document.addEventListener("dragover", (e) => {
      if (!dealDragId) return;
      const y = e.clientY;
      const vh = window.innerHeight;
      if (y < EDGE) window.scrollBy(0, -Math.ceil((EDGE - y) / EDGE * MAX_SPEED));
      else if (y > vh - EDGE) window.scrollBy(0, Math.ceil((EDGE - (vh - y)) / EDGE * MAX_SPEED));
    });
  }
  boards.forEach(board => {
    board.querySelectorAll(".deal-card").forEach(card => {
      card.addEventListener("dragstart", (e) => {
        dealDragId = card.dataset.id;
        card.classList.add("dragging");
        if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
      });
      card.addEventListener("dragend", () => { card.classList.remove("dragging"); dealDragId = null; });
    });
    board.querySelectorAll(".kanban-col").forEach(col => {
      col.addEventListener("dragover", (e) => { e.preventDefault(); col.classList.add("dragover"); });
      col.addEventListener("dragleave", () => col.classList.remove("dragover"));
      col.addEventListener("drop", async (e) => {
        e.preventDefault();
        col.classList.remove("dragover");
        if (!dealDragId) return;
        const dragId = dealDragId;
        const before = state.deals.find(d => d.id === dragId)?.stage;
        const updated = await DataLayer.update("deals", dragId, { stage: col.dataset.stage, updated_at: new Date().toISOString() });
        await onDealStageChanged(updated, before);
        const created = await maybeCreateClientFromDeal(updated);
        // Already a client (so no new pack popped up)? Still offer the pack on signing.
        if (!created && col.dataset.stage === "onboarding" && before !== "onboarding") openWelcomePackForDeal(updated || state.deals.find(d => d.id === dragId));
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
  const isMoneyType = type === "retainer" || type === "ppl";
  const valueField = $("#deal-value-field");
  const pctField = $("#deal-percentage-field");
  if (valueField) valueField.style.display = isMoneyType ? "" : "none";
  if (pctField) pctField.style.display = isMoneyType ? "none" : "";
  const valueLabel = valueField?.querySelector("label");
  if (valueLabel) valueLabel.textContent = type === "ppl" ? "Price Per Lead (NZD)" : "Value (NZD/mo)";
}
// Commission's Thor-only for now - the field stays hidden for every other
// assignee so it's not sitting there as a temptation/distraction on deals
// it'll never apply to. Visibility-only, doesn't touch any value - used
// both when just opening a deal to edit (never destructive) and after
// typing an amount.
function updateDealCommissionVisibility(){
  const isThor = $("#deal-assignee")?.value === "thor";
  const field = $("#deal-commission-field");
  if (field) field.style.display = isThor ? "" : "none";
  const row = $("#deal-commission-date-row");
  if (row) row.style.display = (isThor && $("#deal-commission")?.value) ? "" : "none";
}
// Only wired to the assignee select's own change event (an intentional
// reassignment while the form's open) - clears any commission amount if
// switched away from Thor, so a stale value can't silently linger hidden
// and still get saved. Never called just from opening the form to edit.
function toggleDealCommissionFields(){
  if ($("#deal-assignee")?.value !== "thor" && $("#deal-commission")) $("#deal-commission").value = "";
  updateDealCommissionVisibility();
}
function toggleClientQuoteTargetField(){
  const field = $("#client-quote-target-field");
  if (field) field.style.display = $("#client-stage")?.value === "quote_guarantee" ? "" : "none";
}
function openEditClientModal(c){
  state.selectedClientId = c.id;
  $("#client-form-id").value = c.id;
  $("#client-name").value = c.name||"";
  $("#client-phone").value = c.phone||"";
  $("#client-email").value = c.email||"";
  $("#client-website").value = c.website||"";
  $("#client-industry").value = c.industry || "";
  $("#client-industry").placeholder = clientIndustry({ ...c, industry: "" }).name || "e.g. Plumbing";
  $("#client-cpl").value = c.cost_per_lead != null ? c.cost_per_lead : "";
  $("#client-monthly-ad-spend").value = c.monthly_ad_spend != null ? c.monthly_ad_spend : "";
  $("#client-notes").value = c.notes||"";
  $("#client-meta-account").value = c.meta_ad_account_id||"";
  $("#client-ad-start-date").value = c.ad_start_date||"";
  $("#client-report-email").value = c.report_email||"";
  $("#client-churn-risk").value = c.churn_risk||"";
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
  { key:"dm_unavailable", label:"DM Unavailable", cls:"ghost" },
  { key:"call_back", label:"Call Back", cls:"ghost" },
  { key:"not_interested", label:"Not Interested", cls:"ghost" },
  { key:"disqualified", label:"Disqualified", cls:"ghost" },
  { key:"booked_meeting", label:"Booked Meeting", cls:"gold" },
];
// Logging a call snoozes a prospect for a few days so it drops out of
// everyone's "ready to call" view - the actual mechanism that stops two
// different reps (or the same rep twice) from calling the same business.
function isSnoozed(p){ return !!p.snoozed_until && new Date(p.snoozed_until) > new Date(); }
// Call Back, Not Interested, and Disqualified aren't timer-based cooldowns
// like the rest - they park a prospect out of the callable pool indefinitely
// (into their own Follow Up / Not Interested / Disqualified views) until
// someone actually logs a fresh call against them or hits Reactivate, rather
// than a snoozed_until date expiring. Disqualified is for a business that
// doesn't meet the criteria at all (wrong area, too small, etc) - separate
// from Not Interested, which is a business that qualifies but said no.
function isParked(p){ return p.last_outcome === "call_back" || p.last_outcome === "not_interested" || p.last_outcome === "disqualified"; }
// "Returning" = still on a timer-based cooldown (no_answer cadence, or the
// long booked_meeting snooze) - these flow back into the active pool on
// their own once snoozed_until passes, unlike parked prospects.
function isReturning(p){ return !isParked(p) && isSnoozed(p); }
// The Dialler works one country at a time (NZ or AU, picked at the top).
// A prospect's country comes from its region first - the region pick-lists
// never overlap - then from the country code on its number. A local number
// with no region and no country code counts as NZ, which is what the old
// NZ Dialler treated it as.
const DIALER_COUNTRIES = { NZ: { code: "64", label: "New Zealand", regions: NZ_REGIONS }, AU: { code: "61", label: "Australia", regions: AU_REGIONS } };
const DIALER_COUNTRY_KEY = "mp_dialer_country";
function prospectCountry(p){
  if (NZ_REGIONS.includes(p.region)) return "NZ";
  if (AU_REGIONS.includes(p.region)) return "AU";
  const phone = String(p.phone||"").trim();
  if (phone.startsWith("+61")) return "AU";
  return "NZ";
}
// The number exactly as it will be dialled - an old NZ "021 555 0111" saved
// before imports added country codes dials as +64, never as +61.
function prospectE164(p){ return toE164(p.phone, DIALER_COUNTRIES[prospectCountry(p)].code); }
function inDialerCountry(p){ return prospectCountry(p) === state.dialerCountry; }
// Two people running the Aus Dialler at once must never both land on the
// same prospect as "Up Now" - whoever's dialer surfaces a prospect first
// claims it for a few minutes (comfortably covering a real call), and the
// other person's queue just skips it and moves to the next one. The claim
// releases itself the moment a real outcome gets logged (see
// logDialOutcome), or simply expires here if someone closes the tab
// mid-call without logging anything.
const DIALER_CLAIM_TIMEOUT_MS = 3 * 60 * 1000;
function isClaimedByOther(p, activePerson){
  if (!p.claimed_by || !p.claimed_at || p.claimed_by === activePerson) return false;
  return (Date.now() - new Date(p.claimed_at).getTime()) < DIALER_CLAIM_TIMEOUT_MS;
}
// A region+industry combo Lead Engine has ticked off as fully worked (see
// Vertical Coverage) - never true for a prospect missing either field,
// since a combo can only be marked complete once it's actually named.
// A whole region ticked off is stored as a completed vertical with
// industry "*", so it counts for every industry in that region.
const REGION_DONE = "*";
const regionCompletion = (region) => state.completedVerticals.find(v => v.region === region && v.industry === REGION_DONE) || null;
function isVerticalCompleted(region, industry){
  if (!region) return false;
  if (regionCompletion(region)) return true;
  if (!industry) return false;
  return state.completedVerticals.some(v => v.region === region && v.industry === industry);
}
// "Completed 3 months ago" - whole months since it was ticked.
function monthsSinceLabel(at){
  const d = new Date(at), now = new Date();
  let m = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
  if (now.getDate() < d.getDate()) m--;
  m = Math.max(0, m);
  return { months: m, label: m < 1 ? "under a month" : `${m} month${m === 1 ? "" : "s"}` };
}
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
// Whether a prospect was added by the given person (Dialler-only owner
// filter, see state.dialerOwnerFilter) - empty ownerKey means no filtering.
function dialerOwnedBy(p, ownerKey){
  if (!ownerKey) return true;
  return personKeyFromEmail(p.created_by) === ownerKey;
}
function dialerQueue(){
  // The power dialer only ever wants to surface prospects that are actually
  // callable right now - anyone still cooling down after a recent call stays
  // out of the queue until they're due again, and anyone parked (Follow Up /
  // Not Interested) stays out until someone actions them from those views.
  // It only ever surfaces the country picked at the top (see inDialerCountry).
  const activePerson = window.getActivePerson ? window.getActivePerson() : null;
  return dialerFilteredProspects().filter(inDialerCountry).filter(p => dialerOwnedBy(p, state.dialerOwnerFilter)).filter(p => !isParked(p) && !isSnoozed(p) && !isClaimedByOther(p, activePerson)).sort((a,b) => {
    const ta = a.last_called_at ? new Date(a.last_called_at).getTime() : -Infinity;
    const tb = b.last_called_at ? new Date(b.last_called_at).getTime() : -Infinity;
    if (ta !== tb) return ta - tb;
    // Deterministic tiebreaker - see the matching comment on the
    // dial_prospects fetch order. Without this, ties (most commonly a pile
    // of never-called prospects) can silently re-sort themselves on every
    // realtime refresh, which is what made "Up Now" seem to jump around on
    // its own after a claim write or a logged outcome.
    const ca = a.created_at ? new Date(a.created_at).getTime() : 0;
    const cb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return ca - cb;
  });
}
function renderDialerFilters(){
  const country = state.dialerCountry;
  $$("#dialer-country [data-country]").forEach(b => {
    const on = b.dataset.country === country;
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", on ? "true" : "false");
  });
  const regionSel = $("#dialer-filter-region");
  const industrySel = $("#dialer-filter-industry");
  const ownerSel = $("#dialer-filter-owner");
  const pool = state.prospects.filter(inDialerCountry);
  // Regions in the pick-list's own order, only the ones with prospects on
  // file, each with how many - so it's obvious where there's work to do.
  const counts = new Map();
  pool.forEach(p => { if (p.region) counts.set(p.region, (counts.get(p.region)||0) + 1); });
  const canonical = DIALER_COUNTRIES[country].regions;
  const regions = [...canonical.filter(r => counts.has(r)), ...[...counts.keys()].filter(r => !canonical.includes(r)).sort()];
  if (state.dialerFilter.region && !regions.includes(state.dialerFilter.region)) state.dialerFilter.region = "";
  if (regionSel){
    const label = country === "AU" ? "All states" : "All regions";
    regionSel.innerHTML = `<option value="">${label} (${pool.length})</option>` + regions.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)} (${counts.get(r)})</option>`).join("");
    regionSel.value = state.dialerFilter.region;
  }
  if (industrySel){
    const industries = [...new Set(pool.filter(p => !state.dialerFilter.region || p.region === state.dialerFilter.region).map(p => p.industry).filter(Boolean))].sort();
    if (state.dialerFilter.industry && !industries.includes(state.dialerFilter.industry)) state.dialerFilter.industry = "";
    industrySel.innerHTML = `<option value="">All Industries</option>` + industries.map(i => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join("");
    industrySel.value = state.dialerFilter.industry;
  }
  if (ownerSel && document.activeElement !== ownerSel) ownerSel.value = state.dialerOwnerFilter || "";
}
function setDialerCountry(country){
  if (!DIALER_COUNTRIES[country] || state.dialerCountry === country) return;
  state.dialerCountry = country;
  state.dialerFilter.region = "";
  state.dialerFilter.industry = "";
  try { localStorage.setItem(DIALER_COUNTRY_KEY, country); } catch(e){}
  renderProspectViews();
}
// Avoids re-firing the same claim write on every re-render while the same
// prospect is sitting at the top of one person's queue.
let dialerLastAutoClaimedId = null;
function renderDialer(){
  renderDialerFilters();
  // Registering here (rather than only when a call is placed) means a
  // prospect calling back can actually reach whoever has the Dialer open -
  // see handleIncomingCall(). Silent because plenty of Dialer views (demo
  // mode, Supabase not configured yet) shouldn't pop a calling-setup alert.
  if (!voiceDevice && IS_CONFIGURED && callMode() !== "phone") getVoiceDevice(true);
  const modeSel = $("#dialer-call-mode");
  if (modeSel && document.activeElement !== modeSel) modeSel.value = callMode();
  const activePerson = window.getActivePerson ? window.getActivePerson() : null;
  // Re-checked on every render rather than a one-time flag - getActivePerson
  // isn't guaranteed to be ready on the very first render, and a one-time
  // flag that fired too early would leave the filter stuck unset. Using
  // state.dialerOwnerFilter itself as the "never touched" sentinel (null)
  // means it just self-corrects on the next render instead, and stays put
  // once the user's made an actual choice (including "" for Everyone).
  if (state.dialerOwnerFilter === null && activePerson) state.dialerOwnerFilter = activePerson;
  const personSel = $("#dialer-person-select");
  if (personSel && activePerson && document.activeElement !== personSel) personSel.value = activePerson;
  // Same playbook_usage record the Meetings Booked page's picker reads/
  // writes (see renderPlaybookUsagePicker/savePlaybookUsage) - picking it
  // here just means you don't have to leave the Dialler to set it, and the
  // two pages never disagree about what's current for a given person.
  const playbookSel = $("#dialer-playbook-select");
  if (playbookSel){
    playbookSel.innerHTML = `<option value="">Not set</option>` + state.playbooks.map(pb => `<option value="${pb.id}">${escapeHtml(pb.title)}</option>`).join("");
    if (document.activeElement !== playbookSel){
      const thisMonth = monthKey(new Date());
      const usage = activePerson ? state.playbookUsage.find(u => u.person === activePerson && u.month === thisMonth) : null;
      playbookSel.value = usage?.playbook_id || "";
    }
  }
  const filtered = dialerFilteredProspects().filter(inDialerCountry).filter(p => dialerOwnedBy(p, state.dialerOwnerFilter));
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
  [["#dialer-stat-today", dialedToday], ["#dialer-stat-fresh", neverCalled]].forEach(([id, v]) => $(id)?.closest(".mb-counter")?.classList.toggle("has-count", v > 0));
  const dateChip = $("#dialer-date-chip");
  if (dateChip) dateChip.textContent = `${new Date().toLocaleDateString("en-NZ", { weekday: "short", day: "numeric", month: "short" })} · ${DIALER_COUNTRIES[state.dialerCountry]?.label || ""}`;

  const queue = dialerQueue();
  st("#dialer-stat-left", queue.length);
  const posEl = $("#dialer-position");
  if (posEl) posEl.textContent = total ? `1 / ${total}` : "0 / 0";

  // Claim whoever's now sitting at the top of *this* person's queue, so a
  // teammate's queue skips straight past them - see isClaimedByOther().
  if (queue.length && activePerson){
    const top = queue[0];
    if (top.id !== dialerLastAutoClaimedId && top.claimed_by !== activePerson){
      dialerLastAutoClaimedId = top.id;
      DataLayer.update("dial_prospects", top.id, { claimed_by: activePerson, claimed_at: new Date().toISOString() });
    }
  }
  const claimNote = $("#dialer-claim-note");
  if (claimNote){
    const claimedByOthers = filtered.filter(p => isClaimedByOther(p, activePerson)).length;
    claimNote.textContent = claimedByOthers
      ? `${claimedByOthers} prospect${claimedByOthers===1?"":"s"} currently on a call with a teammate - hidden from your queue for now.`
      : "";
  }

  // Mirrors Prospecting's own view split (see renderProspectList) so Not
  // Interested and Follow Up aren't just invisible once actioned from here -
  // they land in their own segment instead of silently vanishing. No Answer
  // gets its own segment too, split out of the general Returning bucket -
  // it's the one people actually check on, and lumped in with Decision
  // Maker Unavailable / Booked Meeting cooldowns it wasn't findable as its
  // own thing.
  const followUp = filtered.filter(p => p.last_outcome === "call_back");
  const notInterested = filtered.filter(p => p.last_outcome === "not_interested");
  const disqualified = filtered.filter(p => p.last_outcome === "disqualified");
  const noAnswer = filtered.filter(p => p.last_outcome === "no_answer" && isSnoozed(p));
  const returning = filtered.filter(p => isReturning(p) && p.last_outcome !== "no_answer");
  const viewCounts = { active: queue.length, no_answer: noAnswer.length, follow_up: followUp.length, not_interested: notInterested.length, disqualified: disqualified.length, returning: returning.length };
  const viewLabels = { active: "Active", no_answer: "No Answer", follow_up: "Follow Up", not_interested: "Not Interested", disqualified: "Disqualified", returning: "Returning" };
  const viewSelect = $("#dialer-queue-view-select");
  if (viewSelect){
    Array.from(viewSelect.options).forEach(opt => { opt.textContent = `${viewLabels[opt.value]} (${viewCounts[opt.value]})`; });
    viewSelect.value = state.dialerQueueView;
  }
  const view = state.dialerQueueView || "active";
  const titleEl = $("#dialer-queue-title");
  if (titleEl) titleEl.textContent = view === "active" ? "Up next" : viewLabels[view];

  const upnowCard = $("#dialer-upnow-card");
  if (upnowCard) upnowCard.style.display = view === "active" ? "" : "none";

  const body = $("#dialer-current-body");
  if (body && view === "active"){
    if (!queue.length){
      body.innerHTML = emptyState(filtered.length
        ? "Everyone matching this filter has been called recently - check back once their cooldown's up."
        : "Import a CSV/XLS file or add a prospect to start power dialing.");
    } else {
      const p = queue[0];
      const callLabel = p.phone ? "Call " + escapeHtml(formatPhone(prospectE164(p))) : "No phone number";
      const callIco = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M22 16.9v3a2 2 0 01-2.2 2 19.8 19.8 0 01-8.6-3.1 19.5 19.5 0 01-6-6A19.8 19.8 0 012.1 4.2 2 2 0 014.1 2h3a2 2 0 012 1.7c.1.9.4 1.8.7 2.7a2 2 0 01-.5 2.1L8 9.8a16 16 0 006 6l1.3-1.3a2 2 0 012.1-.5c.9.3 1.8.6 2.7.7a2 2 0 011.7 2z"/></svg>`;
      const where = [p.company, p.region, p.industry].filter(Boolean).map(escapeHtml).join(" · ");
      body.innerHTML = `
        <div class="dl-person">
          <h3 class="dl-name">${escapeHtml(p.name)}</h3>
          <div class="dl-where">${where || "No company"}</div>
          ${p.phone ? `<div class="dl-phone">${phoneHtml(prospectE164(p), "phone-num-xl")}</div>` : ""}
          <div class="dl-meta">${p.last_called_at ? `Called ${Number(p.calls_made||0)}× · last ${escapeHtml(timeAgo(p.last_called_at))}` : "Never called"}${p.email ? ` · ${escapeHtml(p.email)}` : ""}</div>
        </div>
        ${IS_CONFIGURED && callMode() !== "phone"
          ? `<button type="button" class="dl-call" data-action="start-call" data-id="${p.id}" ${p.phone ? "" : "disabled"}>${callIco}${callLabel}</button>`
          : `<a href="tel:${escapeHtml(prospectE164(p))}" class="dl-call" data-action="dial-tel" data-id="${p.id}">${callIco}${callLabel}</a>`}
        ${p.notes ? `<div class="dl-notes"><span>Notes</span>${escapeHtml(p.notes)}</div>` : ""}
        <div class="dl-outcomes-label">How did it go?</div>
        <div class="dl-outcomes">
          ${OUTCOME_BUTTONS.map(o => `<button type="button" class="dl-outcome ${o.key === "booked_meeting" ? "is-booked" : ""}" data-action="dial-outcome" data-outcome="${o.key}" data-id="${p.id}">${o.label}</button>`).join("")}
        </div>
      `;
    }
  }

  const queueBody = $("#dialer-queue-body");
  if (queueBody){
    if (view === "active"){
      if (!queue.length){
        queueBody.innerHTML = emptyState(filtered.length ? "Everyone's cooling down - nobody's due for a call right now." : "No prospects yet.");
      } else {
        queueBody.innerHTML = `
          <table>
            <thead><tr><th>Name</th><th>Phone</th><th>Target</th><th>Calls</th><th></th></tr></thead>
            <tbody>
              ${queue.map((p,i) => `
                <tr data-id="${p.id}" style="${i===0?"background:var(--gold-soft);":""}">
                  <td><div class="row-name">${escapeHtml(p.name)}</div><div class="row-sub">${escapeHtml(p.company||"")}</div></td>
                  <td>${phoneHtml(prospectE164(p))}</td>
                  <td>${[p.region,p.industry].filter(Boolean).map(escapeHtml).join(" · ") || "-"}</td>
                  <td><span class="badge gray">${Number(p.calls_made||0)}</span></td>
                  <td style="text-align:right;white-space:nowrap;">
                    <button class="icon-btn" data-action="edit-prospect" data-id="${p.id}" title="Edit">${ICONS.edit}</button>
                    <button class="icon-btn" data-action="convert-prospect" data-id="${p.id}" title="Move to Contacts">${ICONS.moveToContact}</button>
                    <button class="icon-btn" data-action="delete-prospect" data-id="${p.id}" title="Delete">${ICONS.trash}</button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        `;
      }
    } else {
      const list = { no_answer: noAnswer, follow_up: followUp, not_interested: notInterested, disqualified: disqualified, returning: returning }[view] || [];
      const emptyMsg = {
        no_answer: "Nobody's currently sitting on a No Answer cooldown.",
        follow_up: "No follow-ups scheduled.",
        not_interested: "Nobody's been marked Not Interested.",
        disqualified: "Nobody's been marked Disqualified.",
        returning: "Nobody's currently cooling down.",
      }[view];
      queueBody.innerHTML = list.length ? prospectTableSection(list) : emptyState(emptyMsg);
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
  if (outcome === "call_back" || outcome === "not_interested" || outcome === "disqualified") return null;
  const now = new Date();
  // Decision Maker Unavailable gets you an actual human, just not the right
  // one - close enough to No Answer that it's worth the same short retry
  // cadence rather than its own schedule.
  if (outcome === "no_answer" || outcome === "dm_unavailable"){
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
// actually starts with their ASSIGNEES key (e.g. gabriel@...).
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
  const deltas = { calls: 1 };
  // A "conversation" is any call where an actual human was reached - every
  // outcome except No Answer. This is what Call Conversion % on Statistics
  // divides by, so it has to move for real calls, not just demo seed data.
  if (outcome !== "no_answer") deltas.conversations = 1;
  if (outcome === "booked_meeting") deltas.meetings_booked = 1;
  await window.CRM_CALL_ACTIVITY.bump(personKey, deltas);
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
  // Every real outcome releases the claim - the other fields above are what
  // actually take this prospect out of the queue (parked or snoozed), so
  // there's nothing left for the claim to protect against a teammate's
  // dialer picking them up too.
  update.claimed_by = null; update.claimed_at = null;
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
// whichever outcome is currently selected in the dropdown. Disqualified
// deliberately asks for nothing extra - it's a single click straight to the
// next prospect from the Dialer, and picking it here behaves the same way.
function updateLogCallModalFields(){
  const outcome = $("#log-call-outcome")?.value;
  const notesInput = $("#log-call-notes");
  const notesLabel = $("#log-call-notes-label");
  const followupField = $("#log-call-followup-field");
  const followupInput = $("#log-call-followup-date");
  const hint = $("#log-call-hint");
  const isNotInterested = outcome === "not_interested";
  const isDisqualified = outcome === "disqualified";
  const isCallBack = outcome === "call_back";
  if (notesInput) notesInput.required = isNotInterested;
  if (notesLabel) notesLabel.textContent = isNotInterested ? "Notes - why aren't they interested? (required)" : "Notes (optional)";
  if (followupField) followupField.style.display = isCallBack ? "" : "none";
  if (followupInput && !isCallBack) followupInput.value = "";
  if (followupInput) followupInput.required = isCallBack;
  if (hint) hint.textContent = isNotInterested
    ? "This moves them into the Not Interested list - they won't show up to call again unless someone reactivates them."
    : isDisqualified
    ? "This moves them into the Disqualified list - they won't show up to call again unless someone reactivates them."
    : isCallBack
    ? "This moves them into the Follow Up list until the task above is done."
    : "This drops them off the \"ready to call\" list for a few days so nobody calls them again too soon.";
}

/* ───────── Twilio Voice (real outbound + inbound calling from the Dialer) ───────── */
let voiceDevice = null;
let activeCall = null;
let activeCallProspectId = null;
let incomingCall = null;

// silent=true is used for the proactive registration that happens just from
// opening the Dialer page (so a teammate's browser can actually receive a
// callback) - it should never pop an alert for someone who never intended to
// place or take a call, unlike the explicit "Call" button path below.
async function getVoiceDevice(silent = false){
  if (voiceDevice) return voiceDevice;
  if (!IS_CONFIGURED){ if (!silent) alert("Connect Supabase first (see README.md) to enable real calling."); return null; }
  if (typeof Twilio === "undefined"){ if (!silent) alert("Calling isn't available: the Twilio Voice SDK failed to load."); return null; }
  const { data, error } = await supabase.functions.invoke("voice-token");
  if (error || !data?.token){ if (!silent) alert("Couldn't start the call: " + (error?.message || "no token returned.")); return null; }
  try {
    voiceDevice = new Twilio.Device(data.token, { codecPreferences: ["opus", "pcmu"] });
    voiceDevice.on("tokenWillExpire", async () => {
      const refreshed = await supabase.functions.invoke("voice-token");
      if (refreshed.data?.token) voiceDevice.updateToken(refreshed.data.token);
    });
    // Only alert on device-level errors if we were actually mid-call - a
    // background registration hiccup shouldn't interrupt someone's day.
    voiceDevice.on("error", (e) => { if (activeCall || incomingCall) alert("Call error: " + (e?.message || "unknown error")); endCall(); });
    voiceDevice.on("incoming", handleIncomingCall);
    await voiceDevice.register();
    return voiceDevice;
  } catch (e) {
    voiceDevice = null;
    if (!silent) alert("Couldn't set up calling: " + (e?.message || e));
    return null;
  }
}

// Best-effort caller ID: match the inbound number against prospects, clients
// and contacts so the banner shows a name instead of a bare digit string.
function findCallerLabel(fromNumber){
  const digits = (fromNumber||"").replace(/\D/g,"");
  if (digits){
    const prospect = state.prospects.find(p => (p.phone||"").replace(/\D/g,"") === digits);
    if (prospect) return prospect.company ? `${prospect.name} · ${prospect.company}` : prospect.name;
    const client = state.clients.find(c => (c.phone||"").replace(/\D/g,"") === digits);
    if (client) return client.name;
    const contact = state.contacts.find(c => (c.phone||"").replace(/\D/g,"") === digits);
    if (contact) return contact.company ? `${contact.name} · ${contact.company}` : contact.name;
  }
  return fromNumber ? formatPhone(fromNumber) : "Unknown number";
}

function setIncomingCallWidget(open, label){
  const widget = $("#incoming-call-widget");
  if (!widget) return;
  widget.classList.toggle("hidden", !open);
  if (label !== undefined) $("#incoming-call-name").textContent = label;
}

// A silent banner is easy to miss if the Dialer tab isn't the one you're
// looking at - Twilio only holds the ring open for a limited window (see
// RING_TIMEOUT_SECONDS server-side), so every second spent not noticing the
// call eats into the time actually left to answer it. This beeps on a loop
// and flashes the tab title until the call is accepted, declined, or
// canceled, without needing any external sound file.
let incomingCallAlertInterval = null;
const ORIGINAL_DOCUMENT_TITLE = document.title;
function startIncomingCallAlert(){
  stopIncomingCallAlert();
  const ring = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.3);
      osc.onended = () => ctx.close();
    } catch {}
    document.title = document.title === ORIGINAL_DOCUMENT_TITLE ? "☎ Incoming call..." : ORIGINAL_DOCUMENT_TITLE;
  };
  ring();
  incomingCallAlertInterval = setInterval(ring, 1200);
}
function stopIncomingCallAlert(){
  if (incomingCallAlertInterval){ clearInterval(incomingCallAlertInterval); incomingCallAlertInterval = null; }
  document.title = ORIGINAL_DOCUMENT_TITLE;
}

function handleIncomingCall(call){
  // Twilio rings every allowlisted identity in parallel (see voice-twiml) -
  // if we're already on a call or already have one ringing, let another
  // teammate's browser take it instead of stacking calls on this one.
  if (activeCall || incomingCall){ call.reject(); return; }
  incomingCall = call;
  setIncomingCallWidget(true, findCallerLabel(call.parameters.From));
  startIncomingCallAlert();
  call.on("cancel", () => { if (incomingCall === call){ incomingCall = null; setIncomingCallWidget(false); stopIncomingCallAlert(); } });
}

function acceptIncomingCall(){
  if (!incomingCall) return;
  const call = incomingCall;
  // Twilio only holds this leg open for a limited ring window - if it's
  // already been torn down server-side (timed out right as you clicked),
  // accept() would connect and then drop again instantly. Catch that here
  // with a clear message instead of a silent, confusing disconnect.
  if (call.status && call.status() === "closed"){
    incomingCall = null;
    setIncomingCallWidget(false);
    stopIncomingCallAlert();
    alert("That call already ended - it rang out before you could answer. Sorry about that.");
    return;
  }
  incomingCall = null;
  setIncomingCallWidget(false);
  stopIncomingCallAlert();
  activeCall = call;
  activeCallProspectId = null;
  setCallWidget(true, { name: findCallerLabel(call.parameters.From), status: "In call" });
  call.accept();
  call.on("disconnect", () => endCall());
  call.on("error", (e) => { alert("Call error: " + (e?.message || "unknown error")); endCall(); });
}

function declineIncomingCall(){
  if (!incomingCall) return;
  incomingCall.reject();
  incomingCall = null;
  setIncomingCallWidget(false);
  stopIncomingCallAlert();
}

function setCallWidget(open, { name, status } = {}){
  const widget = $("#call-widget");
  if (!widget) return;
  widget.classList.toggle("hidden", !open);
  if (name !== undefined) $("#call-widget-name").textContent = name;
  if (status !== undefined) $("#call-widget-status").textContent = status;
}

// How calls go out, picked per computer: "phone" hands the number to the
// computer's own calling app (Phone Link on Windows with an Android, or
// iPhone calls on a Mac), so it rings out from your own mobile number;
// "browser" calls through Twilio inside the CRM.
const CALL_MODE_KEY = "mp_call_mode";
function callMode(){
  try { return localStorage.getItem(CALL_MODE_KEY) || "phone"; } catch(e){ return "phone"; }
}
function setCallMode(mode){
  try { localStorage.setItem(CALL_MODE_KEY, mode); } catch(e){}
}
// Opens tel: without leaving the CRM - the OS passes it to Phone Link.
function dialOnPhone(e164){
  const a = document.createElement("a");
  a.href = "tel:" + e164;
  document.body.appendChild(a); a.click(); a.remove();
}
async function placeCall(phoneRaw, displayName, defaultCountryCode = "61"){
  if (activeCall){ alert("You're already on a call. Hang up first."); return false; }
  const digits = toE164(phoneRaw, defaultCountryCode);
  if (!digits){ alert("That doesn't look like a usable phone number."); return false; }
  if (callMode() === "phone"){ dialOnPhone(digits); return true; }
  const device = await getVoiceDevice();
  if (!device) return false;

  setCallWidget(true, { name: displayName || formatPhone(digits), status: `Calling ${formatPhone(digits)}…` });
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
  // Refresh the claim right as the call goes out, not just when it first
  // showed up as "Up Now" - a call that runs long shouldn't have the claim
  // time out from under it and let a teammate's dialer pick it up too.
  const activePerson = window.getActivePerson ? window.getActivePerson() : null;
  if (activePerson) DataLayer.update("dial_prospects", prospectId, { claimed_by: activePerson, claimed_at: new Date().toISOString() });
  const ok = await placeCall(p.phone, p.name, DIALER_COUNTRIES[prospectCountry(p)].code);
  if (!ok){ activeCallProspectId = null; return; }
  // Deliberately not logging an outcome here - that used to fire the instant
  // the call connected and, since "dialed" isn't a real outcome, fell through
  // to a default cooldown that snoozed the prospect immediately, booting them
  // out of the queue before you could log what actually happened on the call.
  // The Up Now card keeps showing this same prospect (and its outcome
  // buttons) until you pick a real outcome once you're off the call.
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
  $("#incoming-call-accept")?.addEventListener("click", () => acceptIncomingCall());
  $("#incoming-call-decline")?.addEventListener("click", () => declineIncomingCall());
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
// twice, since that's exactly how someone gets called twice by mistake -
// or worse, someone who already said Not Interested gets called again.
// Matches on phone OR name/company (not phone-only) - a business re-scraped
// with a slightly different phone number should still be caught by name,
// same philosophy as prospectDuplicateIds' "Possible Duplicates" flagging.
async function importProspectRows(prospects){
  if (!prospects.length){ alert("No rows found to import."); return; }
  const byPhone = new Map();
  const byName = new Map();
  state.prospects.forEach(p => {
    const phoneDigits = digitsOnly(p.phone);
    if (phoneDigits) byPhone.set(phoneDigits, p);
    const nameKey = (p.company || p.name || "").trim().toLowerCase();
    if (nameKey) byName.set(nameKey, p);
  });

  let imported = 0;
  const skipped = { not_interested: 0, disqualified: 0, booked_meeting: 0, call_back: 0, cooling_down: 0, other: 0 };
  for (const p of prospects){
    // Imports never had a country-code prompt like the manual Add Prospect
    // form does, so numbers came in exactly as scraped (e.g. "021 555 0111")
    // and only got a country code guessed at call time - normalize to E.164
    // right away instead, so what's on file is what actually gets dialed.
    p.phone = toE164(p.phone, countryCodeForRegion(p.region));
    const phoneDigits = digitsOnly(p.phone);
    const nameKey = (p.company || p.name || "").trim().toLowerCase();
    const match = (phoneDigits && byPhone.get(phoneDigits)) || (nameKey && byName.get(nameKey));
    if (match){
      if (match.last_outcome === "not_interested") skipped.not_interested++;
      else if (match.last_outcome === "disqualified") skipped.disqualified++;
      else if (match.last_outcome === "booked_meeting") skipped.booked_meeting++;
      else if (match.last_outcome === "call_back") skipped.call_back++;
      else if (isSnoozed(match)) skipped.cooling_down++;
      else skipped.other++;
      continue;
    }
    const inserted = await DataLayer.insert("dial_prospects", {
      name: p.name, phone: p.phone, company: p.company, email: p.email, website: p.website||"",
      region: p.region||"", industry: p.industry||"", google_rating: p.google_rating||"",
      calls_made: 0, last_called_at: null, last_outcome: null, last_called_by: null, snoozed_until: null, notes: p.notes||"",
    });
    // Registered immediately so a later row in this same batch that's a
    // near-duplicate of THIS one also gets caught, not just pre-existing rows.
    const registered = inserted || p;
    if (phoneDigits) byPhone.set(phoneDigits, registered);
    if (nameKey) byName.set(nameKey, registered);
    imported++;
  }
  if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
  const totalSkipped = skipped.not_interested + skipped.disqualified + skipped.booked_meeting + skipped.call_back + skipped.cooling_down + skipped.other;
  const parts = [];
  if (skipped.not_interested) parts.push(`${skipped.not_interested} already Not Interested`);
  if (skipped.disqualified) parts.push(`${skipped.disqualified} already Disqualified`);
  if (skipped.booked_meeting) parts.push(`${skipped.booked_meeting} already Booked`);
  if (skipped.call_back) parts.push(`${skipped.call_back} already a Call Back`);
  if (skipped.cooling_down) parts.push(`${skipped.cooling_down} already called recently`);
  if (skipped.other) parts.push(`${skipped.other} already on the list`);
  const skippedMsg = totalSkipped ? ` ${totalSkipped} skipped (${parts.join(", ")}).` : "";
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
  const alertsById = new Map(state.clients.map(c => [c.id, getClientAlerts(c)]));
  const attention = state.clients.filter(c => alertsById.get(c.id).length);
  const active = state.clients.filter(c => c.stage !== "churned");
  const onboardingNow = active.filter(isOnboardingClient).length;
  $("#clients-stat-total").textContent = active.length;
  const totalSub = $("#clients-stat-total-sub");
  if (totalSub) totalSub.textContent = onboardingNow ? `${onboardingNow} onboarding` : "";
  const retainers = active.map(clientRetainer).filter(v => v != null);
  $("#clients-stat-mrr").textContent = retainers.length ? fmtMoney(retainers.reduce((a,b) => a+b, 0)) : "-";
  const mrrSub = $("#clients-stat-mrr-sub");
  if (mrrSub) mrrSub.textContent = retainers.length ? `across ${retainers.length} retainer client${retainers.length === 1 ? "" : "s"}` : "no retainer deals linked";
  $("#clients-stat-cpl").textContent = avg != null ? fmtMoney(avg) : "-";
  $("#clients-stat-campaigns").textContent = state.campaigns.filter(c => c.status === "active").length;
  const attnEl = $("#clients-stat-attention");
  if (attnEl) attnEl.textContent = attention.length;

  // Filter chips: All / Needs attention / each stage that has clients.
  // Empty stages stay out of the way instead of each taking up a box.
  const stageOf = (c) => c.stage || "onboarding";
  let filter = state.clientsStageFilter || "all";
  if (filter === "attention" && !attention.length) filter = state.clientsStageFilter = "all";
  if (filter !== "all" && filter !== "attention" && !state.clients.some(c => stageOf(c) === filter)) filter = state.clientsStageFilter = "all";
  const chipsEl = $("#clients-stage-chips");
  if (chipsEl){
    const chip = (key, label, count, extra="") => `<button type="button" class="cl-chip ${extra} ${filter===key?"active":""}" data-cl-filter="${key}">${label}<span>${count}</span></button>`;
    chipsEl.innerHTML = chip("all", "All", state.clients.length)
      + (attention.length ? chip("attention", "Needs attention", attention.length, "warn") : "")
      + CLIENT_STAGES.map(st => {
          const n = state.clients.filter(c => stageOf(c) === st.key).length;
          return n ? chip(st.key, st.label, n) : "";
        }).join("");
  }

  const list = $("#clients-gallery");
  if (!list) return;
  if (!state.clients.length){ list.innerHTML = `<div class="card">${emptyState("No clients yet. Add your first client to get started.")}</div>`; return; }

  const q = state.clientsGallerySearch.trim().toLowerCase();
  const boardView = clientsView() === "board";
  $("#clients-stage-chips")?.toggleAttribute("hidden", boardView);
  $$("[data-cl-view]").forEach(b => { const on = b.dataset.clView === clientsView(); b.classList.toggle("active", on); b.setAttribute("aria-pressed", on); });
  if (boardView){
    list.innerHTML = clientsBoardHtml(state.clients.filter(c => !q || (c.name||"").toLowerCase().includes(q)), alertsById);
    return;
  }
  const visible = state.clients
    .filter(c => !q || (c.name||"").toLowerCase().includes(q))
    .filter(c => filter === "all" || (filter === "attention" ? alertsById.get(c.id).length : stageOf(c) === filter));

  if (!visible.length){
    list.innerHTML = `<div class="card">${emptyState(q ? `No clients match "${state.clientsGallerySearch.trim()}".` : "No clients in this view.")}</div>`;
    return;
  }
  const groups = CLIENT_STAGES.map(st => ({
    st, clients: visible.filter(c => stageOf(c) === st.key).sort((a,b) => (a.name||"").localeCompare(b.name||""))
  })).filter(g => g.clients.length);

  list.innerHTML = `
    <div class="card cl-table">
      <div class="cl-row cl-row-head">
        <div>Client</div><div>Progress</div><div class="num">CPL</div><div class="num">Spend / mo</div><div class="num">Live</div><div>Churn Risk</div><div>Stage</div>
      </div>
      ${groups.map(g => `
        <div class="cl-group" data-stage="${g.st.key}">
          <span class="cl-group-dot"></span>${g.st.label}<span class="cl-group-count">${g.clients.length}</span>
          ${g.st.key === "onboarding" ? `<button type="button" class="cl-group-link" data-action="open-onboarding-board">Open launch board →</button>` : ""}
        </div>
        ${g.clients.map(c => renderClientRow(c, alertsById.get(c.id))).join("")}
      `).join("")}
    </div>`;
}
/* Board columns (Clients and Onboarding) show 2 cards until "Show more" is pressed. */
const BOARD_PREVIEW_COUNT = 2;
const boardExpanded = new Set();
function boardColumnCards(boardKey, stageKey, cardsHtml){
  const key = `${boardKey}:${stageKey}`;
  const open = boardExpanded.has(key);
  const shown = open ? cardsHtml : cardsHtml.slice(0, BOARD_PREVIEW_COUNT);
  const extra = cardsHtml.length - BOARD_PREVIEW_COUNT;
  return shown.join("") + (extra > 0
    ? `<button type="button" class="kanban-more board-more" data-action="toggle-board-col" data-key="${key}" aria-expanded="${open}">${open ? "Show less" : `Show ${extra} more`}</button>`
    : "");
}

/* ───────── Content Library: video scripts ─────────
   One script per client video: 20 hooks (the first 3 seconds - we test them
   against each other) and 3 bodies (the rest of the video, three ways), plus
   the call to action. Once it's filled in, "Create filming email" writes the
   client a filming brief with every line to say and exactly how to film it,
   and saves it to Email Templates. Stored as client_content rows with
   type "video_script"; the script itself is JSON in the script column. */
const VS_HOOKS = 20, VS_BODIES = 3;
const VS_STAGES = [
  { key: "writing", label: "Writing", status: "scripting" },
  { key: "sent", label: "Sent to client", status: "filming" },
  { key: "filmed", label: "Filmed", status: "filming" },
  { key: "live", label: "Edited & live", status: "posted" },
];
const VS_BODY_NAMES = ["The story", "The proof", "The offer"];
let vsOpenId = null, vsSaveTimer = null;
const vsRows = () => state.clientContent.filter(r => r.type === "video_script");
function vsData(row){
  let d = {}; try { d = JSON.parse(row?.script || "{}") || {}; } catch(e){ d = {}; }
  const hooks = Array.from({ length: VS_HOOKS }, (_, i) => String((d.hooks || [])[i] || ""));
  const bodies = Array.from({ length: VS_BODIES }, (_, i) => ({ name: ((d.bodies || [])[i] || {}).name || VS_BODY_NAMES[i], text: ((d.bodies || [])[i] || {}).text || "" }));
  return { hooks, bodies, cta: d.cta || "", where: d.where || "", wear: d.wear || "", due: d.due || "", stage: d.stage || "writing", month: d.month || ymOf(localDayStr()), templateId: d.templateId || null };
}
const vsWords = (s) => (String(s).match(/\S+/g) || []).length;
const vsSecs = (s) => Math.round(vsWords(s) / 2.5);
function vsCounts(d){
  return { hooks: d.hooks.filter(h => h.trim()).length, bodies: d.bodies.filter(b => b.text.trim()).length };
}
async function vsCreate(clientId, month){
  const c = state.clients.find(x => x.id === clientId);
  const ym = month || ymOf(localDayStr());
  const monthName = new Date(ym + "-01T00:00:00").toLocaleDateString("en-NZ", { month: "long" });
  const d = { hooks: [], bodies: VS_BODY_NAMES.map(n => ({ name: n, text: "" })), cta: "", stage: "writing", month: ym };
  const row = await DataLayer.insert("client_content", { client_id: clientId, type: "video_script", status: "scripting", title: `${monthName} video`, script: JSON.stringify(d), directions: "", notes: "" });
  if (IS_CONFIGURED) await DataLayer.fetchAll();
  const made = row || vsRows().find(r => r.client_id === clientId && vsData(r).month === ym);
  vsOpenId = made?.id || null;
  if (!c) return;
  renderContentLibrary();
}
// Saves what's typed a moment after you stop typing.
function vsQueueSave(){
  clearTimeout(vsSaveTimer);
  const el = $("#vs-save-state"); if (el) el.textContent = "Saving…";
  vsSaveTimer = setTimeout(vsSaveNow, 600);
}
async function vsSaveNow(){
  clearTimeout(vsSaveTimer);
  const row = state.clientContent.find(r => r.id === vsOpenId);
  if (!row) return;
  const prev = vsData(row);
  const d = {
    ...prev,
    hooks: $$("#vs-editor .vs-hook-input").map(i => i.value),
    bodies: $$("#vs-editor .vs-body").map(b => ({ name: b.querySelector(".vs-body-name").value.trim(), text: b.querySelector(".vs-body-text").value })),
    cta: $("#vs-cta")?.value || "", where: $("#vs-where")?.value || "", wear: $("#vs-wear")?.value || "", due: $("#vs-due")?.value || "",
  };
  const title = $("#vs-title")?.value.trim() || row.title;
  const patch = { title, script: JSON.stringify(d), updated_at: new Date().toISOString() };
  Object.assign(row, patch);
  await DataLayer.update("client_content", row.id, patch);
  const el = $("#vs-save-state"); if (el) el.textContent = "Saved";
  vsRefreshCounts();
}
function vsRefreshCounts(){
  const row = state.clientContent.find(r => r.id === vsOpenId);
  if (!row) return;
  const hooks = $$("#vs-editor .vs-hook-input").filter(i => i.value.trim()).length;
  const bodies = $$("#vs-editor .vs-body-text").filter(t => t.value.trim()).length;
  const hc = $("#vs-hook-count"); if (hc) hc.textContent = `${hooks}/${VS_HOOKS}`;
  const bc = $("#vs-body-count"); if (bc) bc.textContent = `${bodies}/${VS_BODIES}`;
  $$("#vs-editor .vs-body").forEach(b => { const t = b.querySelector(".vs-body-text").value; b.querySelector(".vs-body-len").textContent = t.trim() ? `${vsWords(t)} words · about ${vsSecs(t)}s` : "Not written yet"; });
  const pct = Math.round((hooks / VS_HOOKS * 0.6 + bodies / VS_BODIES * 0.4) * 100);
  const bar = $("#vs-progress"); if (bar) bar.style.width = pct + "%";
  const ready = hooks >= 1 && bodies >= 1;
  const btn = $("#vs-make-email"); if (btn) btn.disabled = !ready;
}
// The filming brief the client gets: every line, and exactly how to film it.
function vsEmail(row){
  const d = vsData(row), c = state.clients.find(x => x.id === row.client_id) || {};
  const first = (c.onboarding_progress || {}).contact_first || (c.key_contacts || "").split(/[\s,-]/)[0] || "there";
  const person = window.getActivePerson ? window.getActivePerson() : null;
  const sender = ASSIGNEES[person]?.label || "Rocky";
  const hooks = d.hooks.map(h => h.trim()).filter(Boolean);
  const bodies = d.bodies.filter(b => b.text.trim());
  const monthName = new Date(d.month + "-01T00:00:00").toLocaleDateString("en-NZ", { month: "long" });
  const due = d.due ? new Date(d.due + "T00:00:00").toLocaleDateString("en-NZ", { weekday: "long", day: "numeric", month: "long" }) : "";
  const lines = [];
  lines.push(`Hi ${first},`, "");
  lines.push(`Here's everything for your ${monthName} video. It should take about 30-40 minutes to film, and you don't need to memorise anything - read each line off this email between takes.`, "");
  lines.push("HOW TO FILM", "");
  [
    "Hold your phone upright (portrait), on the back camera, at eye height. Prop it on a shelf or tripod - no selfie-stick wobble.",
    "Film somewhere quiet, facing a window or outside in the shade so your face is well lit. No bright light behind you.",
    "Look straight into the camera lens, not at the screen. Talk like you're explaining it to a mate.",
    "Hit record, wait 2 seconds, say the line, wait 2 seconds, then stop. One line per clip makes our editing much faster.",
    "Say each line twice. If you stumble, just pause and start the line again - we'll cut it.",
    "Energy up a notch more than feels normal. It comes across much calmer on camera.",
  ].forEach((t, i) => lines.push(`${i + 1}. ${t}`));
  if (d.where.trim()) lines.push("", `Where: ${d.where.trim()}`);
  if (d.wear.trim()) lines.push(`What to wear: ${d.wear.trim()}`);
  lines.push("", `PART 1 - THE HOOKS (${hooks.length})`, "These are the opening lines. Each one is its own short clip - we'll test them against each other to find the winner.", "");
  hooks.forEach((h, i) => lines.push(`Hook ${i + 1}: "${h}"`));
  lines.push("", `PART 2 - THE MAIN VIDEO (${bodies.length} version${bodies.length === 1 ? "" : "s"})`, "Film each version in full, start to finish, as its own clip. Read it through once before you hit record.", "");
  bodies.forEach((b, i) => {
    lines.push(`Version ${String.fromCharCode(65 + i)}${b.name ? ` - ${b.name}` : ""} (about ${Math.max(10, vsSecs(b.text))} seconds):`);
    lines.push(b.text.trim(), "");
  });
  if (d.cta.trim()) lines.push("PART 3 - THE ENDING", "Film this on its own, twice:", `"${d.cta.trim()}"`, "");
  lines.push("SENDING IT TO US", "Upload all the clips to a Google Drive folder (or WeTransfer) and send us the link. Don't edit or trim anything - send the raw clips.");
  if (due) lines.push("", `If you can get them to us by ${due}, we'll have your new ad live within the week.`);
  lines.push("", "Any questions at all, just give me a call.", "", "Cheers,", sender, "Mr Priceless");
  return { subject: `Your ${monthName} video - what to film`, body: lines.join("\n"), to: c.report_email || c.email || "" };
}
async function vsMakeEmail(){
  await vsSaveNow();
  const row = state.clientContent.find(r => r.id === vsOpenId);
  if (!row) return;
  const c = state.clients.find(x => x.id === row.client_id);
  const d = vsData(row), em = vsEmail(row);
  const title = `Filming brief · ${c?.name || "Client"} · ${new Date(d.month + "-01T00:00:00").toLocaleDateString("en-NZ", { month: "long", year: "numeric" })}`;
  // One template per script: made the first time, updated after that.
  let tpl = d.templateId && state.emailTemplates.find(t => t.id === d.templateId);
  if (tpl) await DataLayer.update("email_templates", tpl.id, { title, subject: em.subject, body: em.body, updated_at: new Date().toISOString() });
  else {
    tpl = await DataLayer.insert("email_templates", { title, subject: em.subject, body: em.body, sort_order: state.emailTemplates.length });
    if (tpl?.id){ d.templateId = tpl.id; await DataLayer.update("client_content", row.id, { script: JSON.stringify(d) }); row.script = JSON.stringify(d); }
  }
  if (IS_CONFIGURED) await DataLayer.fetchAll();
  $("#vs-email-subject").value = em.subject;
  $("#vs-email-body").value = em.body;
  $("#vs-email-to").textContent = em.to ? `To ${em.to}` : "Add their email on the client to send it straight from here";
  $("#vs-email-send").href = `mailto:${encodeURIComponent(em.to)}?subject=${encodeURIComponent(em.subject)}&body=${encodeURIComponent(em.body)}`;
  $("#vs-email-saved").textContent = `Saved to Email Templates as “${title}”.`;
  openModal("vs-email-modal");
}
function renderContentLibrary(){
  const root = $("#vs-root");
  if (!root) return;
  const row = vsOpenId && state.clientContent.find(r => r.id === vsOpenId);
  if (vsOpenId && !row) vsOpenId = null;
  // Don't redraw the editor under someone's fingers.
  if (row && root.dataset.open === row.id && root.contains(document.activeElement)) return;
  root.dataset.open = row ? row.id : "";
  root.innerHTML = row ? vsEditorHtml(row) : vsListHtml();
  if (row) vsRefreshCounts();
}
function vsListHtml(){
  const rows = vsRows().map(r => ({ r, d: vsData(r), c: state.clients.find(x => x.id === r.client_id) }))
    .sort((a, b) => b.d.month.localeCompare(a.d.month) || (a.c?.name || "").localeCompare(b.c?.name || ""));
  const clients = state.clients.filter(c => normalizeClientStage(c.stage) !== "churned").sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const months = [...new Set(rows.map(x => x.d.month))];
  return `
    <div class="vs-new card">
      <div><b>New video script</b><span>20 hooks, 3 bodies and the ending - then it writes the filming email for you.</span></div>
      <select id="vs-new-client" class="filter-select"><option value="">Pick a client…</option>${clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")}</select>
      <button type="button" class="btn gold" data-action="vs-new">Start script</button>
    </div>
    ${!rows.length ? `<div class="card vs-empty">${emptyState("No scripts yet. Pick a client above to write their first one.")}</div>` : months.map(m => `
      <section class="vs-month">
        <h3 class="vs-month-title">${escapeHtml(new Date(m + "-01T00:00:00").toLocaleDateString("en-NZ", { month: "long", year: "numeric" }))}</h3>
        <div class="vs-grid">${rows.filter(x => x.d.month === m).map(({ r, d, c }) => { const n = vsCounts(d), st = VS_STAGES.find(s => s.key === d.stage) || VS_STAGES[0]; return `
          <button type="button" class="vs-card vs-stage-${st.key}" data-action="vs-open" data-id="${r.id}">
            <span class="vs-card-client">${escapeHtml(c?.name || "Deleted client")}</span>
            <span class="vs-card-title">${escapeHtml(r.title || "Video")}</span>
            <span class="vs-card-meter"><span><b>${n.hooks}</b>/${VS_HOOKS} hooks</span><span><b>${n.bodies}</b>/${VS_BODIES} bodies</span></span>
            <span class="vs-card-bar"><i style="width:${Math.round((n.hooks / VS_HOOKS * 0.6 + n.bodies / VS_BODIES * 0.4) * 100)}%"></i></span>
            <span class="vs-card-stage">${escapeHtml(st.label)}</span>
          </button>`; }).join("")}</div>
      </section>`).join("")}`;
}
function vsEditorHtml(row){
  const d = vsData(row), c = state.clients.find(x => x.id === row.client_id);
  return `
    <div class="vs-editor" id="vs-editor" data-id="${row.id}">
      <div class="vs-bar">
        <button type="button" class="pbx-back" data-action="vs-close">← All scripts</button>
        <input type="text" id="vs-title" class="vs-title" value="${escapeHtml(row.title || "")}" placeholder="Video name" aria-label="Video name">
        <span class="vs-bar-client">${escapeHtml(c?.name || "")}</span>
        <select id="vs-stage" class="filter-select" aria-label="Stage">${VS_STAGES.map(s => `<option value="${s.key}" ${s.key === d.stage ? "selected" : ""}>${s.label}</option>`).join("")}</select>
        <span class="vs-save" id="vs-save-state">Saved</span>
        <button type="button" class="icon-btn" data-action="vs-delete" data-id="${row.id}" title="Delete script">${ICONS.trash}</button>
        <span class="vs-progress"><i id="vs-progress"></i></span>
      </div>

      <section class="vs-sec card">
        <header class="vs-sec-head"><span class="vs-sec-num">1</span><div><h3>Hooks <span class="vs-count" id="vs-hook-count"></span></h3><p>The first 3 seconds. Each one gets filmed as its own clip so we can test them against each other. Short, punchy, straight to camera.</p></div></header>
        <div class="vs-hooks">${d.hooks.map((h, i) => `
          <label class="vs-hook"><span>${i + 1}</span><input type="text" class="vs-hook-input" value="${escapeHtml(h)}" maxlength="200" placeholder="${i === 0 ? "e.g. Most builders won't tell you this about decks…" : i === 1 ? "e.g. Here's what a $40k bathroom actually looks like" : ""}"></label>`).join("")}
        </div>
      </section>

      <section class="vs-sec card">
        <header class="vs-sec-head"><span class="vs-sec-num">2</span><div><h3>Bodies <span class="vs-count" id="vs-body-count"></span></h3><p>The rest of the video, three different ways. Any hook can go on the front of any body. Aim for 20-40 seconds each.</p></div></header>
        <div class="vs-bodies">${d.bodies.map((b, i) => `
          <div class="vs-body">
            <div class="vs-body-head"><span class="vs-body-letter">${String.fromCharCode(65 + i)}</span><input type="text" class="vs-body-name" value="${escapeHtml(b.name)}" placeholder="Name this version" maxlength="60"><span class="vs-body-len"></span></div>
            <textarea class="vs-body-text" rows="7" placeholder="${["Tell the story: the problem the customer had, what you did, how it turned out.", "Show the proof: reviews, numbers, before and after, why people pick you.", "Make the offer: what they get, why now, what happens when they get in touch."][i]}">${escapeHtml(b.text)}</textarea>
          </div>`).join("")}
        </div>
      </section>

      <section class="vs-sec card">
        <header class="vs-sec-head"><span class="vs-sec-num">3</span><div><h3>Ending and filming notes</h3><p>How every version finishes, and anything they need to know before they film.</p></div></header>
        <div class="vs-extras">
          <div class="field vs-wide"><label for="vs-cta">Call to action (the last line)</label><input type="text" id="vs-cta" value="${escapeHtml(d.cta)}" placeholder="e.g. Tap the button below and we'll come out for a free quote this week."></div>
          <div class="field"><label for="vs-where">Where to film</label><input type="text" id="vs-where" value="${escapeHtml(d.where)}" placeholder="e.g. On a finished job, or outside the van"></div>
          <div class="field"><label for="vs-wear">What to wear</label><input type="text" id="vs-wear" value="${escapeHtml(d.wear)}" placeholder="e.g. Branded work shirt"></div>
          <div class="field"><label for="vs-due">Clips back by</label><input type="date" id="vs-due" value="${escapeHtml(d.due)}"></div>
        </div>
      </section>

      <div class="vs-finish card">
        <div><b>All filled in?</b><span>We'll write the client a filming email with every line and exactly how to film it, and save it to Email Templates.</span></div>
        <button type="button" class="btn gold" id="vs-make-email" data-action="vs-email">Create filming email →</button>
      </div>
    </div>`;
}

/* ───────── Ads This Month ─────────
   The rule: every client gets 1 video ad and 2 static ads live each month.
   Each ad moves Brief → Made → Live and only counts once it's live. The
   procedure has dates on it - briefs by the 3rd, statics live by the 14th,
   the video live by the 21st - so anything slipping goes red on its own.
   Stored per client per month in clients.onboarding_progress.ads. */
// A little burst of confetti from a point on screen (an ad going live).
function pbConfetti(x, y, n = 26){
  const colors = ["#e8c468", "#b8912c", "#3f7d55", "#3b6fb6", "#c0583b", "#fff3c4"];
  for (let i = 0; i < n; i++){
    const s = document.createElement("span");
    s.className = "pbx-confetti";
    const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 120;
    s.style.cssText = `left:${x}px;top:${y}px;background:${colors[i % colors.length]};--dx:${Math.cos(a) * d}px;--dy:${Math.sin(a) * d - 60}px;--r:${Math.random() * 720 - 360}deg`;
    document.body.appendChild(s);
    setTimeout(() => s.remove(), 1000);
  }
}
const AM_SLOTS = [
  { key: "static1", kind: "static", label: "Static ad 1", due: 14 },
  { key: "static2", kind: "static", label: "Static ad 2", due: 14 },
  { key: "video", kind: "video", label: "Video ad", due: 21 },
];
const AM_STEPS = [
  { key: "brief", label: "Brief" },
  { key: "made", label: "Made" },
  { key: "live", label: "Live" },
];
const AM_BRIEF_DUE = 3;
const AM_STAGES = new Set(["quote_guarantee", "live", "at_risk"]);
const amYm = () => state.amMonth || ymOf(localDayStr());
const amClients = () => state.clients.filter(c => AM_STAGES.has(normalizeClientStage(c.stage)));
const amMonthOf = (c, ym) => ((c.onboarding_progress || {}).ads || {})[ym] || {};
function amDueDay(ym, day){ return `${ym}-${String(day).padStart(2, "0")}`; }
// Where a client is up to this month: how many are live, and whether any slot is past its date.
function amClientProgress(c, ym = amYm()){
  const m = amMonthOf(c, ym), today = localDayStr();
  const slots = AM_SLOTS.map(sl => {
    const v = m[sl.key] || {}, status = v.s || "";
    const briefLate = !status && today > amDueDay(ym, AM_BRIEF_DUE);
    const late = status !== "live" && today > amDueDay(ym, sl.due);
    return { ...sl, status, title: v.t || "", late, briefLate };
  });
  const live = slots.filter(s => s.status === "live").length;
  return { slots, live, target: AM_SLOTS.length, overdue: slots.some(s => s.late) };
}
async function amSetSlot(clientId, slotKey, patch){
  const c = state.clients.find(x => x.id === clientId);
  if (!c) return;
  const ym = amYm(), op = c.onboarding_progress || {};
  const ads = { ...(op.ads || {}) }, month = { ...(ads[ym] || {}) };
  month[slotKey] = { ...(month[slotKey] || {}), ...patch, at: new Date().toISOString() };
  ads[ym] = month;
  await rcSaveClient(c.id, { ads });
}
function amNavCount(){
  const el = $("#nav-ads-count");
  if (!el) return;
  const ym = ymOf(localDayStr());
  const left = amClients().reduce((n, c) => n + (AM_SLOTS.length - amClientProgress(c, ym).live), 0);
  el.hidden = !left; el.textContent = left;
}
const amFmtDay = (ym, d) => new Date(amDueDay(ym, d) + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
// One row per client, one box per ad. Tap a box: To do → Made → Live → back to To do.
const AM_CYCLE = { "": "made", brief: "made", made: "live", live: "" };
const AM_LOOK = {
  "": { label: "To do", cls: "todo" }, brief: { label: "To do", cls: "todo" },
  made: { label: "Made", cls: "made" }, live: { label: "Live", cls: "live" },
};
function renderAdsMonth(){
  amNavCount();
  const root = $("#am-root"), nav = $("#am-month-nav");
  if (!root || !nav) return;
  const ym = amYm(), thisYm = ymOf(localDayStr()), isNow = ym === thisYm;
  const monthName = new Date(ym + "-01T00:00:00").toLocaleDateString("en-NZ", { month: "long" });
  const monthLabel = new Date(ym + "-01T00:00:00").toLocaleDateString("en-NZ", { month: "long", year: "numeric" });
  nav.innerHTML = `<button type="button" class="am-nav-btn" data-action="am-month" data-step="-1" aria-label="Previous month">‹</button>
    <span class="am-nav-label">${escapeHtml(monthLabel)}</span>
    <button type="button" class="am-nav-btn" data-action="am-month" data-step="1" aria-label="Next month" ${ym >= thisYm ? "disabled" : ""}>›</button>`;
  const clients = amClients().sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  if (!clients.length){
    root.innerHTML = `<div class="card am-empty">${emptyState("No live clients yet. Clients on Quote Guarantee, Live or At Risk show up here.")}</div>`;
    return;
  }
  const rows = clients.map(c => ({ c, p: amClientProgress(c, ym) }));
  const target = rows.length * AM_SLOTS.length, live = rows.reduce((n, r) => n + r.p.live, 0);
  const late = rows.reduce((n, r) => n + r.p.slots.filter(s => s.late).length, 0);
  const today = new Date(), daysLeft = isNow ? new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate() - today.getDate() : 0;
  const pct = target ? Math.round(live / target * 100) : 0;
  const cell = (c, s) => {
    const look = AM_LOOK[s.status] || AM_LOOK[""];
    return `<button type="button" class="am-box am-${look.cls}${s.late ? " is-late" : ""}" data-action="am-tap" data-id="${c.id}" data-slot="${s.key}" title="${escapeHtml(c.name)} · ${s.label}: ${look.label}${s.late ? " (late)" : ""} - tap to change">
      <span class="am-box-dot"></span>${s.status === "live" ? "Live ✓" : s.late ? `${look.label} · late` : look.label}
    </button>`;
  };
  root.innerHTML = `
    <div class="am-summary">
      <div class="am-summary-text"><b>${live} of ${target}</b> ads live${isNow ? ` · ${daysLeft} day${daysLeft === 1 ? "" : "s"} left in ${escapeHtml(monthName)}` : ""}${late ? ` · <span class="am-late-txt">${late} late</span>` : ""}</div>
      <div class="am-bar"><i style="width:${pct}%"></i></div>
    </div>
    <div class="am-table card">
      <div class="am-row am-head">
        <span>Client</span>
        <span>Static 1<small>live by ${amFmtDay(ym, 14)}</small></span>
        <span>Static 2<small>live by ${amFmtDay(ym, 14)}</small></span>
        <span>Video<small>live by ${amFmtDay(ym, 21)}</small></span>
      </div>
      ${rows.map(({ c, p }) => {
        const hasScript = vsRows().some(r => r.client_id === c.id && vsData(r).month === ym);
        return `<div class="am-row${p.live === p.target ? " is-done" : ""}">
          <span class="am-who">
            <button type="button" class="am-client-name" data-action="view-client" data-id="${c.id}">${escapeHtml(c.name)}</button>
            <span class="am-who-sub">${p.live}/3 live · <button type="button" class="am-script-link" data-action="am-script" data-id="${c.id}">${hasScript ? "Video script" : "+ Video script"}</button></span>
          </span>
          ${p.slots.map(s => cell(c, s)).join("")}
        </div>`;
      }).join("")}
    </div>
    <p class="am-howto">Tap a box to move it along: <span class="am-key am-todo">To do</span> → <span class="am-key am-made">Made</span> → <span class="am-key am-live">Live</span>. Tap a live one to start it over. Anything not live by its date shows as late.</p>`;
}
/* ───────── Clients board: drag clients between lifecycle stages ───────── */
function clientsView(){
  if (!state.clientsView){ try { state.clientsView = localStorage.getItem("mp_clients_view") === "list" ? "list" : "board"; } catch(e){ state.clientsView = "board"; } }
  return state.clientsView;
}
const CLIENT_STAGE_BLURBS = {
  onboarding: "Signed, getting set up", quote_guarantee: "Delivering the quotes", live: "Ads running, month to month",
  at_risk: "Needs attention", churned: "No longer with us",
};
function clientFatiguingCount(c){
  return state.adCreatives.filter(a => a.client_id === c.id && (a.fatigue_status === "fatiguing" || a.fatigue_status === "fatigued")).length;
}
function clientsBoardHtml(clients, alertsById){
  const stageOf = (c) => c.stage || "onboarding";
  // Churned sits in a slim strip under the board (still a drop target), not a full column.
  const churned = clients.filter(c => stageOf(c) === "churned");
  const showChurned = !!state.showChurned;
  return `<div class="onb-board cl-board cl-board-5" id="clients-board">${CLIENT_STAGES.filter(st => st.key !== "churned").map((st, i) => {
    const col = clients.filter(c => stageOf(c) === st.key).sort((a,b) => (a.name||"").localeCompare(b.name||""));
    const mrr = col.map(clientRetainer).filter(v => v != null).reduce((a,b) => a+b, 0);
    return `
      <section class="onb-col" data-stage="${st.key}" data-board="clients" aria-label="${escapeHtml(st.label)}">
        <header class="onb-col-head">
          <span class="onb-col-num">${i + 1}</span>
          <div><div class="onb-col-title">${escapeHtml(st.label)}</div><div class="onb-col-blurb">${mrr ? `${fmtMoney(mrr)}/mo` : escapeHtml(CLIENT_STAGE_BLURBS[st.key] || "")}</div></div>
          <span class="onb-col-count">${col.length}</span>
        </header>
        <div class="onb-col-body">
          ${boardColumnCards("clients", st.key, col.map(c => clientBoardCardHtml(c, alertsById.get(c.id) || [])))}
          <div class="onb-drop-hint">${col.length ? "Drop here" : "Drag a client here"}</div>
        </div>
      </section>`;
  }).join("")}</div>
  <section class="onb-col cl-churned${showChurned ? " open" : ""}" data-stage="churned" data-board="clients" aria-label="Churned">
    <button type="button" class="cl-churned-head" data-action="toggle-churned">
      <span class="onb-col-title">Churned</span><span class="onb-col-count">${churned.length}</span>
      <span class="cl-churned-hint">${showChurned ? "Hide" : churned.length ? "Show" : "Drag a client here to mark them churned"}</span>
    </button>
    ${showChurned && churned.length ? `<div class="onb-col-body cl-churned-body">${churned.map(c => clientBoardCardHtml(c, alertsById.get(c.id) || [])).join("")}</div>` : ""}
  </section>`;
}
function clientBoardCardHtml(c, alerts){
  const stage = c.stage || "onboarding";
  const days = c.stage_changed_at ? daysSince(c.stage_changed_at) : null;
  const retainer = clientRetainer(c);
  const deal = c.source_deal_id ? state.deals.find(d => d.id === c.source_deal_id) : null;
  const owner = (c.onboarding_progress || {}).owner || deal?.assignee || null;
  const live = runningCampaignsFor(c.id).length;
  const fatiguing = clientFatiguingCount(c);
  const chips = [];
  alerts.forEach(a => chips.push(`<span class="onb-status ${a.type === "danger" ? "late" : "client"}">${escapeHtml(a.text.replace(" - overdue to move on", ""))}</span>`));
  if (fatiguing && stage !== "creatives_due") chips.push(`<span class="onb-status client">${fatiguing} creative${fatiguing === 1 ? "" : "s"} fatiguing</span>`);
  if (["quote_guarantee", "live", "at_risk"].includes(stage)){ const am = amClientProgress(c); if (am.live < am.target) chips.push(`<span class="onb-status ${am.overdue ? "late" : "client"}">Ads ${am.live}/${am.target} live this month</span>`); }
  if (c.churn_risk === "high" || c.churn_risk === "medium") chips.push(`<span class="onb-status ${c.churn_risk === "high" ? "late" : "client"}">${c.churn_risk === "high" ? "High" : "Medium"} churn risk</span>`);
  let body = "";
  if (stage === "onboarding"){
    const ls = launchState(c);
    body = `<div class="onb-card-progress"><span class="cl-card-label">${escapeHtml(ls.stage.label)}</span><div class="onb-bar"><span style="width:${ls.pct}%"></span></div><span class="onb-bar-label">${ls.doneTasks}/${ls.total}</span></div>`;
  } else if (stage === "quote_guarantee" && c.quote_target){
    const sent = Number(c.quotes_sent || 0);
    body = `<div class="onb-card-progress"><span class="cl-card-label">Quotes</span><div class="onb-bar"><span style="width:${Math.min(100, Math.round(sent / c.quote_target * 100))}%"></span></div><span class="onb-bar-label">${sent}/${c.quote_target}</span></div>`;
  }
  const stats = [
    c.cost_per_lead != null ? `<span><b>${fmtMoney(c.cost_per_lead)}</b> CPL</span>` : "",
    `<span><b>${live}</b> live</span>`,
    stage === "creatives_due" || fatiguing ? `<span><b>${fatiguing}</b> fatiguing</span>` : "",
  ].filter(Boolean).join("");
  const back = (c.onboarding_progress || {}).before_creatives;
  const footer = stage === "creatives_due"
    ? `<button type="button" class="onb-finish" data-action="creatives-done" data-id="${c.id}">New creatives live → ${escapeHtml(CLIENT_STAGE_MAP[back]?.label || "Established")}</button>`
    : "";
  return `
    <article class="onb-card cl-card" draggable="true" data-action="${stage === "onboarding" ? "onb-open" : "view-client"}" data-id="${c.id}" tabindex="0" aria-label="${escapeHtml(c.name)}">
      <div class="onb-card-top">
        <span class="onb-card-avatar">${escapeHtml((c.name || "?").trim().charAt(0).toUpperCase())}</span>
        <div class="onb-card-id">
          <div class="onb-card-name">${escapeHtml(c.name)}</div>
          <div class="onb-card-meta">${[stage === "live" && clientMonthNumber(c) ? `Month ${clientMonthNumber(c)}` : "", retainer != null ? `${fmtMoney(retainer)}/mo` : "", days != null ? `${days}d here` : ""].filter(Boolean).join(" · ") || "&nbsp;"}</div>
        </div>
        ${ownerChipHtml(owner, true)}
        <button type="button" class="cl-card-del" data-action="delete-client-row" data-id="${c.id}" title="Delete ${escapeHtml(c.name)}" aria-label="Delete ${escapeHtml(c.name)}">${ICONS.trash}</button>
      </div>
      ${chips.length ? `<div class="cl-card-chips">${chips.join("")}</div>` : ""}
      ${body}
      <div class="cl-card-stats">${stats}</div>
      ${footer}
    </article>`;
}
// Moves a client to another lifecycle stage. Going into New Creatives Due
// remembers where they came from, so the card can send them back after.
async function moveClientStage(c, stage){
  const before = c.stage || "onboarding";
  if (!CLIENT_STAGE_MAP[stage] || stage === before) return;
  const now = new Date().toISOString();
  const patch = { stage, stage_changed_at: now, updated_at: now };
  if (stage === "creatives_due") patch.onboarding_progress = { ...(c.onboarding_progress || {}), before_creatives: before };
  if (before === "onboarding" && stage !== "onboarding" && !(c.onboarding_progress || {}).live_at)
    patch.onboarding_progress = { ...(patch.onboarding_progress || c.onboarding_progress || {}), live_at: now };
  await DataLayer.update("clients", c.id, patch);
  if (stage === "onboarding") openWelcomePack(c.id);
  if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
}
function setupClientsBoardDrag(){
  const host = $("#clients-gallery");
  if (!host) return;
  let dragId = null;
  host.addEventListener("dragstart", (e) => {
    const card = e.target.closest?.(".cl-card");
    if (!card) return;
    dragId = card.dataset.id;
    card.classList.add("dragging");
    $("#clients-board")?.classList.add("is-dragging");
    if (e.dataTransfer){ e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); }
  });
  host.addEventListener("dragend", (e) => {
    e.target.closest?.(".cl-card")?.classList.remove("dragging");
    $("#clients-board")?.classList.remove("is-dragging");
    $$("#clients-board .onb-col.drag-over").forEach(col => col.classList.remove("drag-over"));
    dragId = null;
  });
  host.addEventListener("dragover", (e) => {
    const col = e.target.closest?.(".onb-col[data-board='clients']");
    if (!col || !dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    $$("#clients-board .onb-col.drag-over").forEach(x => { if (x !== col) x.classList.remove("drag-over"); });
    col.classList.add("drag-over");
  });
  host.addEventListener("dragleave", (e) => {
    const col = e.target.closest?.(".onb-col[data-board='clients']");
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("drag-over");
  });
  host.addEventListener("drop", async (e) => {
    const col = e.target.closest?.(".onb-col[data-board='clients']");
    if (!col || !dragId) return;
    e.preventDefault();
    col.classList.remove("drag-over");
    const c = state.clients.find(x => x.id === dragId);
    dragId = null;
    if (c) await moveClientStage(c, col.dataset.stage);
  });
  host.addEventListener("keydown", (e) => {
    const card = e.target.closest?.(".cl-card");
    if (card && e.target === card && (e.key === "Enter" || e.key === " ")){ e.preventDefault(); card.click(); }
  });
}
// What a client pays us each month, from the retainer deal they came from.
function clientRetainer(c){
  const deal = c.source_deal_id ? state.deals.find(d => d.id === c.source_deal_id) : null;
  return deal && (deal.contract_type || "retainer") === "retainer" && Number(deal.value) > 0 ? Number(deal.value) : null;
}
// The one progress measure that matters for where the client is right now:
// onboarding steps while onboarding, quotes while on the guarantee, and
// profile completeness otherwise.
function clientProgress(c){
  const stage = c.stage || "onboarding";
  if (stage === "onboarding"){
    const ls = launchState(c);
    return { pct: ls.pct, label: `${ls.stage.label} · ${ls.doneTasks}/${ls.total}` };
  }
  if (stage === "quote_guarantee" && c.quote_target){
    const sent = Number(c.quotes_sent||0);
    return { pct: Math.min(100, Math.round(sent/c.quote_target*100)), label: `${sent}/${c.quote_target} quotes` };
  }
  const p = clientProfileCompleteness(c);
  return { pct: p.pct, label: `${p.pct}% profile` };
}
// Low/Medium/High is set by hand - deliberately separate from the At Risk
// stage, which only reflects a decision already made, not an early signal.
function churnRiskPillHtml(c){
  const label = c.churn_risk ? c.churn_risk.charAt(0).toUpperCase() + c.churn_risk.slice(1) : "Not set";
  return `<span class="cl-risk ${c.churn_risk||"none"}"><span class="cl-risk-dot"></span>${label}</span>`;
}
// Deleting a client never touches their ad creatives. A client with no
// creatives is deleted outright; one with creatives is archived instead -
// gone from every list in the CRM, while the Creative Library keeps showing
// their creatives under their name. Archiving also clears the report email
// and ad account so scheduled reports and ad syncing stop for them.
async function deleteClientKeepingCreatives(c){
  const hasCreatives = state.adCreatives.some(a => a.client_id === c.id);
  let deleted = false;
  if (!hasCreatives){
    if (!IS_CONFIGURED) deleted = true;
    else {
      const { data, error } = await supabase.from("clients").delete().eq("id", c.id).select("id");
      deleted = !error && !!data?.length;
    }
  }
  if (!deleted){
    const now = new Date().toISOString();
    const progress = { ...(c.onboarding_progress || {}), archived_at: now, archived_from: c.stage || "onboarding",
      ...(c.report_email ? { archived_report_email: c.report_email } : {}), ...(c.meta_ad_account_id ? { archived_ad_account: c.meta_ad_account_id } : {}) };
    const patch = { stage: ARCHIVED_STAGE, stage_changed_at: now, updated_at: now, onboarding_progress: progress };
    if (c.report_email) patch.report_email = null;
    if (c.meta_ad_account_id) patch.meta_ad_account_id = null;
    if (IS_CONFIGURED){
      const { error } = await supabase.from("clients").update(patch).eq("id", c.id);
      if (error){ alert(`Couldn't delete ${c.name}. Nothing was changed.\n\n${error.message}`); return false; }
    }
    (state.archivedClients = state.archivedClients || []).push({ ...c, ...patch });
  }
  state.clients = state.clients.filter(x => x.id !== c.id);
  if (deleted) state.archivedClients = (state.archivedClients || []).filter(x => x.id !== c.id);
  else dropArchivedClientData();
  if (deleted){
    const keep = (x) => x.client_id !== c.id;
    state.clientContent = state.clientContent.filter(keep);
    state.campaigns = state.campaigns.filter(keep);
    state.clientReports = (state.clientReports || []).filter(keep);
    state.clientLeads = (state.clientLeads || []).filter(keep);
  }
  if (state.selectedClientId === c.id) state.selectedClientId = null;
  if (state.onbOpenId === c.id){ state.onbOpenId = null; closeModal("onb-modal"); }
  renderAll();
  return true;
}
const DELETE_CLIENT_CONFIRM = (name) => `Delete ${name}? They'll be removed from the CRM. Their ad creatives stay in the Creative Library.`;
function renderClientRow(c, alerts){
  const initial = (c.name||"?").trim().charAt(0).toUpperCase();
  const prog = clientProgress(c);
  const live = runningCampaignsFor(c.id).length;
  const days = c.stage_changed_at ? daysSince(c.stage_changed_at) : null;
  const open = `data-action="view-client" data-id="${c.id}"`;
  return `
    <div class="cl-row">
      <div class="cl-cell-client" ${open}>
        <span class="cl-avatar">${escapeHtml(initial)}</span>
        <div class="cl-name-wrap">
          <div class="cl-name">${escapeHtml(c.name)}</div>
          ${alerts.length
            ? `<div class="cl-alerts">${alerts.map(a => `<span class="cl-alert ${a.type==='danger'?'danger':''}">${escapeHtml(a.text)}</span>`).join("")}</div>`
            : `<div class="cl-sub">${[clientRetainer(c) != null ? `${fmtMoney(clientRetainer(c))}/mo` : "", days != null ? `${days}d in stage` : ""].filter(Boolean).join(" · ") || "&nbsp;"}</div>`}
        </div>
      </div>
      <div class="cl-cell-progress" ${open} title="${escapeHtml(prog.label)}">
        <div class="cl-bar"><div class="cl-bar-fill ${prog.pct===100?"done":""}" style="width:${prog.pct}%"></div></div>
        <span>${escapeHtml(prog.label)}</span>
      </div>
      <div class="num" ${open} data-label="CPL">${c.cost_per_lead!=null ? fmtMoney(c.cost_per_lead) : '<span class="cl-muted">-</span>'}</div>
      <div class="num" ${open} data-label="Ad spend">${c.monthly_ad_spend!=null ? fmtMoney(c.monthly_ad_spend) : '<span class="cl-muted">-</span>'}</div>
      <div class="num" ${open} data-label="Live">${live || '<span class="cl-muted">0</span>'}</div>
      <div ${open} data-label="Churn">${churnRiskPillHtml(c)}</div>
      <div class="cl-cell-stage">
        <select class="filter-select client-stage-select" data-id="${c.id}" aria-label="Stage for ${escapeHtml(c.name)}">
          ${CLIENT_STAGES.map(s => `<option value="${s.key}" ${s.key===(c.stage||"onboarding")?"selected":""}>${s.label}</option>`).join("")}
        </select>
        <button type="button" class="icon-btn cl-row-delete" data-action="delete-client-row" data-id="${c.id}" title="Delete ${escapeHtml(c.name)}" aria-label="Delete ${escapeHtml(c.name)}">${ICONS.trash}</button>
      </div>
    </div>`;
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
          <div class="client-info-label">${escapeHtml(f.label)}${f.optional ? `<span class="client-info-optional">Optional</span>` : ""}</div>
          ${hasValue
            ? `<div class="client-info-value">${display}</div>`
            : f.optional
              ? `<button type="button" class="client-info-value client-info-empty optional" data-action="edit-client-info">None - leave blank for ad-hoc clients</button>`
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
  renderClientOnboarding(c);
  const stageInfo = CLIENT_STAGE_MAP[c.stage] || CLIENT_STAGES[0];
  const stageBadge = $("#client-detail-stage-badge");
  stageBadge.textContent = stageInfo.label;
  stageBadge.className = `badge ${stageInfo.cls}`;
  const contactEl = $("#client-detail-contact");
  if (contactEl){
    const bits = [];
    if (c.phone) bits.push(`<a class="phone-num" href="tel:${escapeHtml(c.phone.replace(/[^0-9+]/g,""))}">${escapeHtml(formatPhone(c.phone))}</a>`);
    if (c.email) bits.push(`<a href="mailto:${escapeHtml(c.email)}">${escapeHtml(c.email)}</a>`);
    if (c.website){
      const href = /^https?:\/\//i.test(c.website) ? c.website : "https://" + c.website;
      bits.push(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(c.website)}</a>`);
    }
    contactEl.innerHTML = bits.join(`<span class="cl-dot-sep">·</span>`);
  }
  const avatarEl = $("#client-detail-avatar");
  if (avatarEl) avatarEl.textContent = (c.name||"?").trim().charAt(0).toUpperCase();
  const churnRiskEl = $("#client-detail-churn-risk");
  if (churnRiskEl) churnRiskEl.innerHTML = `<span class="cl-hero-risk-label">Churn risk</span>${churnRiskPillHtml(c)}`;
  const notSet = `<span class="cl-muted">Not set</span>`;
  $("#client-detail-cpl").innerHTML = c.cost_per_lead != null ? fmtMoney(c.cost_per_lead) : notSet;
  const monthlySpendEl = $("#client-detail-monthly-spend");
  if (monthlySpendEl) monthlySpendEl.innerHTML = c.monthly_ad_spend != null ? fmtMoney(c.monthly_ad_spend) : notSet;
  const adStartEl = $("#client-detail-ad-start-date");
  if (adStartEl) adStartEl.innerHTML = c.ad_start_date ? fmtDate(c.ad_start_date) : notSet;
  const notesEl = $("#client-detail-notes");
  notesEl.textContent = c.notes || "No notes yet.";
  notesEl.classList.toggle("empty", !c.notes);
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
  // On the guarantee, the progress bar in the header already tracks quotes.
  quoteButtons?.closest(".cp-stat")?.classList.toggle("hidden", !!isQuoteGuarantee);

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
  const grid = $("#ad-creatives-grid");
  if (grid){
    grid.innerHTML = !creatives.length ? emptyState("No ad creatives tried yet.") : creatives.map(a => {
      const stats = [a.results != null ? `${Number(a.results).toLocaleString()} leads` : "", a.cost_per_result != null ? `${fmtMoney(a.cost_per_result)}/lead` : "", a.spend != null ? `${fmtMoney(a.spend)} spent` : ""].filter(Boolean);
      return `
      <article class="cp-creative" data-id="${a.id}">
        <div class="cp-creative-media">
          ${a.image_url ? `<img src="${escapeHtml(a.image_url)}" alt="" data-action="view-creative-image" data-url="${escapeHtml(a.image_url)}">` : `<span class="cp-creative-empty">${escapeHtml((a.name || "?").trim().charAt(0).toUpperCase())}</span>`}
          <span class="badge ${AD_RESULTS[a.result]?.cls||'gray'}">${AD_RESULTS[a.result]?.label||a.result}</span>
        </div>
        <div class="cp-creative-body">
          <div class="cp-creative-name">${escapeHtml(a.name)}</div>
          <div class="cp-creative-sub">${a.campaign_id ? escapeHtml(campaignName(a.campaign_id)) + " · " : ""}${fmtDate(a.created_at)}</div>
          ${stats.length ? `<div class="cp-creative-stats">${stats.map(x => `<span>${escapeHtml(x)}</span>`).join("")}</div>` : ""}
          <div class="cp-creative-actions">
            ${a.meta_ad_id ? `<button class="icon-btn" data-action="refresh-creative-insights" data-id="${a.id}" title="Refresh live stats">${ICONS.refresh}</button>` : ""}
            <button class="icon-btn" data-action="edit-ad-creative" data-id="${a.id}" title="Edit">${ICONS.edit}</button>
            <button class="icon-btn" data-action="delete-ad-creative" data-id="${a.id}" title="Delete">${ICONS.trash}</button>
          </div>
        </div>
      </article>`;
    }).join("");
  }
  renderClientProfileExtras(c);
}

// The parts of the client profile that pull from other areas: their results
// from the reports, their workshops, and their reports and 90-day plan.
// Quotes and what they cost, from the client's reports: every month's
// latest report adds up to the all-time totals; since the last receipt
// counts the quotes booked in reports after that payment.
function clientQuoteStats(c){
  const reps = monthReportsFor(c.id);
  const byMonth = new Map(); reps.forEach(r => byMonth.set(ymOf(r.period_end), r));
  const months = [...byMonth.values()];
  const quotes = months.reduce((s, r) => s + (toNum(r.metrics.quoteReady) || 0), 0);
  const spend = months.reduce((s, r) => s + (toNum(r.metrics.adSpendMonth) || 0), 0);
  const last = reps[reps.length - 1];
  const lastPaid = (typeof rcRecordsOf === "function" ? rcRecordsOf(c).filter(rcIsPaid).map(rcPaidDay).sort().pop() : null) || null;
  const since = lastPaid ? reps.filter(r => r.period_end > lastPaid).reduce((s, r) => s + (toNum(r.metrics.dBooked) || 0), 0) : null;
  const thisYm = ymOf(localDayStr());
  // All-time quotes and spend the same way Statistics counts them (GHL,
  // reports, the quote counter, imported leads; Meta spend), so the two match.
  const perf = clientPerformance(c);
  const allQuotes = Math.max(quotes, perf.quotes), allSpend = perf.spend || spend;
  return {
    quotes: allQuotes, spend: allSpend, cpq: allQuotes && allSpend ? allSpend / allQuotes : null, missing: perf.missing,
    open: last ? toNum(last.metrics.openQuotesCount) : null,
    month: byMonth.get(thisYm) ? toNum(byMonth.get(thisYm).metrics.quoteReady) || 0 : 0,
    since, lastPaid, hasReports: reps.length > 0 || allQuotes > 0 || allSpend > 0,
  };
}
function renderClientProfileExtras(c){
  const since = c.signed_at || (c.onboarding_progress || {}).signed_at || c.created_at;
  const sinceEl = $("#cp-since");
  if (sinceEl && since){
    const months = Math.max(0, Math.round(daysSince(since) / 30.4));
    sinceEl.textContent = `Client since ${localDateOnly(String(since).slice(0, 10)).toLocaleDateString("en-NZ", { month: "short", year: "numeric" })}${months ? ` · ${months} month${months === 1 ? "" : "s"}` : ""}`;
  }
  const logBtn = $("#cp-log-workshop");
  if (logBtn){ logBtn.dataset.id = c.id; logBtn.hidden = !isWorkshopClient(c); }
  // Results to date, from their latest report.
  const reps = monthReportsFor(c.id), last = reps[reps.length - 1], m = last?.metrics || {};
  const setStat = (id, v, sub) => { const el = $(id); if (el) el.innerHTML = v; const s = $(id + "-sub"); if (s) s.textContent = sub || ""; };
  setStat("#cp-revenue", toNum(m.revenueToDate) != null ? fmtMoney(m.revenueToDate) : `<span class="cl-muted">No reports yet</span>`, toNum(m.revenueMonth) != null ? `${fmtMoney(m.revenueMonth)} in ${monthNameOf(last.period_end)}` : "");
  setStat("#cp-roi", toNum(m.roiToDate) != null ? fmtTimes(toNum(m.roiToDate)) : "-", toNum(m.investedToDate) != null ? `on ${fmtMoney(m.investedToDate)} invested` : "");
  const qs = clientQuoteStats(c), strip = $("#cp-quote-strip");
  if (strip){
    const cell = (k, v, sub) => `<div class="cp-q"><span>${k}</span><b>${v}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
    strip.innerHTML = !qs.hasReports ? `<div class="cp-q-empty">Cost per quote and quote counts show here once their first report is made.</div>` : [
      cell("Cost per quote", qs.cpq != null ? fmtMoney(qs.cpq) : "-", qs.cpq != null ? `${fmtMoney(qs.spend)} ad spend` : qs.missing),
      cell("Quotes this month", qs.month, ""),
      cell("Open quotes", qs.open ?? "-", "waiting on a decision"),
      cell("Since last payment", qs.since ?? "-", qs.lastPaid ? `since ${new Date(qs.lastPaid + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" })}` : "no receipts yet"),
      cell("Quotes all-time", qs.quotes, ""),
    ].join("");
  }

  // Workshops
  const wsEl = $("#cp-workshops");
  if (wsEl){
    if (!isWorkshopClient(c)){ wsEl.hidden = true; }
    else {
      wsEl.hidden = false;
      const logs = workshopsOf(c), next = (c.onboarding_progress || {}).workshop_next, sug = workshopSuggestion(c);
      const thisMonth = doneThisMonth(c);
      const acts = logs.flatMap(w => (w.actions || []).map((a, i) => ({ a, i, w }))).filter(x => !x.a.done);
      const pill = (key) => `<span class="ws-pill ws-pill-${escapeHtml(key)}">${escapeHtml(WORKSHOP_MAP[key]?.label || "Workshop")}</span>`;
      wsEl.innerHTML = `
        <div class="cl-panel-head cp-panel-head">
          <div><h3>Workshops</h3><p>Monthly sessions on their business, with the actions that came out of them.</p></div>
          <div class="cl-panel-actions"><button class="btn ghost sm" data-action="open-workshops-page">Workshop board</button><button class="btn gold sm" data-action="ws-open" data-id="${c.id}">Log workshop</button></div>
        </div>
        <div class="cp-ws-top">
          <div class="cp-ws-next ${WORKSHOP_MAP[next] ? "ws-lib-" + next : "ws-lib-" + sug.cat}">
            <span class="ws-lib-icon">${WORKSHOP_ICONS[WORKSHOP_MAP[next] ? next : sug.cat] || ""}</span>
            <div><span class="cp-k">${WORKSHOP_MAP[next] ? "Lined up next" : "Suggested next"}</span>
              <b>${escapeHtml(WORKSHOP_MAP[WORKSHOP_MAP[next] ? next : sug.cat].label)}</b>
              <small>${WORKSHOP_MAP[next] ? escapeHtml(WORKSHOP_MAP[next].blurb) : escapeHtml(sug.why)}</small></div>
            ${WORKSHOP_MAP[next] ? "" : `<button type="button" class="ws-sug-use" data-action="ws-use-suggestion" data-id="${c.id}" data-cat="${sug.cat}">Line it up</button>`}
          </div>
          <div class="cp-ws-month ${thisMonth ? "done" : ""}"><span class="cp-k">${escapeHtml(monthNameOf(localDayStr()))}</span><b>${thisMonth ? "Done" : "Due"}</b><small>${thisMonth ? `${escapeHtml(WORKSHOP_MAP[thisMonth.category]?.label || "")} · ${escapeHtml(fmtShortDate(thisMonth.date))}` : "No workshop yet this month"}</small></div>
        </div>
        ${acts.length ? `<div class="cp-ws-acts"><h4>Open actions</h4><ul class="ws-actions">${acts.slice(0, 8).map(({ a, i, w }) => `
          <li><button type="button" class="ws-action-hit" data-action="ws-toggle-action" data-id="${c.id}" data-ws="${escapeHtml(w.id)}" data-i="${i}" aria-pressed="false"><span class="task-check">${TASK_CHECK_SVG}</span><span>${escapeHtml(a.text)}</span></button><em>${a.owner === "them" ? "Them" : "Us"}</em></li>`).join("")}</ul></div>` : ""}
        <div class="cp-ws-log">
          ${logs.length ? logs.slice(0, 5).map(w => `
            <div class="cp-ws-item">
              <span class="cp-ws-dot ws-lib-${escapeHtml(w.category)}"></span>
              <div class="cp-ws-item-body">
                <div class="cp-ws-item-head">${pill(w.category)}<b>${escapeHtml(fmtShortDate(w.date))}</b>${ASSIGNEES[w.by] ? `<span class="ws-by">with ${escapeHtml(ASSIGNEES[w.by].label)}</span>` : ""}${(w.actions || []).length ? `<span class="ws-by">· ${(w.actions || []).filter(a => a.done).length}/${w.actions.length} actions done</span>` : ""}<button type="button" class="btn ghost sm ws-pdf-btn" data-action="ws-pdf" data-id="${c.id}" data-ws="${escapeHtml(w.id)}">PDF</button></div>
                ${w.notes ? `<p>${escapeHtml(w.notes)}</p>` : ""}
              </div>
            </div>`).join("") + (logs.length > 5 ? `<button type="button" class="cp-link" data-action="ws-open" data-id="${c.id}">See all ${logs.length} workshops</button>` : "")
          : `<p class="ws-none">No workshops yet. Log their first one after the session.</p>`}
        </div>`;
    }
  }

  // Reports and 90-day plan
  const repEl = $("#cp-reports");
  if (repEl){
    const due = reportDueInfo(c), plan = planInfo(c);
    repEl.innerHTML = `
      <div class="cl-panel-head cp-panel-head"><div><h3>${PLANS_ENABLED ? "Reports & plans" : "Reports"}</h3><p>What they've been sent.</p></div></div>
      <div class="cp-docs">
        <div class="cp-doc">
          <span class="cp-doc-ico">PDF</span>
          <div><b>Performance report</b><small>${last ? `Report ${escapeHtml(String(m.report_number || reps.length))} · ${escapeHtml(fmtReportPeriod(last.period_start, last.period_end))}` : "None sent yet"}</small>
            <span class="onb-status ${due.due ? "client" : "track"}">${escapeHtml(due.label)}</span></div>
          <button type="button" class="btn ${due.due ? "gold" : "ghost"} sm" data-action="make-report" data-id="${c.id}">Make</button>
        </div>
        ${PLANS_ENABLED ? `<div class="cp-doc">
          <span class="cp-doc-ico">90</span>
          <div><b>90-day plan</b><small>${plan.cur ? `Plan ${plan.cur.number || 1} · ${escapeHtml(planRange(plan.cur.start))}` : "Make their first one"}</small>
            <span class="onb-status ${plan.cls}">${escapeHtml(plan.label)}</span></div>
          <button type="button" class="btn ${plan.due ? "gold" : "ghost"} sm" data-action="make-plan" data-id="${c.id}">Make</button>
        </div>` : ""}
      </div>`;
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

/* ───────── Welcome pack (pops up when a client moves into Onboarding) ─────────
   Draws the client's details onto the branded template
   (assets/welcome-pack-template.pdf) at the spots and styles listed in
   assets/welcome-pack-layout.json, so the PDF that goes out is plain,
   finished text - no fill-in boxes and no viewer highlighting. Everything
   happens in the browser; nothing is uploaded. pdf-lib + fontkit are bundled in
   assets/vendor and load only the first time a pack is made. */
const WP_FIELDS = ["client_first_name","business_name","call_when","ads_live","why_excited","account_manager","phone","email"];
// Trades get the quotes-and-jobs wording; everyone else gets the professional services version.
function wpKindFor(c){
  const ind = (typeof clientIndustry === "function" ? clientIndustry(c).name : "") || "";
  if (!ind) return "trades";
  return HOME_SERVICES_INDUSTRIES.includes(ind) ? "trades" : "pro";
}
const WP_LIBS = [
  "assets/vendor/pdf-lib-1.17.1.min.js",
  "assets/vendor/fontkit-1.1.1.umd.min.js",
];
let wpLibsReady = null, wpLastUrl = null, wpLastName = "";
function wpLoadLibs(){
  if (window.PDFLib && window.fontkit) return Promise.resolve();
  if (wpLibsReady) return wpLibsReady;
  wpLibsReady = WP_LIBS.reduce((p, url) => p.then(() => new Promise((resolve, reject) => {
    const s = document.createElement("script"); s.src = url; s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load the PDF tools - refresh the page and try again."));
    document.head.appendChild(s);
  })), Promise.resolve()).catch(e => { wpLibsReady = null; throw e; });
  return wpLibsReady;
}
const wpAmKey = (person) => `mp_welcome_am_${person || "me"}`;
// Best-effort prefill from what the CRM already knows about this client.
function wpPrefill(c){
  const person = window.getActivePerson ? window.getActivePerson() : null;
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(wpAmKey(person)) || "{}"); } catch(e){}
  const bizKey = (c.name || "").trim().toLowerCase();
  // The deal that created this client, or failing that any deal that names the business.
  const deal = (c.source_deal_id && state.deals.find(d => d.id === c.source_deal_id))
    || (bizKey && state.deals.find(d => [d.contact_name, d.title].some(t => (t || "").toLowerCase().includes(bizKey))))
    || null;
  const contact = deal?.contact_id ? state.contacts.find(x => x.id === deal.contact_id) : null;
  const personName = (contact?.name || (deal?.contact_name || "").split(" - ")[0] || "").trim();
  const ads = c.ad_start_date ? new Date(c.ad_start_date + "T00:00:00").toLocaleDateString("en-NZ", { day:"numeric", month:"long" }) : "";
  return {
    client_first_name: personName.split(/\s+/)[0] || "",
    business_name: c.name || "",
    call_when: "",
    ads_live: ads,
    why_excited: "",
    account_manager: saved.account_manager || ASSIGNEES[person]?.label || "",
    phone: saved.phone || "",
    email: saved.email || state.user?.email || "",
  };
}
// A deal dragged into the sales pipeline's Onboarding column: use its client
// if one exists yet, otherwise prefill straight from the deal.
function openWelcomePackForDeal(deal){
  if (!deal) return;
  const client = state.clients.find(c => c.source_deal_id === deal.id);
  if (client) return openWelcomePack(client.id);
  const contact = deal.contact_id ? state.contacts.find(c => c.id === deal.contact_id) : null;
  const fromContactName = (deal.contact_name || "").split(" - ")[1];
  const name = (contact?.company || fromContactName || deal.title || "").trim();
  openWelcomePack(null, { id: "", name, source_deal_id: deal.id, ad_start_date: deal.commission_invoice_date || null });
}
function openWelcomePack(clientId, asClient){
  const c = asClient || state.clients.find(x => x.id === clientId);
  if (!c) return;
  const v = wpPrefill(c);
  $("#wp-client-id").value = c.id;
  WP_FIELDS.forEach(k => { $("#wp-" + k).value = v[k] || ""; });
  const kindSel = $("#wp-kind"); if (kindSel) kindSel.value = c.id || c.name ? wpKindFor(c) : "trades";
  $("#wp-sub").textContent = `${c.name} is onboarding. Check the details, then we'll make the finished PDF.`;
  $("#welcome-pack-form").hidden = false;
  $("#wp-done").hidden = true;
  wpStatus("");
  openModal("welcome-pack-modal");
  setTimeout(() => $(WP_FIELDS.map(k => "#wp-" + k).find(sel => !$(sel).value) || "#wp-why_excited")?.focus(), 50);
}
function wpStatus(msg, warn){ const el = $("#wp-status"); if (el){ el.textContent = msg; el.classList.toggle("warn", !!warn); } }
// Drawn in code (js/welcome-pdf.js) so the personal note can be any length
// and the wording matches trades or professional services.
async function buildWelcomePackPdf(values){
  await wpLoadLibs();
  if (!window.MPWelcomePDF || !window.MPReportPDF) throw new Error("Couldn't load the welcome pack - refresh the page and try again.");
  return window.MPWelcomePDF.build(values);
}
function wpFileName(business){
  const safe = (business || "Client").replace(/[\\/:*?"<>|]+/g, "").trim() || "Client";
  return `Mr Priceless Welcome Pack - ${safe}.pdf`;
}
function setupWelcomePack(){
  $("#welcome-pack-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const values = Object.fromEntries(WP_FIELDS.map(k => [k, $("#wp-" + k).value]));
    values.kind = $("#wp-kind")?.value || "trades";
    const missing = WP_FIELDS.filter(k => !values[k].trim());
    const btn = $("#wp-create");
    if (missing.length && btn.dataset.confirm !== "1"){
      btn.dataset.confirm = "1";
      const labels = missing.map(k => $(`label[for="wp-${k}"]`)?.childNodes[0]?.textContent.trim() || k);
      wpStatus(`Still blank: ${labels.join(", ")}. Press Create again to leave them out.`, true);
      return;
    }
    btn.dataset.confirm = "";
    const person = window.getActivePerson ? window.getActivePerson() : null;
    try { localStorage.setItem(wpAmKey(person), JSON.stringify({ account_manager: values.account_manager, phone: values.phone, email: values.email })); } catch(err){}
    btn.disabled = true; wpStatus("Making the PDF...");
    try {
      const bytes = await buildWelcomePackPdf(values);
      if (wpLastUrl) URL.revokeObjectURL(wpLastUrl);
      wpLastUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      wpLastName = wpFileName(values.business_name);
      const packClient = state.clients.find(x => x.id === $("#wp-client-id").value);
      // Ticks their Welcome milestone, and remembers the first name for chase-up messages.
      if (packClient) saveLaunchProgress(packClient, { wp_sent: true, ...(values.client_first_name.trim() ? { contact_first: values.client_first_name.trim() } : {}) });
      const link = $("#wp-file");
      link.href = wpLastUrl; link.download = wpLastName;
      $("#wp-file-name").textContent = wpLastName;
      $("#welcome-pack-form").hidden = true;
      $("#wp-done").hidden = false;
      link.click(); // saves a copy to Downloads straight away
    } catch(err){
      wpStatus(err.message || "Something went wrong making the PDF.", true);
    } finally {
      btn.disabled = false;
    }
  });
  $$("#welcome-pack-form input, #welcome-pack-form textarea").forEach(el => el.addEventListener("input", () => { $("#wp-create").dataset.confirm = ""; wpStatus(""); }));
  // Dragging the file card out drops the real PDF into an email or onto the desktop (Chrome / Edge).
  $("#wp-file")?.addEventListener("dragstart", (e) => {
    if (!wpLastUrl) return;
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("DownloadURL", `application/pdf:${wpLastName}:${wpLastUrl}`);
  });
  // The company introduction goes out with every welcome pack - same drag, fixed file.
  $("#wp-intro-file")?.addEventListener("dragstart", (e) => {
    const link = e.currentTarget;
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("DownloadURL", `application/pdf:${link.getAttribute("download")}:${new URL(link.getAttribute("href"), location.href).href}`);
  });
  $("#wp-edit")?.addEventListener("click", () => { $("#wp-done").hidden = true; $("#welcome-pack-form").hidden = false; });
  $("#wp-preview")?.addEventListener("click", () => { if (wpLastUrl) window.open(wpLastUrl, "_blank"); });
}

/* ───────── Onboarding: Welcome → Kickoff Call → Ads Due → Live ─────────
   Every client in the Onboarding stage sits in one of four stages on a
   drag-and-drop board. The stage is set by dragging (saved as onb_stage in
   client.onboarding_progress); until a client has been dragged, it's worked
   out from their ticked tasks. Each stage has a short task list - keys reuse
   the old checklist's where the meaning is the same, so earlier ticks carry
   over. Tasks marked who:"client" are the ones we can't do without them:
   they drive "Waiting on client" and the chase-up message. */
const LAUNCH_ESSENTIALS = [
  { key: "good_lead_1", label: "A job they're happy to quote", placeholder: "e.g. Kitchen and bathroom renos over $15k" },
  { key: "good_lead_3", label: "Average job value", placeholder: "e.g. $18,000" },
  { key: "good_lead_5", label: "How far they'll travel", placeholder: "e.g. 40 minutes from Mt Maunganui" },
  { key: "good_lead_6", label: "After hours or weekend quotes", placeholder: "e.g. Saturday mornings only" },
];
const LAUNCH_MILESTONES = [
  { key: "welcome", label: "Welcome", blurb: "Pack out, logins sent", tasks: [
    { key: "wp_sent", label: "Welcome pack sent", hint: "Ticks itself when you make their pack." },
    { key: "crm_login", label: "CRM login sent and working" },
  ]},
  { key: "kickoff", label: "Kickoff Call", blurb: "Learn the business", tasks: [
    { key: "kickoff_booked", label: "Kickoff call booked", dateField: "kickoff_at" },
    { key: "honest_expect_1", label: "Honest expectations set (paid leads, month one)" },
    { key: "essentials", label: "Lead essentials captured", derived: "essentials", hint: "Fill in the four lead essentials." },
  ]},
  { key: "ads_due", label: "Ads Due", blurb: "Access in, ads built", tasks: [
    { key: "meta_partner_access", label: "Partner access to their Meta ad account", who: "client", ask: "Partner access to your Meta ad account" },
    { key: "fb_page_access", label: "Facebook Page access (content, ads, leads)", who: "client", ask: "Access to your Facebook Page (content, ads and leads)" },
    { key: "cal_share_max", label: "Calendar shared and synced with GHL", who: "client", ask: "Your calendar shared with us, with your busy times blocked out" },
    { key: "photos_in", label: "Job photos and a team photo received", who: "client", ask: "Some before and after job photos, plus a photo of you and the team" },
    { key: "meta_ad_account_id", label: "Ad account ID added to their client page", derived: "meta_ad_account_id", hint: "Add it on their client page." },
    { key: "ghl_template", label: "GHL pipeline and calendar set up" },
    { key: "fb_lead_form", label: "Lead form built and connected to GHL" },
    { key: "launch_creatives", label: "2 proven creatives and 1 test loaded" },
  ]},
  { key: "live", label: "Live", blurb: "Ads running", tasks: [
    { key: "ad_start_date", label: "Ads switched on", derived: "ad_start_date", hint: "Set when they're dropped into Live." },
    { key: "cadence_catchup", label: "Fortnightly catch-up locked in" },
  ]},
];
const ONB_STAGE_KEYS = LAUNCH_MILESTONES.map(m => m.key);
const LAUNCH_TASKS = LAUNCH_MILESTONES.flatMap(m => m.tasks.map(t => ({ ...t, milestone: m.key })));
const ONB_STALL_DAYS = 5;
const isOnboardingClient = (c) => (c.stage || "onboarding") === "onboarding";

function launchEssentialsDone(c){
  const p = c.onboarding_progress || {};
  return LAUNCH_ESSENTIALS.every(e => String(p[e.key + ONBOARDING_ANSWER_SUFFIX] || "").trim());
}
function launchTaskDone(c, t){
  if (t.derived === "essentials") return launchEssentialsDone(c);
  if (t.derived) return Boolean(c[t.derived]);
  return Boolean((c.onboarding_progress || {})[t.key]);
}
function localDateOnly(s){ return s ? new Date(String(s).slice(0,10) + "T00:00:00") : null; }
function daysBetween(a, b){ return Math.round((b - a) / 86400e3); }
// Which column a client sits in: wherever they were last dragged, otherwise
// worked out from what's been ticked.
function onbStageIndex(c){
  const set = ONB_STAGE_KEYS.indexOf((c.onboarding_progress || {}).onb_stage);
  if (set > -1) return set;
  if (c.ad_start_date) return 3;
  const firstOpen = LAUNCH_MILESTONES.slice(0, 2).findIndex(m => m.tasks.some(t => !launchTaskDone(c, t)));
  return firstOpen === -1 ? 2 : firstOpen;
}
// Everything the board, the card and the client page need to know about one launch.
function launchState(c){
  const p = c.onboarding_progress || {};
  const milestones = LAUNCH_MILESTONES.map(m => {
    const done = m.tasks.filter(t => launchTaskDone(c, t)).length;
    return { ...m, done, total: m.tasks.length, complete: done === m.tasks.length };
  });
  const doneTasks = milestones.reduce((s, m) => s + m.done, 0);
  const total = LAUNCH_TASKS.length;
  const current = onbStageIndex(c);
  const launched = current === ONB_STAGE_KEYS.length - 1;
  // What's still open up to and including this stage, earliest first.
  const open = milestones.slice(0, current + 1).flatMap(m => m.tasks.filter(t => !launchTaskDone(c, t)));
  const nextTask = open.find(t => t.who !== "client") || open[0] || null;
  const stageOpen = milestones[current].tasks.filter(t => !launchTaskDone(c, t));
  const waitingOnClient = !launched && stageOpen.length > 0 && stageOpen.every(t => t.who === "client");
  const clientAsks = LAUNCH_TASKS.filter(t => t.who === "client" && !launchTaskDone(c, t));
  const signed = p.signed_at || c.stage_changed_at || c.created_at;
  const daysIn = signed ? Math.max(0, daysSince(signed)) : 0;
  const today = localDateOnly(localDayStr());
  const target = localDateOnly(p.target_live);
  const daysToTarget = target ? daysBetween(today, target) : null;
  const sinceTouch = p.touched_at ? daysSince(p.touched_at) : daysIn;
  let status = { key: "track", label: "On track" };
  if (launched) status = { key: "ready", label: "Ads live" };
  else if (daysToTarget != null && daysToTarget < 0) status = { key: "late", label: `Ads ${-daysToTarget}d overdue` };
  else if (waitingOnClient) status = { key: "client", label: "Waiting on client" };
  else if (sinceTouch >= ONB_STALL_DAYS) status = { key: "stalled", label: `Quiet for ${sinceTouch}d` };
  else if (daysToTarget != null && daysToTarget <= 2) status = { key: "soon", label: daysToTarget === 0 ? "Ads due today" : `Ads due in ${daysToTarget}d` };
  const deal = c.source_deal_id ? state.deals.find(d => d.id === c.source_deal_id) : null;
  const owner = p.owner || deal?.assignee || null;
  const stage = milestones[current];
  return { milestones, stage, doneTasks, total, pct: Math.round(doneTasks / total * 100), current, launched, nextTask, waitingOnClient, clientAsks, daysIn, target: p.target_live || "", daysToTarget, status, owner, deal };
}
function ownerChipHtml(owner, compact){
  const a = owner && ASSIGNEES[owner];
  if (!a) return compact ? "" : `<span class="onb-owner none">No owner</span>`;
  return compact
    ? `<span class="onb-owner-dot ${a.cls}" title="${escapeHtml(a.label)}">${escapeHtml(a.label[0])}</span>`
    : `<span class="onb-owner"><span class="onb-owner-dot ${a.cls}">${escapeHtml(a.label[0])}</span>${escapeHtml(a.label)}</span>`;
}
function fmtShortDate(s){
  const d = localDateOnly(s);
  return d ? d.toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "";
}
async function saveLaunchProgress(c, patch, extra){
  const progress = { ...(c.onboarding_progress || {}), ...patch, touched_at: new Date().toISOString() };
  Object.keys(patch).forEach(k => { if (patch[k] === null) delete progress[k]; });
  c.onboarding_progress = progress;
  await DataLayer.update("clients", c.id, { onboarding_progress: progress, ...(extra || {}) });
}
// Moves a client to another onboarding stage. Landing in Live means the ads
// are running, so it sets the ads start date if there isn't one yet.
async function moveOnbStage(c, stageKey){
  if (!ONB_STAGE_KEYS.includes(stageKey) || launchState(c).stage.key === stageKey) return;
  const extra = stageKey === "live" && !c.ad_start_date ? { ad_start_date: localDayStr() } : null;
  await saveLaunchProgress(c, { onb_stage: stageKey }, extra);
  if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
}
// The step after onboarding: the quote guarantee if they're on one, otherwise Month 1.
function postOnboardingStage(c){ return c.quote_target ? "quote_guarantee" : "live"; }
async function finishOnboarding(c){
  const next = postOnboardingStage(c);
  if (!confirm(`Finish onboarding for ${c.name} and move them to ${CLIENT_STAGE_MAP[next].label}?${c.ad_start_date ? "" : " Their ads start date will be set to today."}`)) return;
  const now = new Date().toISOString();
  const patch = { stage: next, stage_changed_at: now, updated_at: now };
  if (!c.ad_start_date) patch.ad_start_date = localDayStr();
  patch.onboarding_progress = { ...(c.onboarding_progress || {}), onb_stage: "live", live_at: (c.onboarding_progress || {}).live_at || now, touched_at: now };
  if (state.onbOpenId === c.id){ state.onbOpenId = null; closeModal("onb-modal"); }
  await DataLayer.update("clients", c.id, patch);
  if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
}
function clientAsksMessage(c, ls){
  const p = c.onboarding_progress || {};
  const first = (p.contact_first || (ls.deal?.contact_name || "").split(" - ")[0].trim().split(/\s+/)[0] || "").trim() || "there";
  const lines = ls.clientAsks.map(t => `- ${t.ask || t.label}`);
  return `Hi ${first}, to get your ads live we just need a few things from you:\n${lines.join("\n")}\nOnce these are sorted we can get you up and running. Cheers!`;
}

/* The board */
function renderOnboarding(){
  const board = $("#onb-board");
  if (!board) return;
  const clients = state.clients.filter(isOnboardingClient);
  const states = new Map(clients.map(c => [c.id, launchState(c)]));
  const navCount = $("#nav-onb-count");
  if (navCount){ navCount.hidden = !clients.length; navCount.textContent = clients.length; }
  // Average days from signing to ads live, over every client that got there.
  const launchedDurations = state.clients.map(c => {
    const p = c.onboarding_progress || {};
    const start = p.signed_at || c.created_at;
    const end = p.live_at || (c.ad_start_date && p.signed_at ? c.ad_start_date + "T12:00:00" : null);
    return start && end ? daysBetween(new Date(start), new Date(end)) : null;
  }).filter(v => v != null && v >= 0);
  const avgLaunch = launchedDurations.length ? Math.round(launchedDurations.reduce((a,b) => a+b, 0) / launchedDurations.length) : null;
  const waiting = clients.filter(c => states.get(c.id).waitingOnClient).length;
  const behind = clients.filter(c => ["late", "stalled"].includes(states.get(c.id).status.key)).length;
  const live = clients.filter(c => states.get(c.id).launched).length;
  const kpis = $("#onb-kpis");
  if (kpis) kpis.innerHTML = `
    <div class="onb-kpi"><span class="onb-kpi-label">Onboarding</span><span class="onb-kpi-value">${clients.length}</span><span class="onb-kpi-sub">${live ? `${live} with ads live` : "clients being set up"}</span></div>
    <div class="onb-kpi"><span class="onb-kpi-label">Signed to live</span><span class="onb-kpi-value">${avgLaunch != null ? `${avgLaunch}<small> days</small>` : "-"}</span><span class="onb-kpi-sub">${avgLaunch != null ? `average of ${launchedDurations.length}` : "shows once ads go live"}</span></div>
    <div class="onb-kpi ${waiting ? "warn" : ""}"><span class="onb-kpi-label">Waiting on client</span><span class="onb-kpi-value">${waiting}</span><span class="onb-kpi-sub">${waiting ? "chase these up" : "nothing to chase"}</span></div>
    <div class="onb-kpi ${behind ? "bad" : ""}"><span class="onb-kpi-label">Behind</span><span class="onb-kpi-value">${behind}</span><span class="onb-kpi-sub">${behind ? "overdue or gone quiet" : "all moving"}</span></div>`;

  const order = (a, b) => {
    const rank = (c) => ({ late: 0, stalled: 1, soon: 2, client: 3 })[states.get(c.id).status.key] ?? 4;
    return rank(a) - rank(b) || states.get(b.id).daysIn - states.get(a.id).daysIn;
  };
  board.innerHTML = LAUNCH_MILESTONES.map((m, i) => {
    const col = clients.filter(c => states.get(c.id).current === i).sort(order);
    return `
      <section class="onb-col" data-stage="${m.key}" aria-label="${escapeHtml(m.label)}">
        <header class="onb-col-head">
          <span class="onb-col-num">${i + 1}</span>
          <div><div class="onb-col-title">${escapeHtml(m.label)}</div><div class="onb-col-blurb">${escapeHtml(m.blurb)}</div></div>
          <span class="onb-col-count">${col.length}</span>
        </header>
        <div class="onb-col-body">
          ${boardColumnCards("onb", m.key, col.map(c => onbCardHtml(c, states.get(c.id))))}
          <div class="onb-drop-hint">${col.length ? "Drop here" : (clients.length ? "Drag a client here" : "Nobody here yet")}</div>
        </div>
      </section>`;
  }).join("");
  $("#onb-empty")?.toggleAttribute("hidden", clients.length > 0);
  if (state.onbOpenId) renderOnbModal();
}
function onbCardHtml(c, ls){
  const m = ls.stage;
  const pct = Math.round(m.done / m.total * 100);
  const showStatus = ls.status.key !== "track";
  const footer = ls.launched
    ? `<button type="button" class="onb-finish" data-action="onb-finish" data-id="${c.id}">Finish onboarding →</button>`
    : ls.nextTask ? `<div class="onb-next" title="${escapeHtml(ls.nextTask.label)}">${ls.nextTask.who === "client" ? `<em>Client</em>` : ""}${escapeHtml(ls.nextTask.label)}</div>` : `<div class="onb-next done">Stage done - drag on</div>`;
  return `
    <article class="onb-card status-${ls.status.key}" draggable="true" data-action="onb-open" data-id="${c.id}" tabindex="0" aria-label="${escapeHtml(c.name)}, ${escapeHtml(m.label)}">
      <div class="onb-card-top">
        <span class="onb-card-avatar">${escapeHtml((c.name || "?").trim().charAt(0).toUpperCase())}</span>
        <div class="onb-card-id">
          <div class="onb-card-name">${escapeHtml(c.name)}</div>
          <div class="onb-card-meta">Day ${ls.daysIn}${ls.target ? ` · ads ${escapeHtml(fmtShortDate(ls.target))}` : ""}</div>
        </div>
        ${ownerChipHtml(ls.owner, true)}
      </div>
      ${showStatus ? `<span class="onb-status ${ls.status.key}">${escapeHtml(ls.status.label)}</span>` : ""}
      <div class="onb-card-progress">
        <div class="onb-bar"><span style="width:${pct}%"></span></div>
        <span class="onb-bar-label">${m.done}/${m.total}</span>
      </div>
      ${footer}
    </article>`;
}

/* Dragging cards between stages */
function setupOnbDrag(){
  const board = $("#onb-board");
  if (!board) return;
  let dragId = null;
  board.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".onb-card");
    if (!card) return;
    dragId = card.dataset.id;
    card.classList.add("dragging");
    board.classList.add("is-dragging");
    if (e.dataTransfer){ e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); }
  });
  board.addEventListener("dragend", (e) => {
    e.target.closest?.(".onb-card")?.classList.remove("dragging");
    board.classList.remove("is-dragging");
    $$(".onb-col.drag-over").forEach(col => col.classList.remove("drag-over"));
    dragId = null;
  });
  board.addEventListener("dragover", (e) => {
    const col = e.target.closest(".onb-col");
    if (!col || !dragId) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    $$(".onb-col.drag-over").forEach(x => { if (x !== col) x.classList.remove("drag-over"); });
    col.classList.add("drag-over");
  });
  board.addEventListener("dragleave", (e) => {
    const col = e.target.closest(".onb-col");
    if (col && !col.contains(e.relatedTarget)) col.classList.remove("drag-over");
  });
  board.addEventListener("drop", async (e) => {
    const col = e.target.closest(".onb-col");
    if (!col || !dragId) return;
    e.preventDefault();
    col.classList.remove("drag-over");
    const c = state.clients.find(x => x.id === dragId);
    dragId = null;
    if (c) await moveOnbStage(c, col.dataset.stage);
  });
}

/* The client's launch, opened from a card */
function openOnbModal(id){
  state.onbOpenId = id;
  renderOnbModal();
  openModal("onb-modal");
}
function renderOnbModal(){
  const body = $("#onb-modal-body");
  const c = state.clients.find(x => x.id === state.onbOpenId);
  if (!body) return;
  if (!c || !isOnboardingClient(c)){ state.onbOpenId = null; closeModal("onb-modal"); return; }
  const ls = launchState(c);
  const p = c.onboarding_progress || {};
  // A realtime re-render mustn't throw away what someone is typing.
  const active = document.activeElement;
  const keep = active && body.contains(active) && active.dataset.onbField ? { field: active.dataset.onbField, value: active.value, s: active.selectionStart, e: active.selectionEnd } : null;
  const openSections = new Set([...body.querySelectorAll("details.onb-group[open]")].map(d => d.dataset.stage));
  const firstRender = body.dataset.client !== c.id;
  body.dataset.client = c.id;

  $("#onb-modal-title").textContent = c.name;
  $("#onb-modal-sub").innerHTML = `Signed ${ls.daysIn === 0 ? "today" : `${ls.daysIn} day${ls.daysIn === 1 ? "" : "s"} ago`}<span class="onb-status ${ls.status.key}">${escapeHtml(ls.status.label)}</span>`;
  const taskRow = (t) => {
    const done = launchTaskDone(c, t);
    const tag = t.who === "client" ? `<span class="onb-tag">Client</span>` : "";
    const dateInput = t.dateField ? `<input type="datetime-local" class="onb-inline-date" data-onb-field="${t.dateField}" value="${escapeHtml(p[t.dateField] || "")}" aria-label="Kickoff call time">` : "";
    const hint = t.hint && !done ? `<span class="onb-task-hint">${escapeHtml(t.hint)}</span>` : "";
    // Derived tasks tick themselves from the client's data, so they aren't buttons.
    const inner = `<span class="task-check ${done ? "done" : ""}">${TASK_CHECK_SVG}</span><span class="onb-task-text">${escapeHtml(t.label)}${tag}${hint}</span>`;
    return `
      <div class="onb-task ${done ? "done" : ""} ${t.derived ? "auto" : ""}">
        ${t.derived ? `<span class="onb-task-hit">${inner}</span>` : `<button type="button" class="onb-task-hit" data-action="onb-toggle" data-id="${c.id}" data-task="${t.key}" aria-pressed="${done}">${inner}</button>`}
        ${dateInput}
      </div>`;
  };
  const asks = ls.clientAsks;
  body.innerHTML = `
    <div class="onb-seg" role="group" aria-label="Stage">
      ${ls.milestones.map((m, i) => `<button type="button" class="onb-seg-btn ${i === ls.current ? "active" : ""} ${m.complete ? "past" : ""}" data-action="onb-move" data-id="${c.id}" data-stage="${m.key}" aria-pressed="${i === ls.current}"><span class="onb-seg-num">${m.complete ? TASK_CHECK_SVG : i + 1}</span>${escapeHtml(m.label)}<span class="onb-seg-count">${m.done}/${m.total}</span></button>`).join("")}
    </div>
    <div class="onb-m-grid">
      <div class="onb-m-tasks">
        ${ls.milestones.map((m, i) => {
          const isOpen = firstRender ? i === ls.current : openSections.has(m.key);
          return `
          <details class="onb-group ${i === ls.current ? "current" : ""} ${m.complete ? "complete" : ""}" data-stage="${m.key}" ${isOpen ? "open" : ""}>
            <summary><span class="onb-group-title">${escapeHtml(m.label)}</span>${i === ls.current ? `<span class="onb-here">Here now</span>` : ""}<span class="onb-group-count">${m.done}/${m.total}</span></summary>
            <div class="onb-group-body">${m.tasks.map(taskRow).join("")}</div>
          </details>`;
        }).join("")}
      </div>
      <aside class="onb-m-side">
        <div class="onb-side-card onb-side-plan">
          <label class="onb-m-field"><span>Ads due</span><input type="date" data-onb-field="target_live" value="${escapeHtml(ls.target)}"></label>
          <label class="onb-m-field"><span>Owner</span>
            <select data-onb-field="owner">
              <option value="">No owner</option>
              ${Object.entries(ASSIGNEES).map(([k, a]) => `<option value="${k}" ${ls.owner === k ? "selected" : ""}>${escapeHtml(a.label)}</option>`).join("")}
            </select>
          </label>
          <div class="onb-side-links">
            <button type="button" class="btn ghost sm" data-action="onb-pack" data-id="${c.id}">Welcome pack</button>
            <button type="button" class="btn ghost sm" data-action="onb-client-page" data-id="${c.id}">Client page</button>
          </div>
        </div>
        <div class="onb-side-card ${asks.length ? "asks" : "asks-done"}">
          <h4>Needed from the client</h4>
          ${asks.length
            ? `<ul>${asks.map(t => `<li>${escapeHtml(t.ask || t.label)}</li>`).join("")}</ul>
               <button type="button" class="btn ghost sm" data-action="onb-copy-asks" data-id="${c.id}">Copy chase-up message</button>`
            : `<p>Nothing outstanding from them.</p>`}
        </div>
        <div class="onb-side-card">
          <h4>Lead essentials</h4>
          <p>Four answers from the kickoff call. They become this client's qualified lead structure.</p>
          ${LAUNCH_ESSENTIALS.map(e => `
            <label class="onb-ess"><span>${escapeHtml(e.label)}</span>
              <input type="text" data-onb-field="ess:${e.key}" value="${escapeHtml(p[e.key + ONBOARDING_ANSWER_SUFFIX] || "")}" placeholder="${escapeHtml(e.placeholder)}">
            </label>`).join("")}
        </div>
      </aside>
    </div>
    <div class="onb-m-foot">
      <span>${ls.doneTasks} of ${ls.total} tasks done</span>
      ${ls.launched
        ? `<button type="button" class="btn gold" data-action="onb-finish" data-id="${c.id}">Finish onboarding → ${escapeHtml(CLIENT_STAGE_MAP[postOnboardingStage(c)].label)}</button>`
        : `<button type="button" class="btn gold" data-action="onb-move" data-id="${c.id}" data-stage="${ONB_STAGE_KEYS[ls.current + 1]}">Move to ${escapeHtml(LAUNCH_MILESTONES[ls.current + 1].label)} →</button>`}
    </div>`;
  if (keep){
    const el = body.querySelector(`[data-onb-field="${keep.field}"]`);
    if (el){ el.value = keep.value; el.focus(); try { if (keep.s != null) el.setSelectionRange(keep.s, keep.e); } catch(e){} }
  }
}
// Saves a field from the launch pop-up. Essentials go through the same
// answer store the qualified lead structure is built from.
async function saveOnbField(c, field, value){
  if (field.startsWith("ess:")){
    await saveOnboardingAnswer(c.id, field.slice(4), value);
    await saveLaunchProgress(c, {});
    return;
  }
  if (field === "kickoff_at") return saveLaunchProgress(c, { kickoff_at: value || null, kickoff_booked: value ? true : (c.onboarding_progress || {}).kickoff_booked || null });
  return saveLaunchProgress(c, { [field]: value || null });
}
function setupOnboarding(){
  const body = $("#onb-modal-body");
  body?.addEventListener("change", async (e) => {
    const el = e.target.closest("[data-onb-field]");
    const c = state.clients.find(x => x.id === state.onbOpenId);
    if (!el || !c) return;
    await saveOnbField(c, el.dataset.onbField, el.value.trim());
    if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
  });
  $("#onb-modal")?.addEventListener("click", (e) => {
    if (e.target.closest("[data-close='onb-modal']") || e.target.id === "onb-modal") state.onbOpenId = null;
  });
  $("#onb-board")?.addEventListener("keydown", (e) => {
    const card = e.target.closest(".onb-card");
    if (card && (e.key === "Enter" || e.key === " ")){ e.preventDefault(); openOnbModal(card.dataset.id); }
  });
  setupOnbDrag();
}
async function handleOnbAction(action, id, btn){
  if (action === "onb-add-client"){
    $("#add-client-btn")?.click();
    const stageSel = $("#client-stage");
    if (stageSel){ stageSel.value = "onboarding"; stageSel.dispatchEvent(new Event("change")); }
    return true;
  }
  const c = state.clients.find(x => x.id === id);
  if (!c) return false;
  if (action === "onb-open"){ openOnbModal(id); return true; }
  if (action === "onb-toggle"){
    const key = btn.dataset.task;
    const on = !(c.onboarding_progress || {})[key];
    await saveLaunchProgress(c, { [key]: on ? true : null });
    if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
    return true;
  }
  if (action === "onb-move"){ await moveOnbStage(c, btn.dataset.stage); return true; }
  if (action === "onb-finish"){ await finishOnboarding(c); return true; }
  if (action === "onb-pack"){ state.onbOpenId = null; closeModal("onb-modal"); openWelcomePack(c.id); return true; }
  if (action === "onb-client-page"){
    state.onbOpenId = null; closeModal("onb-modal");
    state.selectedClientId = id; renderClients(); $('.nav-item[data-page="clients"]')?.click();
    return true;
  }
  if (action === "onb-copy-asks"){
    const text = clientAsksMessage(c, launchState(c));
    try { await navigator.clipboard.writeText(text); btn.textContent = "Copied - paste it into a text or email"; }
    catch(e){ prompt("Copy this message:", text); }
    setTimeout(() => { if (btn.isConnected) btn.textContent = "Copy chase-up message"; }, 2500);
    return true;
  }
  return false;
}

/* On the client's own page: a compact view of the same launch. */
function renderClientOnboarding(c){
  const card = $("#client-launch-card");
  if (!card) return;
  if (!isOnboardingClient(c)){ card.hidden = true; return; }
  card.hidden = false;
  const ls = launchState(c);
  card.innerHTML = `
    <div class="cl-launch-head">
      <div>
        <h3>Onboarding · ${escapeHtml(ls.stage.label)}</h3>
        <p>${escapeHtml(ls.status.label)} · day ${ls.daysIn}${ls.target ? ` · ads due ${escapeHtml(fmtShortDate(ls.target))}` : ""}</p>
      </div>
      <button type="button" class="btn gold sm" data-action="onb-open" data-id="${c.id}">Open onboarding</button>
    </div>
    <div class="onb-seg compact">
      ${ls.milestones.map((m, i) => `<span class="onb-seg-btn ${i === ls.current ? "active" : ""} ${m.complete ? "past" : ""}"><span class="onb-seg-num">${m.complete ? TASK_CHECK_SVG : i + 1}</span>${escapeHtml(m.label)}</span>`).join("")}
    </div>
    ${ls.nextTask && !ls.launched ? `<div class="onb-next"><span class="onb-next-label">Next</span>${ls.nextTask.who === "client" ? `<em>Client</em>` : ""}${escapeHtml(ls.nextTask.label)}</div>` : ""}`;
  const main = $("#client-detail-main");
  if (main && main.firstElementChild !== card) main.prepend(card);
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
function populateLinkAdAccountClientSelect(){
  const sel = $("#link-ad-account-client");
  if (!sel) return;
  sel.innerHTML = `<option value="__new__">+ New Client...</option>` +
    state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  sel.value = "__new__";
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
/* ───────── Creative Library > Statistics ─────────
   How every client is really doing, segmented by industry: what's been spent
   on ads (live from Meta), the leads it brought, the quotes those turned into
   and what each quote cost. Quotes, jobs and revenue come live from each
   client's GHL (all time since their ads started) when it's connected, and
   from their finance reports otherwise. */
const INDUSTRY_HINTS = [
  [/plumb/i, "Plumbing"], [/electric|sparky/i, "Electrical"], [/roof/i, "Roofing"], [/landscap/i, "Landscaping"],
  [/concret/i, "Concreting"], [/fenc/i, "Fencing"], [/til(e|ing)\b/i, "Tiling"], [/paint/i, "House Painting"],
  [/heat ?pump/i, "Heat Pump Installation"], [/hvac|air ?con/i, "HVAC"], [/solar/i, "Solar Installation"],
  [/build|construct/i, "Builders"], [/carpent|joiner/i, "Carpentry"], [/deck/i, "Deck Building"], [/glaz|glass/i, "Glazing"],
  [/gutter/i, "Guttering"], [/insulat/i, "Insulation"], [/clean/i, "House Cleaning"], [/pest/i, "Pest Control"],
  [/tree|arbor/i, "Tree Services"], [/kitchen|bathroom|renovat/i, "Kitchen & Bathroom Renovation"], [/scaffold/i, "Scaffolding"],
  [/plaster/i, "Plastering"], [/floor/i, "Flooring"], [/drainage|excavat|digger/i, "Excavation"], [/paving|driveway/i, "Driveways & Paving"],
  [/real estate|property/i, "Real Estate"], [/dental|dentist/i, "Dental"], [/legal|law(yer)?s?\b/i, "Legal"],
];
const CLIENT_INDUSTRY_OPTIONS = [...HOME_SERVICES_INDUSTRIES, "Real Estate", "Dental", "Legal", "Other"];
const normName = (s) => String(s || "").toLowerCase().replace(/\b(ltd|limited|nz|co)\b/g, "").replace(/[^a-z0-9]/g, "");
// The client's industry: what's set on them, else the prospect they came
// from, else a guess from their name and notes. { name, guessed }.
function clientIndustry(c){
  if (c.industry) return { name: c.industry, guessed: false };
  const n = normName(c.name);
  const p = n && state.prospects.find(x => x.industry && (normName(x.company) === n || (c.phone && x.phone && x.phone.replace(/\D/g, "").slice(-8) === c.phone.replace(/\D/g, "").slice(-8))));
  if (p) return { name: p.industry, guessed: true };
  const text = [c.name, c.notes, c.services].join(" ");
  const hit = INDUSTRY_HINTS.find(([re]) => re.test(text));
  return hit ? { name: hit[1], guessed: true } : { name: "", guessed: true };
}

let crView = "library";
const csGhl = {};          // client id -> { at, metrics } or { at, error }
let csGhlRunning = false, csScope = "current";
async function csPullGhl(force){
  if (!IS_CONFIGURED || csGhlRunning) return;
  const fresh = (id) => csGhl[id] && Date.now() - csGhl[id].at < 15 * 60e3;
  const todo = state.clients.filter(c => force || !fresh(c.id));
  if (!todo.length) return;
  csGhlRunning = true; renderCreativeStats();
  const today = localDayStr();
  const queue = [...todo];
  const worker = async () => {
    while (queue.length){
      const c = queue.shift();
      const from = String(c.ad_start_date || c.created_at || today).slice(0, 10);
      const r = await ghlCall({ action: "pull", client_id: c.id, from, to: today, stages: (c.onboarding_progress || {}).ghl_stages || {} });
      csGhl[c.id] = r.error ? { at: Date.now(), error: r.error } : { at: Date.now(), metrics: r.metrics || {} };
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  csGhlRunning = false;
  if (crView === "stats") renderCreativeStats();
}
// One client's numbers, all time. Quotes come from wherever they've been
// logged - live GHL, the finance reports, the Quote Guarantee counter on the
// client, or imported leads marked Qualified - taking whichever has the most,
// so a client never shows no cost per quote just because their quotes were
// logged a different way. Ad spend is Meta's, else the reports', else an
// estimate from their monthly ad spend since ads started.
function clientPerformance(c){
  const ads = state.adCreatives.filter(a => a.client_id === c.id);
  const sum = (list, k) => list.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  const metaSpend = sum(ads, "spend"), metaLeads = ads.filter(a => a.result !== "engagement").reduce((s, a) => s + (Number(a.results) || 0), 0);
  const byMonth = new Map(); monthReportsFor(c.id).forEach(r => byMonth.set(ymOf(r.period_end), r.metrics || {}));
  const months = [...byMonth.values()];
  const rep = (k) => months.reduce((s, m) => s + (toNum(m[k]) || 0), 0);
  const gh = csGhl[c.id] || null, g = gh?.metrics || null;
  const imported = (state.clientLeads || []).filter(l => l.client_id === c.id);
  const quoteSources = [
    ["GHL live", g ? toNum(g.quote_ready) || 0 : 0],
    ["Reports", rep("quoteReady")],
    ["Quote counter", Number(c.quotes_sent) || 0],
    ["Imported leads", imported.filter(l => classifyLeadStatus(l.status) === "Qualified").length],
  ].sort((a, b) => b[1] - a[1]);
  const quotes = quoteSources[0][1];
  let spend = metaSpend, spendSource = "Meta";
  if (!spend && rep("adSpendMonth")){ spend = rep("adSpendMonth"); spendSource = "Reports"; }
  if (!spend && Number(c.monthly_ad_spend) && c.ad_start_date){
    const m = Math.max(0, daysSince(c.ad_start_date) / 30.4);
    if (m > 0){ spend = Math.round(Number(c.monthly_ad_spend) * m); spendSource = "Estimate"; }
  }
  const quoteSource = quotes ? quoteSources[0][0] : "";
  const source = { "GHL live": "ghl", "Reports": "reports", "Quote counter": "counter", "Imported leads": "leads" }[quoteSource] || (metaSpend ? "meta" : "none");
  const leads = metaLeads || (g ? toNum(g.enquiries) : null) || rep("enquiries") || imported.length;
  const quoted = g ? toNum(g.quoted) || 0 : rep("quoted");
  const jobs = g ? toNum(g.jobs_won) || 0 : rep("jobsMonth");
  const revenue = g ? toNum(g.revenue_won) || 0 : rep("revenueMonth");
  const fees = rcRecordsOf(c).filter(rcIsPaid).reduce((s, r) => s + rcTotal(r), 0) || rep("mgmtMonth");
  // Why there's no cost per quote, if there isn't one.
  const missing = !spend && !quotes ? "No ad spend or quotes yet" : !spend ? "No ad spend synced" : !quotes ? "No quotes logged yet" : "";
  return { c, industry: clientIndustry(c), source, spend, spendSource, leads, quotes, quoteSource, quoted, jobs, revenue, fees, ads: ads.length, missing, ghlError: gh?.error || "" };
}
// Ratios for a client or a whole industry.
function perfRatios(t){
  return {
    cpl: t.spend && t.leads ? t.spend / t.leads : null,
    cpq: t.spend && t.quotes ? t.spend / t.quotes : null,
    leadToQuote: t.leads && t.quotes ? t.quotes / t.leads : null,
    close: t.quoted && t.jobs ? t.jobs / t.quoted : null,
    roi: t.revenue && (t.spend + t.fees) ? t.revenue / (t.spend + t.fees) : null,
  };
}
function sumPerf(rows){
  const t = { spend: 0, leads: 0, quotes: 0, quoted: 0, jobs: 0, revenue: 0, fees: 0 };
  rows.forEach(r => Object.keys(t).forEach(k => { t[k] += Number(r[k]) || 0; }));
  // Cost per quote only over clients that have both spend and quotes, so a
  // client with quotes but no synced spend doesn't drag the average down.
  const both = rows.filter(r => r.spend && r.quotes);
  const bs = both.reduce((n, r) => n + r.spend, 0), bq = both.reduce((n, r) => n + r.quotes, 0);
  return { ...t, ...perfRatios(t), cpq: bs && bq ? bs / bq : null, cpqSpend: bs, cpqQuotes: bq, count: rows.length };
}
const pct = (v) => v == null ? "-" : Math.round(v * 100) + "%";
const moneyOrDash = (v) => v == null ? "-" : fmtMoney(v);

function renderCreativeStats(){
  const box = $("#creative-stats-view");
  if (!box || crView !== "stats") return;
  const clients = state.clients.filter(c => csScope === "all" || !["churned"].includes(c.stage));
  const rows = clients.map(clientPerformance).filter(r => r.spend || r.quotes || r.leads || r.revenue);
  const idleList = clients.filter(c => !rows.some(r => r.c.id === c.id)), idle = idleList.length;
  const total = sumPerf(rows);
  const groups = new Map();
  rows.forEach(r => { const k = r.industry.name || "Industry not set"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); });
  const inds = [...groups.entries()].map(([name, list]) => ({ name, list, t: sumPerf(list) }))
    .sort((a, b) => (a.name === "Industry not set") - (b.name === "Industry not set") || b.t.spend - a.t.spend);
  const bestCpq = Math.max(...inds.map(i => i.t.cpq || 0), 1);
  const ghlCount = rows.filter(r => r.source === "ghl").length;
  const ghlNote = !IS_CONFIGURED ? "Demo numbers - live GHL pulls work on the live CRM."
    : csGhlRunning ? "Pulling live quotes from each client's GHL…"
    : `${ghlCount} of ${rows.length} client${rows.length === 1 ? "" : "s"} live from GHL · the rest from their finance reports`;
  const kpi = (label, value, sub, cls = "") => `<div class="cs-kpi ${cls}"><span>${label}</span><b>${value}</b>${sub ? `<small>${sub}</small>` : ""}</div>`;
  const srcChip = (r) => `<span class="cs-src cs-src-${r.source}" title="${escapeHtml([r.quoteSource && "Quotes: " + r.quoteSource, "Spend: " + r.spendSource, r.ghlError && "GHL: " + r.ghlError].filter(Boolean).join(" · "))}">${{ ghl: "GHL live", reports: "Reports", counter: "Quote counter", leads: "Imported leads", meta: "Meta only", none: "-" }[r.source]}</span>${r.spendSource === "Estimate" ? ` <span class="cs-src" title="Worked out from their monthly ad spend since ads started - sync their Meta ads for the real figure">est. spend</span>` : ""}`;
  const indSelect = (r) => `<select class="cs-ind-select" data-client="${r.c.id}" aria-label="Industry for ${escapeHtml(r.c.name)}">
      <option value="">${r.industry.name ? escapeHtml(r.industry.name) + " (guess)" : "Set industry…"}</option>
      ${CLIENT_INDUSTRY_OPTIONS.map(o => `<option value="${escapeHtml(o)}" ${!r.industry.guessed && r.industry.name === o ? "selected" : ""}>${escapeHtml(o)}</option>`).join("")}
    </select>`;
  box.innerHTML = `
    <div class="cs-bar">
      <div class="country-toggle" role="group" aria-label="Which clients">
        <button type="button" data-cs-scope="current" class="${csScope === "current" ? "active" : ""}">Current clients</button>
        <button type="button" data-cs-scope="all" class="${csScope === "all" ? "active" : ""}">Include churned</button>
      </div>
      <span class="cs-ghl-note ${csGhlRunning ? "busy" : ""}">${escapeHtml(ghlNote)}</span>
      ${IS_CONFIGURED ? `<button type="button" class="btn ghost sm" data-action="cs-refresh-ghl" ${csGhlRunning ? "disabled" : ""}>Refresh from GHL</button>` : ""}
    </div>
    <div class="cs-hero card">
      <div class="cs-hero-main">
        <span class="cs-k">Average cost per quote</span>
        <b class="cs-hero-num">${moneyOrDash(total.cpq)}</b>
        <span class="cs-hero-sub">${total.cpqQuotes.toLocaleString()} quotes from ${fmtMoney(total.cpqSpend)} of ad spend · ${total.quotes.toLocaleString()} quotes across ${rows.length} client${rows.length === 1 ? "" : "s"} in all</span>
      </div>
      <div class="cs-kpis">
        ${kpi("Ad spend", fmtMoney(total.spend), "all time, from Meta")}
        ${kpi("Leads", total.leads.toLocaleString(), total.cpl != null ? fmtMoney(total.cpl) + " a lead" : "")}
        ${kpi("Lead to quote", pct(total.leadToQuote), "leads that became quotes")}
        ${kpi("Jobs won", total.jobs.toLocaleString(), total.close != null ? pct(total.close) + " of quotes sent" : "")}
        ${kpi("Revenue won", fmtMoney(total.revenue), "for our clients")}
        ${kpi("Return", fmtTimes(total.roi), "revenue per $1 of ads + fees", "gold")}
      </div>
    </div>
    ${!rows.length ? `<div class="card cs-empty">${emptyState("No client results yet. Once ads sync from Meta and reports or GHL come in, every client's numbers show here.")}</div>` : `
    <div class="card cs-card">
      <div class="cs-card-head"><div><h3>By industry</h3><p>Which trades our system works best for. Shorter bar = cheaper quotes.</p></div></div>
      <div class="table-wrap"><table class="cs-table">
        <thead><tr><th>Industry</th><th>Clients</th><th>Ad spend</th><th>Leads</th><th>Cost per lead</th><th>Quotes</th><th>Cost per quote</th><th>Lead → quote</th><th>Jobs</th><th>Revenue</th><th>Return</th></tr></thead>
        <tbody>${inds.map(i => `
          <tr>
            <td><div class="row-name">${escapeHtml(i.name)}</div></td>
            <td>${i.list.length}</td>
            <td>${fmtMoney(i.t.spend)}</td>
            <td>${i.t.leads.toLocaleString()}</td>
            <td>${moneyOrDash(i.t.cpl)}</td>
            <td>${i.t.quotes.toLocaleString()}</td>
            <td class="cs-cpq"><b>${moneyOrDash(i.t.cpq)}</b>${i.t.cpq != null ? `<span class="cs-cpq-bar"><i style="width:${Math.max(4, Math.round(i.t.cpq / bestCpq * 100))}%"></i></span>` : ""}</td>
            <td>${pct(i.t.leadToQuote)}</td>
            <td>${i.t.jobs.toLocaleString()}</td>
            <td>${fmtMoney(i.t.revenue)}</td>
            <td class="cs-roi">${fmtTimes(i.t.roi)}</td>
          </tr>`).join("")}</tbody>
      </table></div>
    </div>
    ${inds.map(i => `
    <div class="card cs-card">
      <div class="cs-card-head">
        <div><h3>${escapeHtml(i.name)}</h3><p>${i.list.length} client${i.list.length === 1 ? "" : "s"} · ${moneyOrDash(i.t.cpq)} a quote · ${moneyOrDash(i.t.cpl)} a lead</p></div>
      </div>
      <div class="table-wrap"><table class="cs-table">
        <thead><tr><th>Client</th><th>Ad spend</th><th>Leads</th><th>Cost per lead</th><th>Quotes</th><th>Cost per quote</th><th>Lead → quote</th><th>Jobs</th><th>Revenue</th><th>Return</th></tr></thead>
        <tbody>${i.list.sort((a, b) => (perfRatios(a).cpq ?? 1e9) - (perfRatios(b).cpq ?? 1e9)).map(r => { const x = perfRatios(r); return `
          <tr>
            <td><button type="button" class="cs-client" data-action="view-client" data-id="${r.c.id}">${escapeHtml(r.c.name)}</button><div class="row-sub cs-client-sub">${srcChip(r)} ${r.ads} ad${r.ads === 1 ? "" : "s"} ${indSelect(r)}</div></td>
            <td>${fmtMoney(r.spend)}</td>
            <td>${(r.leads || 0).toLocaleString()}</td>
            <td>${moneyOrDash(x.cpl)}</td>
            <td>${r.quotes.toLocaleString()}</td>
            <td class="cs-cpq"><b>${moneyOrDash(x.cpq)}</b>${r.missing ? `<div class="row-sub cs-why">${escapeHtml(r.missing)}</div>` : ""}</td>
            <td>${pct(x.leadToQuote)}</td>
            <td>${r.jobs.toLocaleString()}</td>
            <td>${fmtMoney(r.revenue)}</td>
            <td class="cs-roi">${fmtTimes(x.roi)}</td>
          </tr>`; }).join("")}</tbody>
      </table></div>
    </div>`).join("")}`}
    ${idle ? `<p class="cs-foot">Not counted yet (no ad spend, leads or quotes in the CRM): ${idleList.map(c => `<button type="button" class="cs-client cs-idle" data-action="view-client" data-id="${c.id}">${escapeHtml(c.name)}</button>`).join(", ")}. Sync their Meta ads, connect GHL or log quotes on their profile and they'll show up.</p>` : ""}
    <p class="cs-foot">Cost per quote = all-time Meta ad spend ÷ quotes booked (site visit arranged, to be quoted or any quote stage in GHL). Return = revenue won ÷ (ad spend + our fees paid).</p>`;
}
function setCreativeView(view){
  crView = view;
  $$("#creative-view-toggle button").forEach(b => { const on = b.dataset.crView === view; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on); });
  const stats = view === "stats";
  $("#creative-lib-view").hidden = stats;
  $("#creative-lib-actions").hidden = stats;
  $("#creative-stats-view").hidden = !stats;
  $("#creative-page-title").textContent = stats ? "Statistics" : "Creative Library";
  $("#creative-page-sub").textContent = stats
    ? "How our clients are doing by industry, and what every quote costs."
    : "Every ad across all clients, live from Meta. Ads over $50 a lead move to Low on their own.";
  if (stats){ renderCreativeStats(); csPullGhl(false); }
}

function renderCreativeLibrary(){
  const grid = $("#creative-library-grid");
  if (!grid) return;
  renderCreativeStats();

  const clientSel = $("#creative-filter-client");
  if (clientSel){
    clientSel.innerHTML = `<option value="">All Clients</option>` + state.clients.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("")
      + (state.adCreatives.some(a => !a.client_id || !state.clients.some(c => c.id === a.client_id)) ? `<option value="__deleted__">Deleted clients</option>` : "");
    clientSel.value = state.creativeFilter.client;
    if (clientSel.value !== state.creativeFilter.client) state.creativeFilter.client = clientSel.value;
  }
  $("#creative-filter-result").value = state.creativeFilter.result;
  const deliverySel = $("#creative-filter-delivery");
  if (deliverySel) deliverySel.value = state.creativeFilter.delivery || "";
  const sortSel = $("#creative-filter-sort");
  if (sortSel) sortSel.value = state.creativeFilter.sort || "top";

  const all = state.adCreatives;

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
    const matchesClient = !state.creativeFilter.client || (state.creativeFilter.client === "__deleted__" ? (!a.client_id || !state.clients.some(c => c.id === a.client_id)) : a.client_id === state.creativeFilter.client);
    const matchesResult = !state.creativeFilter.result || a.result === state.creativeFilter.result;
    const matchesDelivery = !state.creativeFilter.delivery || a.delivery_status === state.creativeFilter.delivery;
    return matchesClient && matchesResult && matchesDelivery;
  });

  // Inside each section, active ads always come first, then anything brand
  // new that hasn't synced a delivery status yet, then ones Meta is holding
  // up, then paused ones. The chosen sort applies within each of those, and
  // fatigue never changes the order - it's a badge on the card.
  const priorityTier = (a) => {
    const group = DELIVERY_STATUS[a.delivery_status]?.group;
    if (group === "running") return 0;
    if (!a.delivery_status) return 1;
    if (group === "attention") return 2;
    return 3;
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

  if (!filtered.length){ grid.innerHTML = emptyState("No ad creatives match. Add one from here or from a client's page."); renderCreativeSegmentNav([]); return; }
  const cardHtml = (a) => {
    const client = state.clients.find(c => c.id === a.client_id);
    const initial = (client?.name || a.client_name || archivedClientName(a.client_id) || "?").trim().charAt(0).toUpperCase();
    const delivery = DELIVERY_STATUS[a.delivery_status];
    const fatigue = FATIGUE_STATUS[a.fatigue_status];
    const cardTierCls = a.fatigue_status === "fatiguing" ? "is-fatiguing" : a.fatigue_status === "fatigued" ? "is-fatigued" : ""
    const offCls = DELIVERY_STATUS[a.delivery_status]?.group === "paused" ? " is-off" : "";
    return `
    <div class="creative-card ${cardTierCls}${offCls}">
      <div class="creative-card-media">
        ${a.image_url ? `<img src="${escapeHtml(a.image_url)}" class="creative-card-img" data-action="view-creative-image" data-url="${escapeHtml(a.image_url)}">` : `<div class="creative-card-img-empty">${escapeHtml(initial)}</div>`}
        ${delivery ? `<span class="badge creative-card-delivery ${delivery.cls}">${delivery.label}</span>` : ""}
        <span class="badge creative-card-badge ${AD_RESULTS[a.result]?.cls||'gray'}">${AD_RESULTS[a.result]?.label||a.result}</span>
        ${fatigue ? `<span class="badge creative-card-fatigue ${fatigue.cls}">${fatigue.label}</span>` : ""}
      </div>
      <div class="creative-card-body">
        <div class="creative-card-name">${escapeHtml(a.name)}</div>
        <div class="creative-card-client">${client ? escapeHtml(client.name) : `${escapeHtml(a.client_name || archivedClientName(a.client_id) || "No client")} <span class="creative-deleted-client">Deleted client</span>`}${a.campaign_id && campaignName(a.campaign_id) ? ` · ${escapeHtml(campaignName(a.campaign_id))}` : ""}</div>
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
  };
  // Segment the library by performer tag. Each creative lands in exactly
  // one section; active ads lead and the chosen sort applies inside each.
  const groups = CREATIVE_SEGMENTS.map(seg => ({ ...seg, items: [] }));
  const bySeg = Object.fromEntries(groups.map(g => [g.key, g]));
  filtered.forEach(a => bySeg[creativeSegmentOf(a)].items.push(a));
  const shown = groups.filter(g => g.items.length);
  renderCreativeSegmentNav(shown);
  grid.innerHTML = shown.map(g => {
    const open = state.creativeSegOpen.has(g.key);
    const limit = g.collapsed && !open ? 0 : (open ? Infinity : CREATIVE_SEG_PREVIEW);
    const items = g.items.slice(0, limit);
    const hidden = g.items.length - items.length;
    return `
      <section class="cr-seg cr-seg-${g.key}" id="cr-seg-${g.key}">
        <header class="cr-seg-head">
          <span class="cr-seg-dot"></span>
          <div class="cr-seg-text"><h3>${escapeHtml(g.label)}<span class="cr-seg-count">${g.items.length}</span></h3><p>${escapeHtml(g.blurb)}</p></div>
          ${hidden > 0 || open ? `<button type="button" class="btn ghost sm cr-seg-toggle" data-action="toggle-creative-seg" data-key="${g.key}">${open ? (g.collapsed ? "Hide" : "Show less") : `Show ${g.collapsed ? "" : "all "}${g.items.length}`}</button>` : ""}
        </header>
        ${items.length ? `<div class="creative-grid">${items.map(cardHtml).join("")}</div>` : ""}
      </section>`;
  }).join("");
}
// Which section a creative belongs in: only the performer tag you set
// decides it. Fatigue and whether the ad is running or paused never move it
// to another section - they show as badges on the card, and active ads sort
// to the front of their section.
const CREATIVE_SEG_PREVIEW = 4;
const CREATIVE_SEGMENTS = [
  { key: "performing", label: "Top performers", blurb: "Ads you've tagged as top performers. Active ones first." },
  { key: "testing", label: "Average performers", blurb: "Ads tagged average, including new ads synced from Meta until you rate them. Active ones first." },
  { key: "low", label: "Low performers", blurb: "Ads tagged low performers. Pause or replace them." },
  { key: "engagement", label: "Engagement posts", blurb: "Not lead-gen ads, so they sit apart from the rest.", collapsed: true },
];
function creativeSegmentOf(a){
  if (a.result === "engagement") return "engagement";
  if (a.result === "killed") return "low";
  if (a.result === "winner") return "performing";
  return "testing";
}
function renderCreativeSegmentNav(groups){
  const nav = $("#creative-seg-nav");
  if (!nav) return;
  nav.innerHTML = groups.map(g => `<button type="button" class="cr-seg-chip cr-chip-${g.key}" data-action="jump-creative-seg" data-key="${g.key}"><span class="cr-seg-dot"></span>${escapeHtml(g.label)}<b>${g.items.length}</b></button>`).join("");
}

/* ───────── Nurture: lost and ghosted deals ─────────
   A Closed Lost or Ghosted deal starts a 6-month sequence: the Lead
   nurture email templates, one every 14 days, then a re-engage call at six
   months (also left as a task). What's been sent is kept on the deal
   (deals.nurture, from sql/057); until that column exists, the sequence
   simply runs from when the deal was last updated. */
const NURTURE_STAGES = new Set(["closed_lost", "ghosted"]);
const NURTURE_EVERY_DAYS = 14, NURTURE_REENGAGE_DAYS = 182;
const nurtureOf = (d) => d.nurture || {};
const nurtureStart = (d) => (nurtureOf(d).started_at || d.stage_changed_at || d.updated_at || d.created_at || "").slice(0, 10);
const nurtureDay = (start, n) => { const t = new Date(start + "T00:00:00"); t.setDate(t.getDate() + n); return localDayStr(t); };
// The sequence, from the Lead nurture templates in Email Templates.
function nurtureSteps(){
  const pick = (list) => list.filter(t => /^Lead nurture · \d+\./.test(t.title || ""))
    .map(t => ({ ...t, n: Number(t.title.match(/^Lead nurture · (\d+)\./)[1]) }))
    .sort((a, b) => a.n - b.n);
  const live = pick(state.emailTemplates || []);
  return live.length ? live : pick(window.MP_BUILTIN_EMAIL_TEMPLATES || []);
}
function nurtureState(d){
  const n = nurtureOf(d), start = nurtureStart(d), steps = nurtureSteps();
  const sent = Array.isArray(n.sent) ? n.sent : [];
  // Deals lost before nurture existed pick up where they'd be by now,
  // rather than all starting at email 1.
  const elapsed = Math.max(0, Math.round((new Date(localDayStr()) - new Date(start)) / 86400000));
  const nextIdx = Number.isInteger(n.pos) ? n.pos : n.started_at ? sent.length : Math.min(steps.length, Math.floor(elapsed / NURTURE_EVERY_DAYS));
  const next = steps[nextIdx] || null;
  return {
    start, steps, sent, stopped: !!n.stopped,
    next, nextIdx, nextDue: next ? nurtureDay(start, nextIdx * NURTURE_EVERY_DAYS) : null,
    reengage: nurtureDay(start, NURTURE_REENGAGE_DAYS),
  };
}
function nurtureContact(d){
  const contact = d.contact_id ? state.contacts.find(c => c.id === d.contact_id) : null;
  const name = (contact?.name || (d.contact_name || "").split(" - ")[0] || "").trim();
  return { name, first: name.split(/\s+/)[0] || "", email: contact?.email || "", business: dealBusinessName(d) };
}
// Saves nurture progress on the deal. Quietly does nothing if sql/057
// hasn't been run yet, so the pipeline itself never breaks.
async function saveNurture(d, patch){
  const nurture = { ...nurtureOf(d), ...patch };
  d.nurture = nurture;
  if (IS_CONFIGURED){
    const { error } = await supabase.from("deals").update({ nurture }).eq("id", d.id);
    if (error) console.warn("Nurture not saved (run sql/057):", error.message);
  }
  renderNurture();
}
// Called whenever a deal's stage changes.
async function onDealStageChanged(deal, before){
  if (!deal || deal.stage === before) return;
  const now = new Date().toISOString();
  if (IS_CONFIGURED) supabase.from("deals").update({ stage_changed_at: now }).eq("id", deal.id).then(({ error }) => { if (error) console.warn(error.message); });
  deal.stage_changed_at = now;
  if (!NURTURE_STAGES.has(deal.stage) || NURTURE_STAGES.has(before)) return;
  await saveNurture(deal, { started_at: now, pos: 0, sent: [], stopped: false });
  // The six-month re-engage, as a task so it lands in Tasks too.
  const title = `Re-engage ${deal.contact_name || deal.title} (6-month nurture)`;
  if (!state.tasks.some(t => t.deal_id === deal.id && t.status === "open" && t.title === title)){
    await DataLayer.insert("tasks", {
      title, notes: `"${deal.title}" went ${STAGES.find(s => s.key === deal.stage)?.label || deal.stage} six months ago. Call to see if the timing's better now.`,
      due_date: nurtureDay(localDayStr(), NURTURE_REENGAGE_DAYS), priority: "medium", assignee: deal.assignee || null,
      deal_id: deal.id, status: "open",
    });
  }
}
function renderNurture(){
  const list = $("#nurture-list");
  if (!list) return;
  const today = localDayStr();
  const deals = state.deals.filter(d => NURTURE_STAGES.has(d.stage)).map(d => ({ d, s: nurtureState(d) }));
  const active = deals.filter(x => !x.s.stopped);
  const due = active.filter(x => x.s.next && x.s.nextDue <= today);
  const reengage = active.filter(x => x.s.reengage <= nurtureDay(today, 30));
  $("#nurture-kpis").innerHTML = [
    [due.length, "emails due"], [active.length, "in nurture"], [reengage.length, "re-engage within 30 days"],
  ].map(([v, l], i) => `<span class="nr-kpi ${i === 0 && v ? "is-due" : ""}"><b>${v}</b>${escapeHtml(l)}</span>`).join("");
  if (!deals.length){ list.innerHTML = `<div class="rc-empty">No lost or ghosted deals. When one goes Closed Lost or Ghosted, it starts its 6-month nurture here.</div>`; return; }
  const order = (x) => x.s.stopped ? "9" : (x.s.next ? x.s.nextDue : x.s.reengage);
  deals.sort((a, b) => order(a).localeCompare(order(b)));
  list.innerHTML = deals.map(({ d, s }) => {
    const c = nurtureContact(d);
    const days = s.nextDue ? Math.round((new Date(s.nextDue) - new Date(today)) / 86400000) : null;
    const when = !s.next ? (s.reengage <= today ? "Re-engage call due" : `Sequence done · re-engage ${fmtShortDay(s.reengage)}`)
      : days < 0 ? `${-days} day${days === -1 ? "" : "s"} overdue` : days === 0 ? "Due today" : `Due ${fmtShortDay(s.nextDue)}`;
    const dots = s.steps.map((_, i) => `<i class="${i < s.nextIdx ? "on" : i === s.nextIdx ? "next" : ""}"></i>`).join("");
    const nextName = s.next ? etSplit(s.next.title)[1].replace(/^\d+\.\s*/, "") : "";
    return `<article class="nr-row ${s.stopped ? "is-stopped" : days != null && days <= 0 ? "is-due" : ""}">
      <span class="rc-avatar">${escapeHtml((c.business || d.title || "?").trim().charAt(0).toUpperCase())}</span>
      <div class="nr-id"><b>${escapeHtml(c.business || d.title)}</b><span>${escapeHtml(c.name || "No contact")} · ${escapeHtml(STAGES.find(x => x.key === d.stage)?.label || d.stage)} ${escapeHtml(fmtShortDay(s.start))}</span></div>
      <div class="nr-progress"><div class="nr-dots">${dots}</div><span>${s.stopped ? "Stopped" : s.next ? `Next: ${escapeHtml(nextName)}` : "Emails done"}</span></div>
      <span class="rc-chip ${s.stopped ? "muted" : days != null && days < 0 ? "late" : days === 0 || (!s.next && s.reengage <= today) ? "now" : ""}">${escapeHtml(s.stopped ? "Paused" : when)}</span>
      <div class="nr-actions">
        ${s.stopped ? `<button type="button" class="btn ghost sm" data-action="nurture-resume" data-id="${d.id}">Resume</button>`
          : `${s.next ? `<button type="button" class="btn gold sm" data-action="nurture-open" data-id="${d.id}">Send email ${s.nextIdx + 1}</button>` : ""}
             <button type="button" class="btn ghost sm" data-action="nurture-stop" data-id="${d.id}" title="Stop the emails for this deal">Stop</button>`}
        <button type="button" class="btn ghost sm" data-action="view-deal" data-id="${d.id}">Open deal</button>
      </div>
    </article>`;
  }).join("");
}
const fmtShortDay = (day) => day ? new Date(day + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "";
function fillNurtureTemplate(text, c){
  const person = window.getActivePerson ? window.getActivePerson() : null;
  return String(text || "")
    .replace(/\[First name\]/g, c.first || "there")
    .replace(/\[Business\]/g, c.business || "your business")
    .replace(/\[Your name\]/g, ASSIGNEES[person]?.label || "[Your name]");
}
function openNurtureEmail(dealId){
  const d = state.deals.find(x => x.id === dealId);
  if (!d) return;
  const s = nurtureState(d), c = nurtureContact(d);
  if (!s.next) return;
  $("#nurture-deal-id").value = d.id;
  $("#nurture-modal-title").textContent = `Email ${s.nextIdx + 1} of ${s.steps.length} · ${c.business || d.title}`;
  $("#nurture-modal-sub").textContent = `${etSplit(s.next.title)[1]}. Check the [square bracket] bits, send it, then mark it sent - the next one's due two weeks later.`;
  $("#nurture-to").value = c.email;
  $("#nurture-subject").value = fillNurtureTemplate(s.next.subject, c);
  $("#nurture-body").value = fillNurtureTemplate(s.next.body, c);
  openModal("nurture-modal");
}
function setupNurture(){
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action^='nurture-']");
    if (!btn) return;
    const d = state.deals.find(x => x.id === btn.dataset.id);
    if (btn.dataset.action === "nurture-open") openNurtureEmail(btn.dataset.id);
    if (btn.dataset.action === "nurture-stop" && d) await saveNurture(d, { stopped: true });
    if (btn.dataset.action === "nurture-resume" && d) await saveNurture(d, { stopped: false });
  });
  $("#nurture-copy")?.addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText($("#nurture-body").value); e.target.textContent = "Copied"; setTimeout(() => { e.target.textContent = "Copy email"; }, 1500); } catch(err){}
  });
  $("#nurture-gmail")?.addEventListener("click", () => {
    window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent($("#nurture-to").value)}&su=${encodeURIComponent($("#nurture-subject").value)}&body=${encodeURIComponent($("#nurture-body").value)}`, "_blank");
  });
  $("#nurture-mark-sent")?.addEventListener("click", async () => {
    const d = state.deals.find(x => x.id === $("#nurture-deal-id").value);
    if (!d) return;
    const s = nurtureState(d);
    await saveNurture(d, { started_at: nurtureOf(d).started_at || s.start, pos: s.nextIdx + 1, sent: [...s.sent, { n: s.nextIdx + 1, at: new Date().toISOString() }] });
    closeModal("nurture-modal");
  });
}

/* ───────── Auto-create a Client (Onboarding) when a deal wins ───────── */
// The business a deal is for: the linked contact's company, else the part
// after " - " in "Person - Business", else the deal title before " - ".
function dealBusinessName(deal){
  const contact = deal.contact_id ? state.contacts.find(c => c.id === deal.contact_id) : null;
  const fromContactName = (deal.contact_name || "").split(" - ")[1];
  const fromTitle = (deal.title || "").split(" - ")[0];
  return (contact?.company || fromContactName || fromTitle || deal.contact_name || deal.title || "").trim();
}
// Signing (Onboarding on the pipeline) or winning a deal makes them a client,
// straight onto the Onboarding board. Returns the new client, if one was made.
const CLIENT_FROM_DEAL_STAGES = new Set(["onboarding", "pending_results", "closed_won"]);
async function maybeCreateClientFromDeal(deal){
  if (!deal || !CLIENT_FROM_DEAL_STAGES.has(deal.stage)) return null;
  if (state.clients.some(c => c.source_deal_id === deal.id)) return null;
  const name = dealBusinessName(deal);
  if (!name) return null;
  if (state.clients.some(c => (c.name||"").trim().toLowerCase() === name.toLowerCase())) return null;
  const now = new Date().toISOString();
  const created = await DataLayer.insert("clients", {
    name,
    stage: "onboarding",
    stage_changed_at: now,
    source_deal_id: deal.id,
    onboarding_progress: { signed_at: now, ...(ASSIGNEES[deal.assignee] ? { owner: deal.assignee } : {}) },
    notes: `Auto-created when "${deal.title}" moved to ${STAGES.find(s => s.key === deal.stage)?.label || deal.stage}.`,
  });
  if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
  // A new client - time for their welcome pack.
  if (created?.id) openWelcomePack(created.id);
  return created || null;
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
    const goneName = c.client_name || archivedClientName(c.client_id);
    const key = client ? client.id : (goneName ? "deleted:" + goneName : "unassigned");
    if (!byClient[key]) byClient[key] = { name: client ? client.name : (goneName ? `${goneName} (deleted)` : "Unassigned"), spend:0, results:0, lifetimeSpend:0 };
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

/* ───────── Reporting: client performance reports ─────────
   Reports go out every fortnight, but each one is about the month so far:
   a mid-month check-in (1st to the 14th) and a month-end wrap. Made here and
   handed over as a PDF to drag into an email (drawn by js/report-pdf.js).
   Each report's numbers are saved in client_reports (metrics.kind = "mtd");
   totals to date add up the latest report of every earlier month plus this
   one, so a mid-month and a month-end report never double count. Revenue,
   jobs and quotes can be pulled from the client's GHL through the
   ghl-report-data function; everything stays editable before making it. */
const REPORT_EVERY_DAYS = 14;
const REPORT_KIND = "mtd";
const isActiveReportClient = (c) => !["onboarding", "churned"].includes(c.stage || "onboarding");
const ymOf = (dateStr) => String(dateStr || "").slice(0, 7);
function monthReportsFor(clientId){
  return state.clientReports
    .filter(r => r.client_id === clientId && r.metrics?.kind === REPORT_KIND)
    .sort((a, b) => String(a.period_end).localeCompare(String(b.period_end)));
}
function addDays(dateStr, n){ const d = localDateOnly(dateStr); d.setDate(d.getDate() + n); return localDayStr(d); }
const monthStart = (dateStr) => ymOf(dateStr) + "-01";
function monthEnd(dateStr){ const d = localDateOnly(monthStart(dateStr)); d.setMonth(d.getMonth() + 1); d.setDate(0); return localDayStr(d); }
const monthNameOf = (dateStr, withYear) => localDateOnly(monthStart(dateStr)).toLocaleDateString("en-NZ", withYear ? { month: "long", year: "numeric" } : { month: "long" });
// "October 2026 · 1–14 Oct", or "October 2026 · full month".
function fmtReportPeriod(from, to){
  if (!from || !to) return "";
  const full = from === monthStart(to) && to === monthEnd(to);
  const d = (x) => localDateOnly(x).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
  if (full) return `${monthNameOf(to, true)} · full month`;
  return `${monthNameOf(to, true)} · ${ymOf(from) === ymOf(to) ? `${localDateOnly(from).getDate()}–${d(to)}` : `${d(from)} – ${d(to)}`}`;
}
// When the next report is due: a fortnight after the last one.
function reportDueInfo(c){
  const reps = monthReportsFor(c.id);
  const last = reps[reps.length - 1];
  if (!last) return { due: true, label: "First report due", last: null };
  const days = daysBetween(localDateOnly(localDayStr()), localDateOnly(addDays(last.period_end, REPORT_EVERY_DAYS)));
  return { due: days <= 0, label: days <= 0 ? (days === 0 ? "Due today" : `Due ${-days}d ago`) : `Due in ${days}d`, last };
}
// Matches the report: whole numbers from 10× up, one decimal below.
const fmtTimes = (v) => v == null || !isFinite(v) ? "-" : (v >= 10 ? Math.round(v) : Math.round(v * 10) / 10) + "×";
const toNum = (v) => v === "" || v == null || isNaN(Number(v)) ? null : Number(v);
// The latest report of each month before `beforeYm` (each one already holds that month's totals).
function latestPerEarlierMonth(clientId, beforeYm, excludeId){
  const byMonth = new Map();
  monthReportsFor(clientId).filter(r => r.id !== excludeId && ymOf(r.period_end) < beforeYm).forEach(r => byMonth.set(ymOf(r.period_end), r));
  return [...byMonth.values()];
}
// Default period: this month so far; in the first few days of a month, last month in full.
function defaultReportPeriod(){
  const today = localDayStr();
  if (localDateOnly(today).getDate() <= 3){ const lastMonthEnd = addDays(monthStart(today), -1); return { from: monthStart(lastMonthEnd), to: lastMonthEnd }; }
  return { from: monthStart(today), to: today };
}
/* Each report only asks what's happened since the last one. Those numbers
   stack: onto the month so far (the last report in the same month), and
   from there onto the totals to date. A new month starts the month
   totals fresh. Old reports that stored month totals still work as the base. */
const REPORT_DELTAS = [
  { key: "dRevenue", month: "revenueMonth", label: "Revenue won", money: true },
  { key: "dJobs", month: "jobsMonth", label: "Jobs signed" },
  { key: "dAdSpend", month: "adSpendMonth", label: "Ad spend", money: true },
  { key: "dEnquiries", month: "enquiries", label: "Enquiries" },
  { key: "dBooked", month: "quoteReady", label: "Quotes booked" },
  { key: "dQuoted", month: "quoted", label: "Quotes sent" },
];
// The report this one builds on: the latest one before it.
function previousReport(clientId, to, excludeId){
  return monthReportsFor(clientId).filter(r => r.id !== excludeId && r.period_end < to).pop() || null;
}
// The month-so-far base: the previous report, if it's in the same month.
function monthBase(clientId, to, excludeId){
  const prev = previousReport(clientId, to, excludeId);
  return prev && ymOf(prev.period_end) === ymOf(to) ? prev.metrics || {} : {};
}
// Where the period starts: the day after the last report, or the start of the month.
function reportFrom(clientId, to, excludeId){
  const prev = previousReport(clientId, to, excludeId);
  if (prev) return addDays(prev.period_end, 1);
  const c = state.clients.find(x => x.id === clientId);
  const start = monthStart(to);
  return c?.ad_start_date && c.ad_start_date > start && c.ad_start_date <= to ? c.ad_start_date : start;
}
// The numbers for a report, from what the CRM already knows (since the last report).
function reportPrefill(c, from, to, excludeId){
  const prev = previousReport(c.id, to, excludeId);
  const base = monthBase(c.id, to, excludeId);
  const creatives = state.adCreatives.filter(a => a.client_id === c.id);
  const lifetimeSpend = creatives.reduce((s, a) => s + (Number(a.spend) || 0), 0);
  const dAdSpend = prev?.metrics?.ad_lifetime_spend != null && lifetimeSpend ? Math.max(0, Math.round(lifetimeSpend - prev.metrics.ad_lifetime_spend)) : "";
  const inPeriod = (d) => d && String(d).slice(0, 10) >= from && String(d).slice(0, 10) <= to;
  const leads = state.clientLeads.filter(l => l.client_id === c.id && inPeriod(l.lead_created_at || l.imported_at));
  const retainer = clientRetainer(c);
  const withResults = creatives.filter(a => Number(a.results) > 0 && a.cost_per_result != null);
  const best = [...withResults].sort((a, b) => a.cost_per_result - b.cost_per_result)[0];
  return {
    dAdSpend, dEnquiries: leads.length || "",
    dBooked: leads.filter(l => classifyLeadStatus(l.status) === "Qualified").length || "",
    mgmtMonth: toNum(base.mgmtMonth) ?? (retainer != null ? Math.round(retainer) : ""),
    quoteTarget: toNum(base.quoteTarget) || c.quote_target || 10,
    topAdId: best?.id || "",
  };
}
const REPORT_FIELDS = ["from", "to", ...REPORT_DELTAS.map(d => d.key), "revenueToDateOverride", "quoteTarget", "mgmtMonth", "summary", "did1", "did2", "did3", "next1", "next2", "next3", "topAdId"];
let rpClientId = null, rpLastUrl = null, rpLastName = "", rpExisting = null;
function rpVal(k){ return $("#rp-" + k)?.value ?? ""; }
function rpSet(k, v){ const el = $("#rp-" + k); if (el) el.value = v ?? ""; }
// Month-so-far values: the base plus what's been typed in since the last report.
function rpMonthValues(c){
  const to = rpVal("to") || localDayStr();
  const base = monthBase(c.id, to, rpExisting?.id);
  const out = {};
  REPORT_DELTAS.forEach(d => { out[d.month] = (toNum(base[d.month]) || 0) + (toNum(rpVal(d.key)) || 0); });
  out.mgmtMonth = toNum(rpVal("mgmtMonth")) || 0;
  out.quotesBooked = out.quoteReady;
  out.base = base;
  return out;
}

function openReportModal(clientId, existingId){
  const c = state.clients.find(x => x.id === clientId);
  if (!c) return;
  rpClientId = c.id;
  rpExisting = existingId ? state.clientReports.find(r => r.id === existingId) : null;
  $("#rp-title").textContent = `Report · ${c.name}`;
  $("#report-form").hidden = false; $("#rp-done").hidden = true;
  $("#rp-ghl-connect").hidden = true;
  REPORT_FIELDS.forEach(k => rpSet(k, ""));
  const creatives = state.adCreatives.filter(a => a.client_id === c.id);
  $("#rp-topAdId").innerHTML = `<option value="">No ad this time</option>` + creatives.map(a => `<option value="${a.id}">${escapeHtml(a.name)}${a.cost_per_result != null ? ` · ${fmtMoney(a.cost_per_result)}/lead` : ""}</option>`).join("");
  if (rpExisting){
    const m = rpExisting.metrics || {};
    rpSet("from", rpExisting.period_start); rpSet("to", rpExisting.period_end);
    // Reports made before the stacking change only have month totals: work the change out.
    const base = monthBase(c.id, rpExisting.period_end, rpExisting.id);
    REPORT_DELTAS.forEach(d => rpSet(d.key, m[d.key] ?? ((toNum(m[d.month]) ?? 0) - (toNum(base[d.month]) || 0) || "")));
    ["revenueToDateOverride", "quoteTarget", "mgmtMonth", "summary", "did1", "did2", "did3", "next1", "next2", "next3", "topAdId"].forEach(k => rpSet(k, m[k] ?? ""));
  } else {
    const to = localDayStr();
    rpSet("to", to); rpSet("from", reportFrom(c.id, to));
    rpApplyPrefill(c);
  }
  rpStatus("");
  rpRenderTotals();
  rpRenderGhl(c);
  openModal("report-modal");
}
function rpApplyPrefill(c){
  const pre = reportPrefill(c, rpVal("from"), rpVal("to"), rpExisting?.id);
  Object.entries(pre).forEach(([k, v]) => { if (!rpVal(k)) rpSet(k, v); });
}
function rpStatus(msg, warn){ const el = $("#rp-status"); if (el){ el.textContent = msg; el.classList.toggle("warn", !!warn); } }
// Totals to date: the latest report of every earlier month, plus this month so far.
function rpTotals(c){
  const to = rpVal("to") || localDayStr();
  const earlier = latestPerEarlierMonth(c.id, ymOf(to), rpExisting?.id);
  const sum = (k) => earlier.reduce((s, r) => s + (Number(r.metrics?.[k]) || 0), 0);
  const mv = rpMonthValues(c);
  const rev = mv.revenueMonth, spend = mv.adSpendMonth, mgmt = mv.mgmtMonth;
  const revenueToDate = toNum(rpVal("revenueToDateOverride")) ?? (sum("revenueMonth") + rev);
  const adSpendToDate = sum("adSpendMonth") + spend, mgmtToDate = sum("mgmtMonth") + mgmt;
  const investedToDate = adSpendToDate + mgmtToDate;
  const lastMonthYm = ymOf(addDays(monthStart(to), -1));
  const lastMonth = earlier.find(r => ymOf(r.period_end) === lastMonthYm);
  const reportNumber = monthReportsFor(c.id).filter(r => r.id !== rpExisting?.id && r.period_end < to).length + 1;
  return { earlier, reportNumber, revenueToDate, adSpendToDate, mgmtToDate, investedToDate, lastMonth, month: mv,
    roiMonth: spend + mgmt ? rev / (spend + mgmt) : null, roiToDate: investedToDate ? revenueToDate / investedToDate : null };
}
function rpRenderTotals(){
  const c = state.clients.find(x => x.id === rpClientId);
  const el = $("#rp-totals");
  if (!c || !el) return;
  const t = rpTotals(c), mv = t.month;
  const target = toNum(rpVal("quoteTarget")) || 10;
  const monthName = rpVal("to") ? monthNameOf(rpVal("to")) : "This month";
  REPORT_DELTAS.forEach(d => { const cell = $("#rp-m-" + d.key); if (cell) cell.textContent = d.money ? fmtMoney(mv[d.month]) : String(mv[d.month]); });
  $$(".rp-month-name").forEach(e => { e.textContent = monthName; });
  const prev = previousReport(c.id, rpVal("to") || localDayStr(), rpExisting?.id);
  const d = (x) => localDateOnly(x).toLocaleDateString("en-NZ", { day: "numeric", month: "short" });
  const note = $("#rp-since-note");
  if (note && rpVal("from") && rpVal("to")) note.textContent = `${d(rpVal("from"))} to ${d(rpVal("to"))}${prev ? ` · since report ${prev.metrics?.report_number || ""}` : " · first report"}${Object.keys(mv.base).length ? ` · adding to ${monthName} so far` : ` · ${monthName} starts fresh`}`;
  el.innerHTML = `
    <div><span>Revenue to date</span><b>${fmtMoney(t.revenueToDate)}</b></div>
    <div><span>Invested to date</span><b>${fmtMoney(t.investedToDate)}</b></div>
    <div><span>Return to date</span><b class="gold">${fmtTimes(t.roiToDate)}</b></div>
    <div><span>Quote guarantee</span><b>${mv.quotesBooked} / ${target}</b></div>`;
  $("#rp-period-note").textContent = `Report ${t.reportNumber} · ${fmtReportPeriod(rpVal("from"), rpVal("to"))}`;
}

/* GHL connection (through the ghl-report-data function, so the key never reaches the browser). */
async function ghlCall(body){
  if (!IS_CONFIGURED) return { error: "demo" };
  const { data, error } = await supabase.functions.invoke("ghl-report-data", { body });
  if (error){
    let msg = error.message || "Couldn't reach GHL.";
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch(e){}
    return { error: msg };
  }
  return data || {};
}
async function rpRenderGhl(c){
  const box = $("#rp-ghl"), stagesBox = $("#rp-ghl-stages");
  if (!box) return;
  if (stagesBox) stagesBox.hidden = true;
  if (!IS_CONFIGURED){ box.innerHTML = `<span class="rp-ghl-note">GHL pulls work on the live CRM. In demo mode, type the numbers in.</span>`; return; }
  box.innerHTML = `<span class="rp-ghl-note">Checking GHL…</span>`;
  const s = await ghlCall({ action: "status", client_id: c.id });
  if (rpClientId !== c.id) return;
  if (s.error){
    box.innerHTML = `<span class="rp-ghl-note warn">GHL isn't switched on yet (${escapeHtml(s.error)}). Type the numbers in for now.</span>`;
    return;
  }
  if (!s.connected){
    box.innerHTML = `<span class="rp-ghl-note">Connect ${escapeHtml(c.name)}'s GHL to fill revenue, jobs, enquiries and quotes automatically.</span><button type="button" class="btn ghost sm" data-action="rp-ghl-connect-show">Connect GHL</button>`;
    return;
  }
  box.innerHTML = `<span class="rp-ghl-ok">GHL connected${s.location_name ? ` · ${escapeHtml(s.location_name)}` : ""}</span><button type="button" class="btn gold sm" data-action="rp-ghl-pull">Pull from GHL</button><button type="button" class="btn ghost sm" data-action="rp-ghl-connect-show">Change</button>`;
  // Which stages count as "quote booked" and "quote sent" in their pipeline.
  const stages = (s.pipelines || []).flatMap(p => (p.stages || []).map(st => ({ id: st.id, name: (s.pipelines.length > 1 ? p.name + " · " : "") + st.name })));
  const pick = (c.onboarding_progress || {}).ghl_stages || {};
  if (stagesBox && stages.length){
    const opts = (sel) => `<option value="">Work it out from the names</option>` + stages.map(st => `<option value="${escapeHtml(st.id)}" ${st.id === sel ? "selected" : ""}>${escapeHtml(st.name)}</option>`).join("");
    stagesBox.innerHTML = `
      <div class="field"><label for="rp-ghl-booked">"Quote booked" is their stage</label><select id="rp-ghl-booked">${opts(pick.booked)}</select></div>
      <div class="field"><label for="rp-ghl-sent">"Quote sent" is their stage</label><select id="rp-ghl-sent">${opts(pick.sent)}</select></div>`;
    stagesBox.hidden = false;
  }
  // A new report fills itself straight away.
  if (!rpExisting) rpGhlPull();
}
async function rpGhlPull(){
  const c = state.clients.find(x => x.id === rpClientId);
  if (!c) return;
  rpStatus("Pulling from GHL…");
  // Ask GHL for the whole month so far, then take off what earlier reports this
  // month already counted. Leads that moved along since the last report are caught.
  const to = rpVal("to") || localDayStr();
  const pick = (c.onboarding_progress || {}).ghl_stages || {};
  const r = await ghlCall({ action: "pull", client_id: c.id, from: monthStart(to), to, stages: pick });
  if (rpClientId !== c.id) return;
  if (r.error){ rpStatus(`Couldn't pull from GHL: ${r.error}`, true); return; }
  const m = r.metrics || {};
  const base = monthBase(c.id, to, rpExisting?.id);
  const since = (metric, month) => metric == null ? null : Math.max(0, Math.round(metric - (toNum(base[month]) || 0)));
  const set = (k, v) => { if (v != null) rpSet(k, v); };
  set("dRevenue", since(m.revenue_won, "revenueMonth")); set("dJobs", since(m.jobs_won, "jobsMonth"));
  set("dEnquiries", since(m.enquiries, "enquiries")); set("dBooked", since(m.quote_ready, "quoteReady")); set("dQuoted", since(m.quoted, "quoted"));
  rpRenderTotals();
  const warn = m.won_missing_value ? ` ${m.won_missing_value} won job${m.won_missing_value === 1 ? " has" : "s have"} no $ value in GHL, so revenue may be low.` : "";
  rpStatus(`Filled from GHL (${m.opportunities_checked ?? 0} opportunities). Quotes counted from "${m.booked_stage || "?"}" (site visit / to be quoted / quote) onwards, quotes sent = "${m.sent_stage || "?"}" or later. Ad spend comes from Meta.${warn} Check the numbers, then make the report.`, Boolean(warn));
}
async function rpGhlConnect(){
  const c = state.clients.find(x => x.id === rpClientId);
  const location_id = $("#rp-ghl-location").value.trim(), token = $("#rp-ghl-token").value.trim();
  if (!c || !location_id || !token){ rpStatus("Add the GHL location ID and the private integration key.", true); return; }
  rpStatus("Connecting to GHL…");
  const r = await ghlCall({ action: "connect", client_id: c.id, location_id, token });
  if (r.error){ rpStatus(`Couldn't connect: ${r.error}`, true); return; }
  $("#rp-ghl-connect").hidden = true;
  $("#rp-ghl-token").value = "";
  rpStatus(`Connected to ${r.location_name || "GHL"}.`);
  rpRenderGhl(c);
}

/* Making the PDF */
async function loadImageBytes(url){
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: "cors" });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") || "image/jpeg";
    if (!/png|jpe?g/i.test(ct)) return null;
    return { bytes: await res.arrayBuffer(), type: /png/i.test(ct) ? "png" : "jpg" };
  } catch(e){ return null; }
}
async function makeReport(){
  const c = state.clients.find(x => x.id === rpClientId);
  if (!c) return;
  const from = rpVal("from"), to = rpVal("to");
  if (!from || !to || to < from){ rpStatus("Pick the report's start and end dates.", true); return; }
  const btn = $("#rp-make"); btn.disabled = true; rpStatus("Making the report…");
  try {
    await wpLoadLibs();
    const t = rpTotals(c);
    const form = Object.fromEntries(REPORT_FIELDS.map(k => [k, String(rpVal(k)).trim()]));
    const n = (k) => toNum(form[k]);
    const ad = state.adCreatives.find(a => a.id === form.topAdId);
    const clientResults = state.adCreatives.filter(a => a.client_id === c.id).reduce((s, a) => s + (Number(a.results) || 0), 0);
    const img = ad ? await loadImageBytes(ad.image_url) : null;
    const deal = c.source_deal_id ? state.deals.find(d => d.id === c.source_deal_id) : null;
    const person = window.getActivePerson ? window.getActivePerson() : null;
    let am = {}; try { am = JSON.parse(localStorage.getItem(wpAmKey(person)) || "{}"); } catch(e){}
    const firstReport = monthReportsFor(c.id)[0];
    const sinceDate = [firstReport?.period_start, c.ad_start_date, from].filter(Boolean).sort()[0];
    const mv = t.month;
    const spend = mv.adSpendMonth, enq = mv.enquiries, ready = mv.quoteReady, quoted = mv.quoted, jobs = mv.jobsMonth, rev = mv.revenueMonth;
    const lm = t.lastMonth?.metrics || null;
    const data = {
      clientName: c.name, reportNumber: t.reportNumber, periodLabel: fmtReportPeriod(from, to),
      monthName: monthNameOf(to), since: localDateOnly(sinceDate).toLocaleDateString("en-NZ", { month: "long", year: "numeric" }),
      revenueMonth: rev ?? 0, jobsMonth: jobs ?? 0, revenueToDate: t.revenueToDate,
      revenueLastMonth: lm ? toNum(lm.revenueMonth) : null, lastMonthName: lm ? monthNameOf(t.lastMonth.period_end) : "",
      cplLastMonth: lm && toNum(lm.adSpendMonth) != null && toNum(lm.quoteReady) ? toNum(lm.adSpendMonth) / toNum(lm.quoteReady) : null,
      awaitingDecision: Math.max(0, (quoted || 0) - (jobs || 0)),
      adSpendMonth: spend, adSpendToDate: t.adSpendToDate, mgmtToDate: t.mgmtToDate, investedToDate: t.investedToDate, roiToDate: t.roiToDate,
      enquiries: enq, quoteReady: ready, quoted,
      quotesBooked: ready || 0, quoteTarget: n("quoteTarget") || 10,
      summary: form.summary, didList: [form.did1, form.did2, form.did3], nextList: [form.next1, form.next2, form.next3],
      topAd: ad ? { name: ad.name, leads: ad.results, cpl: ad.cost_per_result, share: clientResults ? Math.round((Number(ad.results) || 0) / clientResults * 100) : null, imageBytes: img?.bytes, imageType: img?.type } : null,
      hood: [
        ["Cost per enquiry", spend && enq ? fmtMoney(spend / enq) : null, "Ad spend divided by every enquiry, qualified or not"],
        ["Quoted so far", ready && quoted != null ? Math.round(quoted / ready * 100) + "%" : null, "Share of quotes booked that have been quoted (the rest are still to come)"],
        ["Close rate", quoted && jobs != null ? Math.round(jobs / quoted * 100) + "%" : null, "Share of quotes sent that turned into signed jobs"],
        ["Average job value", jobs && rev ? fmtMoney(rev / jobs) : null, "Revenue won divided by jobs signed"],
        ["Return this month", t.roiMonth != null ? fmtTimes(t.roiMonth) : null, "Revenue won this month for every $1 invested this month"],
      ],
      contactName: am.account_manager || ASSIGNEES[deal?.assignee]?.label || "", contactPhone: am.phone || "",
    };
    const bytes = await window.MPReportPDF.build(data);
    // Save this report's numbers so later reports' totals build on them.
    // Both what changed since the last report and the month totals it adds up to.
    const metrics = { kind: REPORT_KIND, ...Object.fromEntries(REPORT_FIELDS.slice(2).map(k => [k, form[k]])),
      revenueMonth: rev, jobsMonth: jobs, adSpendMonth: spend, mgmtMonth: mv.mgmtMonth, enquiries: enq, quoteReady: ready, quoted, quotesBooked: ready,
      openQuotesCount: Math.max(0, (quoted || 0) - (jobs || 0)),
      report_number: data.reportNumber, revenueToDate: t.revenueToDate, investedToDate: t.investedToDate, roiToDate: t.roiToDate,
      ad_lifetime_spend: state.adCreatives.filter(a => a.client_id === c.id).reduce((s, a) => s + (Number(a.spend) || 0), 0) };
    const row = { client_id: c.id, period_start: from, period_end: to, metrics, status: "made" };
    const same = rpExisting || monthReportsFor(c.id).find(r => r.period_start === from && r.period_end === to);
    if (same) await DataLayer.update("client_reports", same.id, row); else await DataLayer.insert("client_reports", row);
    if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }

    if (rpLastUrl) URL.revokeObjectURL(rpLastUrl);
    rpLastUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    rpLastName = `Mr Priceless Report - ${(c.name || "Client").replace(/[\\/:*?"<>|]+/g, "")} - ${to}.pdf`;
    const link = $("#rp-file"); link.href = rpLastUrl; link.download = rpLastName;
    $("#rp-file-name").textContent = rpLastName;
    const a = document.createElement("a"); a.href = rpLastUrl; a.download = rpLastName; document.body.appendChild(a); a.click(); a.remove();
    $("#report-form").hidden = true; $("#rp-done").hidden = false;
    rpStatus("");
  } catch(err){
    console.error(err);
    rpStatus("Couldn't make the report: " + (err.message || err), true);
  } finally { btn.disabled = false; }
}

/* ───────── Receipts ─────────
   Clients pay each month by card; we send them a receipt that doubles as
   their tax invoice. The first payment is a month after they start, then
   every 30 days; each receipt covers the 30 days just gone, with 15% GST on
   top of the fee. Each client's billing and receipts live on the client
   (onboarding_progress.billing and .invoices - the key from when this page
   was Invoices), so there are no new tables. Our business details are saved
   per login in user_widget_state, and every receipt keeps a copy of them. */
const RC_GST = 0.15, RC_CYCLE_DAYS = 30, RC_SOON_DAYS = 14;
const RC_INCLUDED = [
  "Content creation for your Meta ads, filmed and edited for you",
  "Meta ads run and optimised by a senior media buyer",
  "A sales call to every lead that comes through",
  "One consulting workshop on your business each month",
];
const rcMoney = (n) => "$" + (Number(n) || 0).toLocaleString("en-NZ", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rcBilling = (c) => (c.onboarding_progress || {}).billing || {};
const rcRecordsOf = (c) => (c.onboarding_progress || {}).invoices || [];
const rcAll = () => state.clients.flatMap(c => rcRecordsOf(c).map(r => ({ r, c })));
const rcNum = (seq) => "RC-" + String(seq).padStart(4, "0");
const rcNumberOf = (r) => r.receipt_number || r.number || rcNum(r.seq || 0);
function rcAddDays(day, n){ const d = new Date(day + "T00:00:00"); d.setDate(d.getDate() + n); return localDayStr(d); }
function rcAddMonths(day, n){
  const d = new Date(day + "T00:00:00"), dd = d.getDate();
  d.setDate(1); d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(dd, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return localDayStr(d);
}
const rcDaysBetween = (a, b) => Math.round((new Date(b + "T00:00:00") - new Date(a + "T00:00:00")) / 86400000);
const rcLong = (day) => day ? new Date(day + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" }) : "";
const rcShort = (day) => day ? new Date(day + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short" }) : "";
function rcPeriodLabel(from, to){
  if (!from || !to) return "";
  const f = (d, y) => new Date(d + "T00:00:00").toLocaleDateString("en-NZ", { day: "numeric", month: "short", ...(y ? { year: "numeric" } : {}) });
  return `${f(from, from.slice(0, 4) !== to.slice(0, 4))} – ${f(to, true)}`;
}
const rcTotal = (r) => window.MPReceiptPDF ? window.MPReceiptPDF.totals(r.items, r.gst_rate ?? RC_GST).total : 0;
const rcIsBillable = (c) => !["churned", ARCHIVED_STAGE].includes(c.stage || "onboarding");
const rcIsPaid = (r) => r.status === "paid";
const rcPaidDay = (r) => (r.paid_at || r.date || "").slice(0, 10);

function rcStart(c){
  const b = rcBilling(c), p = c.onboarding_progress || {};
  if (b.start) return b.start;
  // Ads going live is when billing starts (see the onboarding step for it).
  if (c.ad_start_date) return c.ad_start_date.slice(0, 10);
  const deal = c.source_deal_id ? state.deals.find(d => d.id === c.source_deal_id) : null;
  if (deal?.commission_invoice_date) return deal.commission_invoice_date.slice(0, 10);
  const at = p.signed_at || c.created_at;
  return at ? localDayStr(new Date(at)) : null;
}
function rcFee(c){
  const b = rcBilling(c);
  if (b.fee !== undefined && b.fee !== null && b.fee !== "") return Number(b.fee);
  return clientRetainer(c);
}
const rcActive = (c) => rcIsBillable(c) && !rcBilling(c).paused && rcFee(c) > 0;
// Payment n: a month after the start, then every 30 days.
function rcCycleDate(c, n){
  const start = rcStart(c);
  if (!start) return null;
  const first = rcAddMonths(start, 1);
  return n ? rcAddDays(first, n * RC_CYCLE_DAYS) : first;
}
const rcCyclePeriod = (c, n) => ({ from: n ? rcCycleDate(c, n - 1) : rcStart(c), to: rcAddDays(rcCycleDate(c, n), -1) });
// The next payment this client owes. Someone who was with us before
// receipts moved into the CRM starts from the one that's due now.
function rcNextCycle(c){
  if (!rcStart(c)) return null;
  const done = rcRecordsOf(c).filter(r => ["paid", "sent"].includes(r.status) && Number.isInteger(r.cycle)).map(r => r.cycle);
  if (done.length) return Math.max(...done) + 1;
  const cutoff = rcAddDays(localDayStr(), -3);
  let n = 0;
  while (rcCycleDate(c, n) < cutoff && n < 500) n++;
  return n;
}
function rcNextDue(c){
  const n = rcNextCycle(c);
  return n == null ? null : { cycle: n, date: rcCycleDate(c, n), ...rcCyclePeriod(c, n) };
}
function rcContact(c){
  const b = rcBilling(c);
  const deal = c.source_deal_id ? state.deals.find(d => d.id === c.source_deal_id) : null;
  const contact = deal?.contact_id ? state.contacts.find(x => x.id === deal.contact_id) : null;
  return {
    name: b.contact || (contact?.name || (deal?.contact_name || "").split(" - ")[0] || "").trim(),
    email: b.email || c.email || c.report_email || contact?.email || "",
    address: b.address || "",
  };
}
function rcNextSeq(){
  const used = rcAll().map(({ r }) => Number(r.seq) || 0);
  return Math.max(Number(rcSettings.next) || 1, used.length ? Math.max(...used) + 1 : 1);
}

/* Our business details */
const RC_SETTINGS_KEY = "billing_settings";
let rcSettings = {}, rcSettingsLoaded = false;
function rcBusiness(){
  // Gaps are filled from the most recent receipt anyone made.
  const latest = rcAll().map(x => x.r).filter(r => r.business).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))[0];
  const from = latest?.business || {};
  const pick = (k) => rcSettings[k] || from[k] || "";
  return { name: pick("name"), gst: pick("gst"), nzbn: pick("nzbn"), address: pick("address"), email: pick("email"), phone: pick("phone"), website: pick("website") || "mrpriceless.com" };
}
const rcIncluded = () => (Array.isArray(rcSettings.included) && rcSettings.included.length) ? rcSettings.included
  : (rcAll().map(x => x.r).filter(r => r.included?.length).sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))[0]?.included || RC_INCLUDED);
async function rcLoadSettings(){
  if (IS_CONFIGURED && !state.user) return;
  rcSettingsLoaded = true;
  try {
    if (IS_CONFIGURED){
      const { data } = await supabase.from("user_widget_state").select("data").eq("user_id", state.user.id).eq("widget", RC_SETTINGS_KEY).maybeSingle();
      rcSettings = data?.data || {};
    } else rcSettings = JSON.parse(localStorage.getItem("mp_" + RC_SETTINGS_KEY) || "{}");
  } catch(e){ rcSettings = {}; }
  renderReceipts();
}
async function rcSaveSettings(next){
  rcSettings = next;
  try {
    if (IS_CONFIGURED) await supabase.from("user_widget_state").upsert({ user_id: state.user.id, widget: RC_SETTINGS_KEY, data: next, updated_at: new Date().toISOString() });
    else localStorage.setItem("mp_" + RC_SETTINGS_KEY, JSON.stringify(next));
  } catch(e){ console.error(e); }
  renderReceipts();
}

async function rcSaveClient(clientId, patch){
  const c = state.clients.find(x => x.id === clientId);
  if (!c) return;
  const progress = { ...(c.onboarding_progress || {}), ...patch };
  c.onboarding_progress = progress;
  await DataLayer.update("clients", c.id, { onboarding_progress: progress });
}
async function rcPut(clientId, rec){
  const c = state.clients.find(x => x.id === clientId);
  const list = rcRecordsOf(c).filter(r => r.id !== rec.id);
  list.push(rec);
  list.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  await rcSaveClient(clientId, { invoices: list });
}
const rcFind = (id) => rcAll().find(x => x.r.id === id) || null;
const rcAvatar = (c) => `<span class="rc-avatar">${escapeHtml((c.name || "?").trim().charAt(0).toUpperCase())}</span>`;
const RC_ICONS = {
  down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>`,
  mail: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>`,
  tick: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
};

/* The page */
function renderReceipts(){
  const hero = $("#rc-hero-value");
  if (!hero) return;
  if (!rcSettingsLoaded) rcLoadSettings();
  const today = localDayStr(), soon = rcAddDays(today, RC_SOON_DAYS);
  const clients = state.clients.filter(rcIsBillable).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const all = rcAll();
  const paid = all.filter(x => rcIsPaid(x.r));
  const ym = today.slice(0, 7);
  const lastYm = (() => { const d = new Date(today + "T00:00:00"); d.setDate(1); d.setMonth(d.getMonth() - 1); return localDayStr(d).slice(0, 7); })();
  const sumOf = (list) => list.reduce((s, x) => s + rcTotal(x.r), 0);
  const thisMonth = paid.filter(x => rcPaidDay(x.r).slice(0, 7) === ym), lastMonth = paid.filter(x => rcPaidDay(x.r).slice(0, 7) === lastYm);
  const active = clients.filter(rcActive);
  const monthly = active.reduce((s, c) => s + rcFee(c), 0) * (1 + RC_GST);
  const upcoming = active.map(c => ({ c, next: rcNextDue(c) })).filter(x => x.next && x.next.date <= soon).sort((a, b) => a.next.date.localeCompare(b.next.date));
  const week = upcoming.filter(x => x.next.date <= rcAddDays(today, 7));
  const dueNow = upcoming.filter(x => x.next.date <= today).length;
  const monthName = new Date().toLocaleDateString("en-NZ", { month: "long" });
  const lastName = new Date(lastYm + "-01T00:00:00").toLocaleDateString("en-NZ", { month: "long" });

  $("#rc-hero-title").textContent = `Collected in ${monthName}`;
  hero.textContent = rcMoney(sumOf(thisMonth));
  $("#rc-hero-sub").textContent = `${thisMonth.length} receipt${thisMonth.length === 1 ? "" : "s"} sent · ${rcMoney(sumOf(lastMonth))} in ${lastName}`;
  $("#rc-hero-stats").innerHTML = [
    ["Due this week", rcMoney(week.reduce((s, x) => s + rcFee(x.c) * (1 + RC_GST), 0)), week.length ? `${week.length} payment${week.length === 1 ? "" : "s"}${dueNow ? ` · ${dueNow} due now` : ""}` : "nothing due", dueNow ? "warn" : ""],
    ["Monthly billing", rcMoney(monthly), `incl. GST · ${active.length} client${active.length === 1 ? "" : "s"}`, ""],
    ["Receipts sent", String(paid.length), `this year ${paid.filter(x => rcPaidDay(x.r).slice(0, 4) === today.slice(0, 4)).length}`, ""],
  ].map(([l, v, s, cls]) => `<div class="rc-stat ${cls}"><span>${escapeHtml(l)}</span><b>${escapeHtml(v)}</b><small>${escapeHtml(s)}</small></div>`).join("");
  const navCount = $("#nav-rc-count");
  if (navCount){ navCount.hidden = !dueNow; navCount.textContent = dueNow; }

  const biz = rcBusiness(), setup = $("#rc-setup");
  if (setup){
    setup.hidden = !!(biz.name && biz.gst);
    setup.innerHTML = `<span class="rc-setup-icon">!</span><div><b>Add your business details</b><span>Your legal name and GST number make each receipt a valid tax invoice.</span></div><button type="button" class="btn gold sm" data-action="rc-settings">Add details</button>`;
  }

  // Up next
  $("#rc-next").innerHTML = upcoming.length ? upcoming.map(({ c, next }) => {
    const days = rcDaysBetween(today, next.date);
    const when = days < 0 ? `${-days} day${days === -1 ? "" : "s"} overdue` : days === 0 ? "Due today" : days === 1 ? "Due tomorrow" : `Due in ${days} days`;
    const draft = rcRecordsOf(c).find(r => !rcIsPaid(r) && r.status !== "void" && r.cycle === next.cycle);
    return `<article class="rc-card ${days <= 0 ? "is-due" : ""}">
      <div class="rc-card-top">${rcAvatar(c)}<div class="rc-card-id"><b>${escapeHtml(c.name)}</b><span>Payment ${next.cycle + 1} · ${escapeHtml(rcPeriodLabel(next.from, next.to))}</span></div></div>
      <div class="rc-card-amount">${rcMoney(rcFee(c) * (1 + RC_GST))}<small>incl. GST</small></div>
      <div class="rc-card-foot">
        <span class="rc-chip ${days < 0 ? "late" : days === 0 ? "now" : ""}">${escapeHtml(when)} · ${escapeHtml(rcShort(next.date))}</span>
        <button type="button" class="btn gold sm" data-action="${draft ? "rc-edit" : "rc-create"}" data-id="${draft ? draft.id : c.id}">Record payment</button>
      </div>
    </article>`;
  }).join("") : `<div class="rc-empty">${(() => {
      const nxt = active.map(c => ({ c, n: rcNextDue(c) })).filter(x => x.n).sort((a, b) => a.n.date.localeCompare(b.n.date))[0];
      return nxt ? `Nothing due in the next two weeks. Next up is <b>${escapeHtml(nxt.c.name)}</b> on ${escapeHtml(rcShort(nxt.n.date))}.` : "No payments coming up. Set each client's monthly fee under Clients &amp; billing below.";
    })()}</div>`;

  // Receipts list
  const fc = $("#rc-filter-client");
  if (fc){
    const keep = fc.value;
    fc.innerHTML = `<option value="">All clients</option>` + state.clients.filter(c => rcRecordsOf(c).length).sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
    fc.value = keep;
  }
  const rows = all.filter(x => x.r.status !== "void" && (!fc?.value || x.c.id === fc.value))
    .sort((a, b) => rcPaidDay(b.r).localeCompare(rcPaidDay(a.r)) || (Number(b.r.seq) || 0) - (Number(a.r.seq) || 0));
  $("#rc-list-sub").textContent = rows.length ? `${rows.length} receipt${rows.length === 1 ? "" : "s"} · ${rcMoney(sumOf(rows.filter(x => rcIsPaid(x.r))))} received` : "Every receipt sent, newest first.";
  $("#rc-list").innerHTML = rows.length ? rows.map(({ r, c }) => {
    const ok = rcIsPaid(r);
    return `<article class="rc-row ${ok ? "" : "is-unpaid"}">
      <span class="rc-row-icon">${ok ? RC_ICONS.tick : "!"}</span>
      <div class="rc-row-id"><b>${escapeHtml(c.name)}</b><span>${escapeHtml(rcNumberOf(r))}${r.from ? ` · ${escapeHtml(rcPeriodLabel(r.from, r.to))}` : ""}</span></div>
      <div class="rc-row-meta">${ok ? `<b>${escapeHtml(rcShort(rcPaidDay(r)))}</b><span>${escapeHtml(r.paid_method || "Card")}</span>` : `<b>Not paid yet</b><span>from before receipts</span>`}</div>
      <div class="rc-row-amount">${rcMoney(rcTotal(r))}</div>
      <div class="rc-row-actions">
        ${ok ? `<button type="button" class="rc-icon-btn" data-action="rc-pdf" data-id="${r.id}" title="Download PDF" aria-label="Download PDF">${RC_ICONS.down}</button>
        <button type="button" class="rc-icon-btn" data-action="rc-email" data-id="${r.id}" title="Email receipt" aria-label="Email receipt">${RC_ICONS.mail}</button>` : ""}
        <button type="button" class="rc-icon-btn" data-action="rc-edit" data-id="${r.id}" title="${ok ? "Edit" : "Record payment"}" aria-label="Edit">${ICONS.edit}</button>
        <button type="button" class="rc-icon-btn" data-action="rc-delete" data-id="${r.id}" title="Delete" aria-label="Delete">${ICONS.trash}</button>
      </div>
    </article>`;
  }).join("") : `<div class="rc-empty">${all.length ? "No receipts for that client yet." : "No receipts yet. Record a payment from Up next and the receipt lands here."}</div>`;

  // Clients & billing
  $("#rc-clients").innerHTML = clients.length ? clients.map(c => {
    const b = rcBilling(c), fee = rcFee(c), next = rcNextDue(c), ct = rcContact(c);
    const status = b.paused ? `<span class="rc-chip muted">Paused</span>` : !(fee > 0) ? `<span class="rc-chip late">Fee not set</span>` : next ? `<span class="rc-chip">Next ${escapeHtml(rcShort(next.date))}</span>` : "";
    return `<article class="rc-client ${b.paused ? "is-paused" : ""}">
      <div class="rc-card-top">${rcAvatar(c)}<div class="rc-card-id"><b>${escapeHtml(c.name)}</b><span>${escapeHtml(ct.email || "No email yet")}</span></div></div>
      <dl class="rc-client-facts">
        <div><dt>Monthly fee</dt><dd>${fee > 0 ? `${rcMoney(fee)} <small>+ GST</small>` : "-"}</dd></div>
        <div><dt>Started</dt><dd>${escapeHtml(rcShort(rcStart(c)) || "-")}</dd></div>
      </dl>
      <div class="rc-card-foot">${status}<button type="button" class="btn ghost sm" data-action="rc-billing" data-id="${c.id}">Edit</button></div>
    </article>`;
  }).join("") : `<div class="rc-empty">No clients yet.</div>`;
}

/* The receipt editor */
let rcEditing = null;
function rcLineRow(it = {}){
  return `<div class="rc-line" ${it.auto ? 'data-auto="1"' : ""}>
    <input type="text" class="rc-l-desc" placeholder="Description" value="${escapeHtml(it.desc || "")}" aria-label="Description">
    <input type="text" class="rc-l-sub" placeholder="Detail, e.g. the service period" value="${escapeHtml(it.sub || "")}" aria-label="Detail">
    <input type="number" class="rc-l-qty" min="0" step="1" value="${it.qty ?? 1}" aria-label="Quantity">
    <input type="number" class="rc-l-unit" min="0" step="0.01" placeholder="0.00" value="${it.unit ?? ""}" aria-label="Price excl. GST">
    <span class="rc-l-amt"></span>
    <button type="button" class="rc-icon-btn" data-action="rc-remove-line" title="Remove line" aria-label="Remove line">${ICONS.trash}</button>
  </div>`;
}
const rcPeriodSub = () => { const l = rcPeriodLabel($("#rc-from").value, $("#rc-to").value); return l ? `Service period ${l}` : ""; };
function rcReadForm(){
  const items = $$("#rc-items .rc-line").map(row => ({
    desc: row.querySelector(".rc-l-desc").value.trim(), sub: row.querySelector(".rc-l-sub").value.trim(),
    qty: Number(row.querySelector(".rc-l-qty").value) || 0, unit: Number(row.querySelector(".rc-l-unit").value) || 0,
    ...(row.dataset.auto ? { auto: true } : {}),
  })).filter(it => it.desc || it.unit);
  return {
    clientId: $("#rc-client").value, number: $("#rc-number").value.trim(), paid: $("#rc-paid-date").value,
    method: $("#rc-method").value, reference: $("#rc-reference").value.trim(),
    from: $("#rc-from").value || null, to: $("#rc-to").value || null,
    contact: $("#rc-contact").value.trim(), email: $("#rc-email").value.trim(), items, notes: $("#rc-notes").value.trim(),
  };
}
function rcRenderTotals(){
  $$("#rc-items .rc-line").forEach(row => {
    row.querySelector(".rc-l-amt").textContent = rcMoney((Number(row.querySelector(".rc-l-qty").value) || 0) * (Number(row.querySelector(".rc-l-unit").value) || 0));
  });
  const t = window.MPReceiptPDF.totals(rcReadForm().items, RC_GST);
  $("#rc-totals").innerHTML = `<div><span>Subtotal</span><b>${rcMoney(t.subtotal)}</b></div><div><span>GST 15%</span><b>${rcMoney(t.gst)}</b></div><div class="rc-total"><span>Total paid</span><b>${rcMoney(t.total)}</b></div>`;
}
function rcRenderIncluded(list){
  $("#rc-included").innerHTML = `<div class="rc-included-head">What's included <button type="button" class="link-btn" data-action="rc-settings">Edit</button></div>` +
    `<ul>${list.map(s => `<li>${RC_ICONS.tick}<span>${escapeHtml(s)}</span></li>`).join("")}</ul>`;
}
const rcFeeLine = (c) => ({ desc: "Monthly management fee", sub: rcPeriodSub(), qty: 1, unit: rcFee(c) || "", auto: true });
function openReceiptEditor(clientId, recId){
  const found = recId ? rcFind(recId) : null;
  const rec = found?.r || null;
  const c = found?.c || state.clients.find(x => x.id === clientId) || null;
  const next = c && !rec ? rcNextDue(c) : null;
  rcEditing = { rec, cycle: rec ? rec.cycle : next ? next.cycle : null, included: rec?.included?.length ? rec.included : rcIncluded() };
  const sel = $("#rc-client");
  sel.innerHTML = `<option value="">Pick a client</option>` + state.clients.filter(x => rcIsBillable(x) || x.id === c?.id).sort((a, b) => (a.name || "").localeCompare(b.name || "")).map(x => `<option value="${x.id}">${escapeHtml(x.name)}</option>`).join("");
  sel.value = c?.id || ""; sel.disabled = !!rec;
  $("#rc-id").value = rec?.id || "";
  $("#rc-number").value = rec ? rcNumberOf(rec) : rcNum(rcNextSeq());
  $("#rc-paid-date").value = rec && rcIsPaid(rec) ? rcPaidDay(rec) : localDayStr();
  $("#rc-method").value = rec?.paid_method || "Card (Stripe)";
  $("#rc-reference").value = rec?.reference || "";
  $("#rc-from").value = rec?.from || next?.from || "";
  $("#rc-to").value = rec?.to || next?.to || "";
  const ct = c ? rcContact(c) : {};
  $("#rc-contact").value = rec?.contact ?? ct.name ?? "";
  $("#rc-email").value = rec?.email ?? ct.email ?? "";
  $("#rc-notes").value = rec?.notes || "";
  $("#rc-items").innerHTML = (rec?.items?.length ? rec.items : c ? [rcFeeLine(c)] : [{}]).map(rcLineRow).join("");
  $("#rc-modal-title").textContent = rec ? `Edit ${rcNumberOf(rec)}` : c ? `Receipt for ${c.name}` : "New receipt";
  $("#rc-save").textContent = rec && rcIsPaid(rec) ? "Save & send again" : "Save & send receipt";
  rcStatusMsg("");
  rcRenderIncluded(rcEditing.included);
  rcRenderTotals();
  openModal("rc-modal");
}
function rcStatusMsg(msg, warn){ const el = $("#rc-status"); if (el){ el.textContent = msg; el.classList.toggle("warn", !!warn); } }
async function rcSaveForm(){
  const f = rcReadForm();
  if (!f.clientId) return rcStatusMsg("Pick a client first.", true), null;
  if (!f.items.length) return rcStatusMsg("Add at least one line.", true), null;
  if (!f.paid) return rcStatusMsg("Add the date they paid.", true), null;
  const clash = rcAll().find(x => rcNumberOf(x.r) === f.number && x.r.id !== $("#rc-id").value);
  if (clash) return rcStatusMsg(`${f.number} is already used for ${clash.c.name}. Pick another number.`, true), null;
  const old = rcEditing?.rec;
  const seq = Number((f.number.match(/(\d+)\s*$/) || [])[1]) || rcNextSeq();
  const now = new Date().toISOString();
  const rec = {
    ...(old || {}), id: old?.id || (crypto.randomUUID ? crypto.randomUUID() : "rc-" + Date.now()),
    seq, number: f.number, receipt_number: f.number, cycle: rcEditing?.cycle ?? null,
    date: f.paid, paid_at: f.paid, paid_method: f.method, reference: f.reference, from: f.from, to: f.to,
    contact: f.contact, email: f.email, address: old?.address ?? rcContact(state.clients.find(x => x.id === f.clientId)).address,
    items: f.items, included: rcEditing.included, gst_rate: RC_GST, notes: f.notes, status: "paid",
    created_at: old?.created_at || now, issued_at: old?.issued_at || localDayStr(), business: rcBusiness(),
  };
  await rcPut(f.clientId, rec);
  // Remember the contact details for next time.
  const c = state.clients.find(x => x.id === f.clientId), b = rcBilling(c);
  const keep = { ...b, ...(f.email ? { email: f.email } : {}), ...(f.contact ? { contact: f.contact } : {}) };
  if (JSON.stringify(keep) !== JSON.stringify(b)) await rcSaveClient(f.clientId, { billing: keep });
  if (rcSettings.next && seq >= Number(rcSettings.next)) await rcSaveSettings({ ...rcSettings, next: seq + 1 });
  rcEditing.rec = rec;
  return rec;
}
function rcPdfData(r, c){
  return {
    number: rcNumberOf(r), issuedLabel: rcLong(r.issued_at || rcPaidDay(r)), paidLabel: rcLong(rcPaidDay(r)),
    paidMethod: r.paid_method || "Card (Stripe)", reference: r.reference || "", periodLabel: rcPeriodLabel(r.from, r.to),
    business: { ...rcBusiness(), ...(r.business || {}) }, client: { name: c.name, contact: r.contact, email: r.email, address: r.address },
    items: r.items, included: r.included?.length ? r.included : rcIncluded(), gstRate: r.gst_rate ?? RC_GST, notes: r.notes,
  };
}
let rcLastUrl = null, rcLastName = "";
async function rcMakePdf(r, c, opts = {}){
  await wpLoadLibs();
  const bytes = await window.MPReceiptPDF.build(rcPdfData(r, c));
  if (rcLastUrl) URL.revokeObjectURL(rcLastUrl);
  rcLastUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  rcLastName = `Mr Priceless Receipt ${rcNumberOf(r)} - ${(c.name || "Client").replace(/[\\/:*?"<>|]+/g, "")}.pdf`;
  if (opts.download !== false){
    const a = document.createElement("a"); a.href = rcLastUrl; a.download = rcLastName; document.body.appendChild(a); a.click(); a.remove();
  }
  return rcLastUrl;
}
function rcEmail(r){
  const first = (r.contact || "").split(/\s+/)[0] || "there";
  const person = window.getActivePerson ? window.getActivePerson() : null;
  const sender = rcSettings.sender || ASSIGNEES[person]?.label || "The Mr Priceless team";
  const period = rcPeriodLabel(r.from, r.to);
  return {
    subject: `Your Mr Priceless receipt ${rcNumberOf(r)}`,
    body: `Hi ${first},\n\nThanks for your payment of ${rcMoney(rcTotal(r))} on ${rcLong(rcPaidDay(r))}${period ? ` for ${period}` : ""}. Your receipt is attached - it's also your tax invoice, so keep it for your records.\n\nAny questions, just reply to this email.\n\nCheers,\n${sender}\nMr Priceless`,
  };
}
async function openReceiptSend(recId){
  const found = rcFind(recId);
  if (!found) return;
  const { r, c } = found;
  await rcMakePdf(r, c);
  const mail = rcEmail(r);
  rcEditing = { ...(rcEditing || {}), sendId: recId };
  $("#rc-send-title").textContent = `Send ${rcNumberOf(r)} to ${c.name}`;
  const link = $("#rc-file"); link.href = rcLastUrl; link.download = rcLastName;
  $("#rc-file-name").textContent = rcLastName;
  $("#rc-mail-to").value = r.email || "";
  $("#rc-mail-subject").value = mail.subject;
  $("#rc-mail-body").value = mail.body;
  openModal("rc-send-modal");
}
async function rcNoteSent(){
  const found = rcEditing?.sendId && rcFind(rcEditing.sendId);
  if (found && !found.r.sent_at) await rcPut(found.c.id, { ...found.r, sent_at: new Date().toISOString() });
}
function openReceiptBilling(clientId){
  const c = state.clients.find(x => x.id === clientId);
  if (!c) return;
  const b = rcBilling(c), ct = rcContact(c), deal = clientRetainer(c);
  $("#rc-bill-id").value = c.id;
  $("#rc-billing-title").textContent = `Billing for ${c.name}`;
  $("#rc-bill-start").value = rcStart(c) || "";
  $("#rc-bill-fee").value = b.fee ?? (deal ?? "");
  $("#rc-bill-fee-hint").textContent = deal != null ? `Their deal says ${rcMoney(deal)}/mo.` : "Not on their deal yet.";
  $("#rc-bill-contact").value = ct.name;
  $("#rc-bill-email").value = ct.email;
  $("#rc-bill-address").value = b.address || "";
  $("#rc-bill-paused").checked = !!b.paused;
  openModal("rc-billing-modal");
}

function setupReceipts(){
  if (!$("#page-receipts")) return;
  document.addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-action^='rc-']");
    if (!btn) return;
    const id = btn.dataset.id, action = btn.dataset.action;
    try {
      if (action === "rc-new") openReceiptEditor(null, null);
      else if (action === "rc-create") openReceiptEditor(id, null);
      else if (action === "rc-edit") openReceiptEditor(null, id);
      else if (action === "rc-billing") openReceiptBilling(id);
      else if (action === "rc-email") await openReceiptSend(id);
      else if (action === "rc-pdf"){ const f = rcFind(id); if (f) await rcMakePdf(f.r, f.c); }
      else if (action === "rc-delete"){
        const f = rcFind(id);
        if (f && confirm(`Delete ${rcNumberOf(f.r)} for ${f.c.name}? This can't be undone.`)) await rcSaveClient(f.c.id, { invoices: rcRecordsOf(f.c).filter(r => r.id !== id) });
      }
      else if (action === "rc-settings"){
        const b = rcBusiness();
        ["name", "gst", "nzbn", "phone", "email", "website", "address"].forEach(k => { $("#rc-set-" + k).value = b[k] || ""; });
        $("#rc-set-included").value = rcIncluded().join("\n");
        $("#rc-set-sender").value = rcSettings.sender || "";
        $("#rc-set-next").value = rcNextSeq();
        openModal("rc-settings-modal");
      }
      else if (action === "rc-add-fee"){
        const c = state.clients.find(x => x.id === $("#rc-client").value);
        $("#rc-items").insertAdjacentHTML("beforeend", rcLineRow(c ? rcFeeLine(c) : { desc: "Monthly management fee", sub: rcPeriodSub(), qty: 1, auto: true }));
        rcRenderTotals();
      }
      else if (action === "rc-add-line"){ $("#rc-items").insertAdjacentHTML("beforeend", rcLineRow({})); $("#rc-items .rc-line:last-child .rc-l-desc")?.focus(); rcRenderTotals(); }
      else if (action === "rc-remove-line"){ btn.closest(".rc-line")?.remove(); rcRenderTotals(); }
    } catch(err){ console.error(err); alert("Something went wrong: " + (err.message || err)); }
  });
  $("#rc-filter-client")?.addEventListener("change", renderReceipts);

  const form = $("#rc-form");
  form?.addEventListener("input", (e) => {
    if (e.target.closest(".rc-line") && !e.target.matches(".rc-l-qty,.rc-l-unit")) e.target.closest(".rc-line").removeAttribute("data-auto");
    rcRenderTotals();
  });
  form?.addEventListener("change", (e) => {
    if (e.target.id === "rc-client"){
      const c = state.clients.find(x => x.id === e.target.value);
      if (!c) return;
      const next = rcNextDue(c), ct = rcContact(c);
      if (next){ $("#rc-from").value = next.from; $("#rc-to").value = next.to; rcEditing.cycle = next.cycle; }
      $("#rc-contact").value = ct.name; $("#rc-email").value = ct.email;
      $("#rc-items").innerHTML = rcLineRow(rcFeeLine(c));
      $("#rc-modal-title").textContent = `Receipt for ${c.name}`;
      rcRenderTotals();
    }
    if (e.target.id === "rc-from" || e.target.id === "rc-to")
      $$("#rc-items .rc-line[data-auto] .rc-l-sub").forEach(i => { i.value = rcPeriodSub(); });
  });
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#rc-save"); btn.disabled = true;
    try {
      const rec = await rcSaveForm();
      if (!rec) return;
      closeModal("rc-modal");
      await openReceiptSend(rec.id);
    } catch(err){ console.error(err); rcStatusMsg("Couldn't make the receipt: " + (err.message || err), true); }
    finally { btn.disabled = false; }
  });
  $("#rc-preview")?.addEventListener("click", async () => {
    const f = rcReadForm(), c = state.clients.find(x => x.id === f.clientId);
    if (!c) return rcStatusMsg("Pick a client first.", true);
    const w = window.open("", "_blank");
    try {
      const r = { ...(rcEditing?.rec || {}), ...f, receipt_number: f.number, paid_at: f.paid, paid_method: f.method, included: rcEditing.included, gst_rate: RC_GST,
        address: rcEditing?.rec?.address ?? rcContact(c).address, issued_at: rcEditing?.rec?.issued_at || localDayStr() };
      const url = await rcMakePdf(r, c, { download: false });
      if (w) w.location = url; else window.open(url, "_blank");
    } catch(err){ if (w) w.close(); rcStatusMsg("Couldn't make the preview: " + (err.message || err), true); }
  });

  const mail = () => ({ to: $("#rc-mail-to").value.trim(), su: $("#rc-mail-subject").value, body: $("#rc-mail-body").value });
  $("#rc-mail-gmail")?.addEventListener("click", () => {
    const m = mail();
    window.open(`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(m.to)}&su=${encodeURIComponent(m.su)}&body=${encodeURIComponent(m.body)}`, "_blank");
    rcNoteSent();
  });
  $("#rc-mail-app")?.addEventListener("click", () => {
    const m = mail();
    window.location.href = `mailto:${encodeURIComponent(m.to)}?subject=${encodeURIComponent(m.su)}&body=${encodeURIComponent(m.body)}`;
    rcNoteSent();
  });
  $("#rc-mail-copy")?.addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText(mail().body); e.target.textContent = "Copied"; setTimeout(() => { e.target.textContent = "Copy email"; }, 1600); } catch(err){}
    rcNoteSent();
  });
  $("#rc-file")?.addEventListener("dragstart", (e) => {
    if (!rcLastUrl) return;
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("DownloadURL", `application/pdf:${rcLastName}:${rcLastUrl}`);
  });

  $("#rc-settings-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = (k) => $("#rc-set-" + k).value.trim();
    const included = $("#rc-set-included").value.split("\n").map(s => s.trim()).filter(Boolean);
    await rcSaveSettings({ ...rcSettings, name: v("name"), gst: v("gst"), nzbn: v("nzbn"), phone: v("phone"), email: v("email"), website: v("website"),
      address: $("#rc-set-address").value.trim(), included, sender: v("sender"), next: Number(v("next")) || undefined });
    if (rcEditing && $("#rc-modal").classList.contains("visible") && !rcEditing.rec){ rcEditing.included = rcIncluded(); rcRenderIncluded(rcEditing.included); }
    closeModal("rc-settings-modal");
  });
  $("#rc-billing-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const c = state.clients.find(x => x.id === $("#rc-bill-id").value);
    if (!c) return;
    const fee = $("#rc-bill-fee").value;
    await rcSaveClient(c.id, { billing: { ...rcBilling(c), start: $("#rc-bill-start").value || null, fee: fee === "" ? null : Number(fee),
      contact: $("#rc-bill-contact").value.trim(), email: $("#rc-bill-email").value.trim(), address: $("#rc-bill-address").value.trim(), paused: $("#rc-bill-paused").checked } });
    closeModal("rc-billing-modal");
  });
}

/* ───────── Jarvis ─────────
   The CRM's assistant (supabase/functions/jarvis). A button on every page
   opens his panel: chat on one tab, what he's learned on the other. */
let jvLoaded = false, jvBusy = false, jvSimple = false;
async function jarvisCall(body){
  if (!IS_CONFIGURED) return { error: "demo" };
  const { data, error } = await supabase.functions.invoke("jarvis", { body });
  if (error){
    let msg = error.message || "Couldn't reach Jarvis.";
    try { const j = await error.context?.json?.(); if (j?.error) msg = j.error; } catch(e){}
    return { error: msg };
  }
  return data || {};
}
/* Jarvis without an AI key: answers straight from the CRM's own data in the
   browser - cost per quote, who's at risk, what's working in the ads, the
   pipeline, any client by name - and writes ad copy from templates built on
   the winning ads. The AI version (the jarvis function) takes over by itself
   once a key is added. */
const jvMoney = (v) => v == null || !isFinite(v) ? "-" : fmtMoney(v);
function jvTopAds(n = 3){
  return state.adCreatives.filter(a => a.result !== "engagement" && Number(a.results) > 0 && Number(a.cost_per_result) > 0)
    .sort((a, b) => Number(a.cost_per_result) - Number(b.cost_per_result)).slice(0, n);
}
const jvClientName = (a) => state.clients.find(c => c.id === a.client_id)?.name || a.client_name || "a client";
function jvCpq(){
  const rows = state.clients.map(clientPerformance).filter(r => r.spend && r.quotes).map(r => ({ ...r, cpq: r.spend / r.quotes }))
    .sort((a, b) => a.cpq - b.cpq);
  if (!rows.length) return "Hi Master. No cost per quote yet - need ad spend and quotes (from GHL or a report) on at least one client.";
  const line = (r) => `- **${r.c.name}** - ${jvMoney(r.cpq)} a quote (${r.quotes} quotes off ${jvMoney(r.spend)})`;
  const best = rows.slice(0, 3), worst = rows.length > 3 ? rows.slice(-2).reverse() : [];
  return `Hi Master. Cheapest quotes:\n${best.map(line).join("\n")}${worst.length ? `\n\nDearest:\n${worst.map(line).join("\n")}` : ""}\n\nFull breakdown by industry is in Creative → Statistics.`;
}
function jvRisk(){
  const out = [];
  state.clients.filter(c => c.stage !== "churned").forEach(c => {
    const why = [];
    if (c.churn_risk === "high") why.push("flagged high churn risk");
    else if (c.churn_risk === "medium") why.push("flagged medium churn risk");
    const reps = monthReportsFor(c.id), last = reps[reps.length - 1];
    if (c.ad_start_date && (!last || daysSince(last.period_end) > 21)) why.push(last ? `no report in ${Math.round(daysSince(last.period_end))} days` : "no report yet");
    const ads = state.adCreatives.filter(a => a.client_id === c.id && a.result !== "engagement");
    const spend = ads.reduce((s, a) => s + (Number(a.spend) || 0), 0), leads = ads.reduce((s, a) => s + (Number(a.results) || 0), 0);
    if (spend > 300 && leads && spend / leads > LOW_CPL_LIMIT) why.push(`leads costing ${jvMoney(spend / leads)}`);
    if (c.stage === "quote_guarantee" && (c.quotes_sent || 0) < (c.quote_target || 10) / 2 && daysSince(c.stage_changed_at || c.created_at) > 30) why.push(`only ${c.quotes_sent || 0}/${c.quote_target || 10} quotes after a month`);
    if (why.length) out.push({ c, why, score: why.length + (c.churn_risk === "high" ? 2 : 0) });
  });
  if (!out.length) return "Hi Master. Nobody's waving a red flag right now. Keep the reports and workshops going.";
  out.sort((a, b) => b.score - a.score);
  return `Hi Master. Watch these:\n${out.slice(0, 5).map(x => `- **${x.c.name}** - ${x.why.join(", ")}`).join("\n")}\n\nGet a call or workshop in with the top one this week.`;
}
function jvAds(){
  const top = jvTopAds(3);
  const fatiguing = state.adCreatives.filter(a => a.fatigue_status && a.fatigue_status !== "fresh" && ["active", "learning"].includes(a.delivery_status));
  const low = state.adCreatives.filter(a => a.result === "killed").length;
  if (!top.length) return "Hi Master. No ads with leads synced yet - sync a client's Meta account first.";
  return `Hi Master. Cheapest leads right now:\n${top.map(a => `- **${a.name}** (${jvClientName(a)}) - ${jvMoney(a.cost_per_result)} a lead, ${a.results} leads`).join("\n")}${fatiguing.length ? `\n\nFatiguing but still running: ${fatiguing.slice(0, 4).map(a => a.name).join(", ")}. Line up fresh creative.` : ""}\n\n${low} ad${low === 1 ? "" : "s"} sitting in Low performer. Test new hooks in the angles the winners use.`;
}
function jvPipeline(){
  const open = state.deals.filter(d => !CLOSED_STAGES.has(d.stage));
  const by = (k) => open.filter(d => d.stage === k).length;
  const stale = open.filter(d => daysSince(d.updated_at || d.created_at) > 14);
  const month = ymOf(localDayStr());
  const lostMonth = state.deals.filter(d => ["closed_lost", "ghosted"].includes(d.stage) && ymOf(d.stage_changed_at || d.updated_at) === month).length;
  const wonMonth = state.deals.filter(d => ["closed_won", ADHOC_STAGE].includes(d.stage) && ymOf(d.stage_changed_at || d.updated_at) === month).length;
  const mrr = open.filter(d => (d.contract_type || "retainer") === "retainer").reduce((s, d) => s + (Number(d.value) || 0), 0);
  return `Hi Master. ${open.length} open deal${open.length === 1 ? "" : "s"} worth ${jvMoney(mrr)}/mo.\n- Meetings booked: ${by("qualified")}\n- Proposal: ${by("proposal")} · Negotiation: ${by("negotiation")}\n- This month: ${wonMonth} won, ${lostMonth} lost or ghosted${stale.length ? `\n\nStuck (no update in 2+ weeks): ${stale.slice(0, 5).map(d => d.title || d.contact_name).join(", ")}. Chase them today.` : ""}`;
}
function jvClient(c){
  const r = clientPerformance(c), x = perfRatios(r);
  const stage = CLIENT_STAGES.find(s => s.key === c.stage)?.label || c.stage || "-";
  return `Hi Master. **${c.name}** - ${stage}${r.industry.name ? `, ${r.industry.name}` : ""}.\n- Ad spend ${jvMoney(r.spend)}, ${r.leads || 0} leads (${jvMoney(x.cpl)} each)\n- ${r.quotes} quotes, ${jvMoney(x.cpq)} a quote\n- ${r.jobs} jobs won, ${jvMoney(r.revenue)} revenue${x.roi ? ` (${fmtTimes(x.roi)} return)` : ""}${c.churn_risk ? `\n- Churn risk: ${c.churn_risk}` : ""}`;
}
function jvCopy(text){
  const top = jvTopAds(2);
  const inds = [...new Set(state.clients.map(c => clientIndustry(c).name).filter(Boolean))];
  // The trade they asked for, else the most common one among our clients.
  const asked = CLIENT_INDUSTRY_OPTIONS.find(i => text.toLowerCase().includes(i.toLowerCase())) || INDUSTRY_HINTS.find(([re]) => re.test(text))?.[1];
  const trade = (asked || inds[0] || "tradie").toLowerCase();
  const region = (text.match(/\b(auckland|wellington|christchurch|hamilton|tauranga|dunedin|north shore|waikato|bay of plenty)\b/i) || [])[0] || "your area";
  const hooks = [
    [`Still waiting on a ${trade} quote that never came?`, `We turn up when we say, quote on the spot and get it done right. Local, reviewed and booking now in ${region}.`, `Free quote this week`],
    [`${region}: 3 ${trade} slots left this month`, `Tell us what you need and we'll call you back within the hour with a straight price. No call-out fee for quotes.`, `Grab a slot`],
    [`The ${trade} job you've been putting off? Sorted in a day.`, `Fixed price before we start, tidy site when we leave. Over 100 five-star reviews from locals.`, `Get my price`],
    [`Why ${region} homeowners keep calling us back`, `On time, upfront pricing and work that lasts. See why our reviews do the talking.`, `See our work`],
    [`Don't pay for a ${trade} job twice.`, `Get it done properly the first time by a team that guarantees the work. Quotes in 24 hours.`, `Book a free quote`],
  ];
  return `Hi Master. Five to test for ${trade}${top.length ? `, built on the angle of your cheapest ad (“${top[0].name}”, ${jvMoney(top[0].cost_per_result)} a lead)` : ""}:\n\n${hooks.map((h, i) => `**${i + 1}. ${h[0]}**\n${h[1]}\nHeadline: ${h[2]}`).join("\n\n")}\n\nSwap in a real number (reviews, jobs done) wherever you can.`;
}
function jvOverview(){
  const rows = state.clients.map(clientPerformance), t = sumPerf(rows.filter(r => r.spend || r.quotes));
  const open = state.deals.filter(d => !CLOSED_STAGES.has(d.stage)).length;
  return `Hi Master. ${state.clients.length} clients, ${open} open deals.\n- Ad spend ${jvMoney(t.spend)} → ${t.leads} leads (${jvMoney(t.cpl)} each)\n- ${t.quotes} quotes at ${jvMoney(t.cpq)} each\n- ${jvMoney(t.revenue)} won for clients${t.roi ? `, ${fmtTimes(t.roi)} return` : ""}`;
}
function jvLocalReply(text){
  const t = text.toLowerCase();
  const client = state.clients.find(c => c.name && t.includes(c.name.toLowerCase().split(/\s+/).slice(0, 2).join(" ")));
  if (/\b(write|copy|hook|headline|caption|ad idea|ad concept|primary text)/.test(t)) return jvCopy(text);
  if (client) return jvClient(client);
  if (/cost per quote|\bcpq\b|per quote|cheapest quote/.test(t)) return jvCpq();
  if (/risk|churn|unhappy|lose|losing (a )?client/.test(t)) return jvRisk();
  if (/\bads?\b|creative|fatigu|cpl|cost per lead|working/.test(t)) return jvAds();
  if (/pipeline|deal|close|closing|lost|stuck|proposal/.test(t)) return jvPipeline();
  if (/overview|how are we|numbers|summary|doing|stats/.test(t)) return jvOverview();
  if (/^(hi|hey|yo|kia ora|gday|hello)\b/.test(t)) return "Hi Master. What do you need? Try cost per quote, who's at risk, what's working in the ads, the pipeline, a client's name, or ask me to write ad copy.";
  return "Hi Master. I'm running in simple mode for now, so I stick to what's in the CRM. Ask me about:\n- cost per quote\n- who's at risk\n- what's working in the ads\n- the pipeline\n- any client by name\n- write ad copy (say the trade and area)";
}
function jvBubble(role, text){
  const el = document.createElement("div");
  el.className = `jv-msg jv-${role}`;
  el.innerHTML = role === "assistant" ? renderPlaybookMarkdown(text).html : escapeHtml(text).replace(/\n/g, "<br>");
  if (role === "assistant"){
    const copy = document.createElement("button");
    copy.type = "button"; copy.className = "jv-copy"; copy.textContent = "Copy";
    copy.addEventListener("click", async () => { try { await navigator.clipboard.writeText(text); copy.textContent = "Copied"; setTimeout(() => { copy.textContent = "Copy"; }, 1400); } catch(e){} });
    el.appendChild(copy);
  }
  $("#jarvis-messages").appendChild(el);
  $("#jarvis-messages").scrollTop = $("#jarvis-messages").scrollHeight;
  return el;
}
function jvGreeting(){
  $("#jarvis-messages").innerHTML = "";
  jvBubble("assistant", "Hi Master. What do you need?");
}
async function jvLoadHistory(){
  if (jvLoaded) return;
  jvLoaded = true;
  jvGreeting();
  const r = await jarvisCall({ action: "history" });
  (r.messages || []).forEach(m => jvBubble(m.role, m.content));
  $("#jarvis-suggest").hidden = (r.messages || []).length > 0;
}
async function jvSend(text){
  text = String(text || "").trim();
  if (!text || jvBusy) return;
  jvBusy = true;
  $("#jarvis-suggest").hidden = true;
  jvBubble("user", text);
  $("#jarvis-text").value = ""; jvAutosize();
  const thinking = jvBubble("thinking", "");
  thinking.innerHTML = `<span class="jv-dots"><i></i><i></i><i></i></span> Jarvis is thinking...`;
  // Simple mode (answers from the CRM itself) until an AI key is set up,
  // and whenever the AI can't be reached.
  const r = jvSimple ? { error: "needs_key" } : await jarvisCall({ action: "chat", message: text });
  thinking.remove();
  if (r.error){
    if (r.error === "needs_key" || r.error === "demo") jvSimple = true;
    else console.warn("Jarvis AI unavailable, using simple mode:", r.error);
    await new Promise(res => setTimeout(res, 350));
    jvBubble("assistant", jvLocalReply(text));
  } else {
    jvBubble("assistant", r.reply || "");
    if (r.remembered) jvBubble("note", `Saved ${r.remembered} thing${r.remembered === 1 ? "" : "s"} to memory.`);
  }
  jvBusy = false;
}
function jvAutosize(){ const t = $("#jarvis-text"); if (!t) return; t.style.height = "auto"; t.style.height = Math.min(160, t.scrollHeight) + "px"; }
async function jvRenderMemory(){
  const list = $("#jarvis-mem-list");
  if (!IS_CONFIGURED){ list.innerHTML = `<div class="rc-empty">Memory works in the live CRM.</div>`; return; }
  const { data, error } = await supabase.from("jarvis_memory").select("id, content, kind, created_by, created_at").order("created_at", { ascending: false });
  if (error){ list.innerHTML = `<div class="rc-empty">Memory isn't set up yet (sql/057).</div>`; return; }
  list.innerHTML = (data || []).length ? data.map(m => `<div class="jv-mem">
      <span class="jv-mem-kind jv-k-${escapeHtml(m.kind)}">${escapeHtml(m.kind)}</span>
      <div><p>${escapeHtml(m.content)}</p><small>${escapeHtml((m.created_by || "").split("@")[0])} · ${escapeHtml(timeAgo(m.created_at))}</small></div>
      <button type="button" class="rc-icon-btn" data-jv-forget="${m.id}" title="Forget this" aria-label="Forget this">${ICONS.trash}</button>
    </div>`).join("") : `<div class="rc-empty">Nothing yet. Jarvis saves learnings as you chat, or add one above.</div>`;
}
function setupJarvis(){
  const panel = $("#jarvis-panel");
  if (!panel) return;
  const open = (on) => { panel.hidden = !on; document.body.classList.toggle("jv-open", on); if (on){ jvLoadHistory(); setTimeout(() => $("#jarvis-text")?.focus(), 50); } };
  $("#jarvis-fab").addEventListener("click", () => open(panel.hidden));
  $("#jarvis-close").addEventListener("click", () => open(false));
  $$(".jv-tab").forEach(t => t.addEventListener("click", () => {
    $$(".jv-tab").forEach(x => x.classList.toggle("active", x === t));
    const mem = t.dataset.jvTab === "memory";
    $("#jarvis-chat").hidden = mem; $("#jarvis-memory").hidden = !mem;
    if (mem) jvRenderMemory();
  }));
  $("#jarvis-form").addEventListener("submit", (e) => { e.preventDefault(); jvSend($("#jarvis-text").value); });
  $("#jarvis-text").addEventListener("input", jvAutosize);
  $("#jarvis-text").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey){ e.preventDefault(); jvSend(e.target.value); } });
  panel.addEventListener("click", async (e) => {
    const ask = e.target.closest("[data-jv-ask]");
    if (ask) jvSend(ask.dataset.jvAsk);
    const forget = e.target.closest("[data-jv-forget]");
    if (forget && confirm("Forget this?")){ await supabase.from("jarvis_memory").delete().eq("id", forget.dataset.jvForget); jvRenderMemory(); }
  });
  $("#jarvis-mem-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("#jarvis-mem-text").value.trim();
    if (!text || !IS_CONFIGURED) return;
    await supabase.from("jarvis_memory").insert({ content: text, kind: "preference", created_by: state.user?.email || null });
    $("#jarvis-mem-text").value = ""; jvRenderMemory();
  });
  $("#jarvis-clear").addEventListener("click", async () => {
    if (!confirm("Clear your conversation with Jarvis? What he's learned stays.")) return;
    await jarvisCall({ action: "clear" });
    jvLoaded = false; jvGreeting(); jvLoaded = true; $("#jarvis-suggest").hidden = false;
  });
  // Elsewhere in the CRM: "Ask Jarvis" buttons with a ready-made question.
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-ask-jarvis]");
    if (!b) return;
    open(true); $$(".jv-tab")[0].click();
    setTimeout(() => jvSend(b.dataset.askJarvis), 80);
  });
}
// Jarvis lives on the Creative Library only.
function showJarvisFab(){
  const f = $("#jarvis-fab"); if (!f) return;
  const here = state.page === "creative";
  f.hidden = !(state.user || !IS_CONFIGURED) || !here;
  if (!here && $("#jarvis-panel")){ $("#jarvis-panel").hidden = true; document.body.classList.remove("jv-open"); }
}

/* The Reporting page */
function renderReporting(){
  const list = $("#rp-client-list");
  if (!list) return;
  const clients = state.clients.filter(isActiveReportClient).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const infos = new Map(clients.map(c => [c.id, reportDueInfo(c)]));
  const due = clients.filter(c => infos.get(c.id).due);
  const thisYm = ymOf(localDayStr());
  // This month's revenue across clients: each client's latest report this month.
  const latestThisMonth = clients.map(c => monthReportsFor(c.id).filter(r => ymOf(r.period_end) === thisYm).pop()).filter(Boolean);
  const revenueMonth = latestThisMonth.reduce((s, r) => s + (Number(r.metrics.revenueMonth) || 0), 0);
  const rois = clients.map(c => infos.get(c.id).last?.metrics?.roiToDate).filter(v => v != null && isFinite(v));
  const kpis = $("#rp-kpis");
  if (kpis) kpis.innerHTML = `
    <div class="onb-kpi ${due.length ? "warn" : ""}"><span class="onb-kpi-label">Reports due</span><span class="onb-kpi-value">${due.length}</span><span class="onb-kpi-sub">${due.length ? "of " + clients.length + " active clients" : "all caught up"}</span></div>
    <div class="onb-kpi"><span class="onb-kpi-label">Revenue reported in ${escapeHtml(monthNameOf(localDayStr()))}</span><span class="onb-kpi-value">${fmtMoney(revenueMonth)}</span><span class="onb-kpi-sub">across ${latestThisMonth.length} client${latestThisMonth.length === 1 ? "" : "s"}</span></div>
    <div class="onb-kpi"><span class="onb-kpi-label">Average return to date</span><span class="onb-kpi-value">${rois.length ? fmtTimes(rois.reduce((a, b) => a + b, 0) / rois.length) : "-"}</span><span class="onb-kpi-sub">from each client's latest report</span></div>
    ${(() => { const qs = clients.map(clientQuoteStats).filter(q => q.quotes && q.spend); const spend = qs.reduce((a, q) => a + q.spend, 0), quotes = qs.reduce((a, q) => a + q.quotes, 0);
      return `<div class="onb-kpi"><span class="onb-kpi-label">Cost per quote</span><span class="onb-kpi-value">${quotes ? fmtMoney(spend / quotes) : "-"}</span><span class="onb-kpi-sub">${quotes ? `${quotes} quotes across ${qs.length} client${qs.length === 1 ? "" : "s"}, all-time` : "once reports are in"}</span></div>`; })()}`;
  if (!clients.length){ list.innerHTML = `<div class="card onb-empty"><div><h3>No active clients to report on</h3><p>Clients get reports once they've finished onboarding.</p></div></div>`; return; }
  const order = [...clients].sort((a, b) => (infos.get(b.id).due - infos.get(a.id).due) || (a.name || "").localeCompare(b.name || ""));
  list.innerHTML = order.map(c => {
    const info = infos.get(c.id), m = info.last?.metrics || {};
    const reps = monthReportsFor(c.id).slice().reverse();
    const target = toNum(m.quoteTarget) || c.quote_target || 10, got = toNum(m.quotesBooked) ?? (Number(c.quotes_sent) || 0);
    return `
      <article class="rp-row ${info.due ? "is-due" : ""}">
        <span class="onb-card-avatar">${escapeHtml((c.name || "?").trim().charAt(0).toUpperCase())}</span>
        <div class="rp-row-id">
          <div class="rp-row-name">${escapeHtml(c.name)}</div>
          <div class="rp-row-sub">${info.last ? `Last: report ${m.report_number || reps.length} · ${escapeHtml(fmtReportPeriod(info.last.period_start, info.last.period_end))}` : "No reports yet"}</div>
        </div>
        <div class="rp-row-stat"><span>Revenue to date</span><b>${info.last ? fmtMoney(m.revenueToDate) : "-"}</b></div>
        <div class="rp-row-stat"><span>Quotes</span><b>${got} / ${target}</b></div>
        <span class="onb-status ${info.due ? "client" : "track"}">${escapeHtml(info.label)}</span>
        <div class="rp-row-actions">
          ${reps.length ? `<select class="filter-select rp-past" data-client="${c.id}" aria-label="Past reports for ${escapeHtml(c.name)}"><option value="">Past reports (${reps.length})</option>${reps.map(r => `<option value="${r.id}">Report ${r.metrics.report_number || ""} · ${escapeHtml(fmtReportPeriod(r.period_start, r.period_end))}</option>`).join("")}</select>` : ""}
          <button type="button" class="btn gold sm" data-action="make-report" data-id="${c.id}">Make report</button>
        </div>
      </article>`;
  }).join("");
  ensureWeeklyCreativeSnapshot();
}
function setupReporting(){
  $("#report-form")?.addEventListener("input", (e) => {
    if (e.target.closest("#rp-ghl-connect")) return;
    rpRenderTotals();
  });
  $("#report-form")?.addEventListener("change", (e) => {
    if (e.target.id === "rp-to" && rpVal("to")){
      // The period always starts the day after the last report (or the start of the month).
      const c = state.clients.find(x => x.id === rpClientId);
      if (c){ rpSet("from", reportFrom(c.id, rpVal("to"), rpExisting?.id)); if (!rpExisting) rpApplyPrefill(c); }
      rpRenderTotals();
    }
  });
  $("#report-form")?.addEventListener("submit", (e) => { e.preventDefault(); makeReport(); });
  // Stage picks for GHL are remembered per client, then the numbers are pulled again.
  $("#rp-ghl-stages")?.addEventListener("change", async (e) => {
    const c = state.clients.find(x => x.id === rpClientId);
    if (!c || !e.target.matches("select")) return;
    const ghl_stages = { booked: $("#rp-ghl-booked")?.value || "", sent: $("#rp-ghl-sent")?.value || "" };
    c.onboarding_progress = { ...(c.onboarding_progress || {}), ghl_stages };
    await DataLayer.update("clients", c.id, { onboarding_progress: c.onboarding_progress });
    rpGhlPull();
  });
  $("#rp-client-list")?.addEventListener("change", (e) => {
    const sel = e.target.closest(".rp-past");
    if (!sel || !sel.value) return;
    const id = sel.value; sel.value = "";
    openReportModal(sel.dataset.client, id);
  });
  $("#rp-file")?.addEventListener("dragstart", (e) => {
    if (!rpLastUrl) return;
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("DownloadURL", `application/pdf:${rpLastName}:${rpLastUrl}`);
  });
  $("#rp-preview")?.addEventListener("click", () => { if (rpLastUrl) window.open(rpLastUrl, "_blank"); });
  $("#rp-edit")?.addEventListener("click", () => { $("#rp-done").hidden = true; $("#report-form").hidden = false; });
}
async function handleReportAction(action, id){
  if (action === "make-report"){ openReportModal(id); return true; }
  if (action === "make-plan"){ openPlanModal(id); return true; }
  if (action === "rp-ghl-pull"){ await rpGhlPull(); return true; }
  if (action === "rp-ghl-connect-show"){ $("#rp-ghl-connect").hidden = false; $("#rp-ghl-location")?.focus(); return true; }
  if (action === "rp-ghl-connect"){ await rpGhlConnect(); return true; }
  return false;
}

/* ───────── 90-day plans: a strategy document for the client ─────────
   Made from the Reporting page. Each plan is saved on the client in
   client.onboarding_progress.plans (no migration needed) and turned into a
   3-page PDF by js/plan-pdf.js. Starter text for each month means it never
   starts blank; the dates, check-ins and starting numbers fill themselves in. */
// Switched off for now: the 90-day plan is hidden everywhere. Saved plans are kept.
const PLANS_ENABLED = false;
const PLAN_DAYS = 90;
const PLAN_MONTHS = [
  { theme: "Launch & Learn", focus: "Get your ads live, find out what your customers respond to, and set a clear baseline for leads and cost.",
    actions: ["Launch 3 to 4 ad angles to find the winner", "Qualify every enquiry before it reaches you", "Track every lead through to quote and job"],
    milestone: "First quotes booked and a clear cost per lead", workshop: "marketing" },
  { theme: "Optimise", focus: "Double down on what's working and tighten the path from enquiry to booked quote.",
    actions: ["Move budget onto the best-performing ads", "Refresh creative before it wears out", "Sharpen follow-up so more enquiries become quotes"],
    milestone: "Quote guarantee met at a lower cost per lead", workshop: "sales" },
  { theme: "Scale", focus: "Grow the number of jobs coming in while protecting your margins.",
    actions: ["Scale budget on the proven ads", "Launch a fresh offer for the season ahead", "Review pricing and job mix for profit"],
    milestone: "A steady month of booked quotes and the next 90 days mapped out", workshop: "financial" },
];
const PLAN_NEEDS = ["Call new enquiries back within the hour where you can", "Send us photos and videos from recent jobs", "Let us know which quotes turn into jobs", "Ask every happy customer for a Google review"];
const PLAN_PROMISES = ["A clear report every fortnight on how the month is going", "A strategy workshop with you every month", "Your ads checked and tuned every week", "Every enquiry qualified before it reaches you"];
const PLAN_FIELDS = ["start", "goal", "s-enq", "t-enq", "s-quotes", "t-quotes", "s-rev", "t-rev",
  ...[1, 2, 3].flatMap(i => ["theme", "focus", "do1", "do2", "do3", "milestone", "ws"].map(k => `m${i}-${k}`)), "need1", "need2", "need3", "need4"];
const plansOf = (c) => [...((c.onboarding_progress || {}).plans || [])].sort((a, b) => String(a.start).localeCompare(String(b.start)));
const isPlanClient = (c) => (c.stage || "onboarding") !== "churned";
let plClientId = null, plExisting = null, plLastUrl = null, plLastName = "";
const plVal = (k) => $("#pl-" + k)?.value ?? "";
const plSet = (k, v) => { const el = $("#pl-" + k); if (el) el.value = v ?? ""; };
const fmtDayMonth = (s, year) => localDateOnly(s).toLocaleDateString("en-NZ", year ? { day: "numeric", month: "short", year: "numeric" } : { day: "numeric", month: "short" });
const planRange = (start) => `${fmtDayMonth(start)} – ${fmtDayMonth(addDays(start, PLAN_DAYS - 1), true)}`;

// Where a client is up to: the current plan, what day of it, and when the next is due.
function planInfo(c){
  const plans = plansOf(c), cur = plans[plans.length - 1];
  if (!cur) return { cur: null, label: "No plan yet", cls: "client", due: true };
  const day = daysBetween(localDateOnly(cur.start), localDateOnly(localDayStr())) + 1;
  const left = PLAN_DAYS - day;
  if (day < 1) return { cur, day: 0, label: `Starts ${fmtDayMonth(cur.start)}`, cls: "track", due: false };
  if (left < 0) return { cur, day: PLAN_DAYS, label: "Plan finished · next one due", cls: "client", due: true };
  if (left <= 14) return { cur, day, label: `Ends in ${left}d · next one due soon`, cls: "soon", due: true };
  return { cur, day, label: `Day ${day} of ${PLAN_DAYS}`, cls: "track", due: false };
}

// Starting numbers from their last full month's report (or the latest one).
function planPrefill(c){
  const prior = latestPerEarlierMonth(c.id, ymOf(localDayStr())).pop() || monthReportsFor(c.id).slice(-1)[0];
  const m = prior?.metrics || {};
  const target = toNum(m.quoteTarget) || c.quote_target || 10;
  const enq = toNum(m.enquiries), quotes = toNum(m.quotesBooked), rev = toNum(m.revenueMonth);
  const last = plansOf(c).slice(-1)[0];
  const start = last && addDays(last.start, PLAN_DAYS) > localDayStr() ? addDays(last.start, PLAN_DAYS) : localDayStr();
  const next = (c.onboarding_progress || {}).workshop_next;
  const out = {
    start, goal: `Book ${target} quality quotes every month and turn more of them into signed jobs`,
    "s-enq": enq ?? "", "t-enq": enq ? Math.ceil(enq * 1.3) : "", "s-quotes": quotes ?? "", "t-quotes": target,
    "s-rev": rev ?? "", "t-rev": "",
    need1: PLAN_NEEDS[0], need2: PLAN_NEEDS[1], need3: PLAN_NEEDS[2], need4: PLAN_NEEDS[3],
  };
  PLAN_MONTHS.forEach((mo, i) => {
    const p = `m${i + 1}-`;
    Object.assign(out, { [p + "theme"]: mo.theme, [p + "focus"]: mo.focus, [p + "do1"]: mo.actions[0], [p + "do2"]: mo.actions[1], [p + "do3"]: mo.actions[2], [p + "milestone"]: mo.milestone,
      [p + "ws"]: i === 0 && next ? next : mo.workshop });
  });
  // Month 1's workshop is whatever they're lined up for; keep the three different where we can.
  if (next && next !== "marketing"){ const clash = [2, 3].find(i => out[`m${i}-ws`] === next); if (clash) out[`m${clash}-ws`] = "marketing"; }
  return out;
}

function openPlanModal(clientId, planId){
  const c = state.clients.find(x => x.id === clientId);
  if (!c) return;
  plClientId = c.id;
  plExisting = planId ? plansOf(c).find(p => p.id === planId) : null;
  $("#pl-title").textContent = `90-day plan · ${c.name}`;
  $("#plan-form").hidden = false; $("#pl-done").hidden = true;
  const vals = plExisting ? plExisting.fields || {} : planPrefill(c);
  PLAN_FIELDS.forEach(k => plSet(k, vals[k]));
  plStatus("");
  plRenderRange();
  openModal("plan-modal");
}
function plStatus(msg, warn){ const el = $("#pl-status"); if (el){ el.textContent = msg; el.classList.toggle("warn", !!warn); } }
function plRenderRange(){
  const s = plVal("start"), el = $("#pl-range");
  if (!el) return;
  el.textContent = s ? `${planRange(s)} · 6 fortnightly reports and 3 workshops` : "";
  [1, 2, 3].forEach(i => { const m = $(`#pl-m${i}-range`); if (m) m.textContent = s ? `${fmtDayMonth(addDays(s, (i - 1) * 30))} – ${fmtDayMonth(addDays(s, i === 3 ? PLAN_DAYS - 1 : i * 30 - 1))}` : ""; });
}

// The plan's data for the PDF: dates, check-ins and the month-by-month roadmap.
function planPdfData(c, f, number){
  const start = f.start, end = addDays(start, PLAN_DAYS - 1);
  const mondayOf = (d) => { const x = localDateOnly(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return localDayStr(x); };
  const months = [1, 2, 3].map(i => {
    const p = `m${i}-`, ws = WORKSHOP_MAP[f[p + "ws"]];
    // Workshops land mid-month, in the week starting that Monday.
    const wsDay = daysBetween(localDateOnly(start), localDateOnly(mondayOf(addDays(start, (i - 1) * 30 + 14))));
    return {
      theme: f[p + "theme"], focus: f[p + "focus"], actions: [f[p + "do1"], f[p + "do2"], f[p + "do3"]].filter(Boolean), milestone: f[p + "milestone"],
      rangeLabel: `${fmtDayMonth(addDays(start, (i - 1) * 30))} – ${fmtDayMonth(addDays(start, i === 3 ? PLAN_DAYS - 1 : i * 30 - 1))}`,
      workshop: ws ? `${ws.label} workshop` : "", workshopWhen: ws ? `Week of ${fmtDayMonth(addDays(start, wsDay))}` : "", wsDay, ws,
    };
  });
  const cal = [{ day: 0, type: "start", title: "We kick off the plan and lock in the targets" }];
  for (let d = 14; d < PLAN_DAYS; d += 14) cal.push({ day: d, type: "report", title: "Your fortnightly report: how the month is going" });
  months.forEach(m => { if (m.ws) cal.push({ day: m.wsDay, type: "workshop", title: `${m.ws.label} workshop: ${m.ws.blurb.toLowerCase()}`, when: m.workshopWhen }); });
  cal.push({ day: PLAN_DAYS - 1, type: "review", title: "We review the results together and map out the next 90 days" });
  cal.sort((a, b) => a.day - b.day || (a.type === "workshop") - (b.type === "workshop"));
  const person = window.getActivePerson ? window.getActivePerson() : null;
  let am = {}; try { am = JSON.parse(localStorage.getItem(wpAmKey(person)) || "{}"); } catch(e){}
  const deal = c.source_deal_id ? state.deals.find(d => d.id === c.source_deal_id) : null;
  const n = (k) => toNum(f[k]);
  const pctUp = (a, b) => a && b && b > a ? `+${Math.round((b - a) / a * 100)}%` : "";
  return {
    clientName: c.name, planNumber: number, rangeLabel: planRange(start),
    startLabel: fmtDayMonth(start, true), endLabel: fmtDayMonth(end, true), checkinsLabel: `${cal.filter(e => e.type === "report").length} reports · ${months.filter(m => m.ws).length} workshops`,
    goal: f.goal,
    metrics: [
      { label: "Enquiries a month", now: n("s-enq"), target: n("t-enq"), kind: "num", note: pctUp(n("s-enq"), n("t-enq")) },
      { label: "Quotes booked a month", now: n("s-quotes"), target: n("t-quotes"), kind: "num", note: pctUp(n("s-quotes"), n("t-quotes")) },
      { label: "Revenue won a month", now: n("s-rev"), target: n("t-rev"), kind: "money", note: pctUp(n("s-rev"), n("t-rev")) },
    ].filter(m => m.target != null),
    months,
    markers: cal.map(e => ({ day: e.day, type: e.type })),
    calendar: cal.map(e => ({ type: e.type, title: e.title, dateLabel: e.type === "workshop" ? e.when.replace("Week of", "w/c") : fmtDayMonth(addDays(start, e.day)) })),
    promises: PLAN_PROMISES, needs: [f.need1, f.need2, f.need3, f.need4].filter(Boolean),
    contactName: am.account_manager || ASSIGNEES[deal?.assignee]?.label || "", contactPhone: am.phone || "",
  };
}

async function makePlan(){
  const c = state.clients.find(x => x.id === plClientId);
  if (!c) return;
  const f = Object.fromEntries(PLAN_FIELDS.map(k => [k, String(plVal(k)).trim()]));
  if (!f.start){ plStatus("Pick the day the plan starts.", true); return; }
  if (!f.goal){ plStatus("Write the goal for the 90 days.", true); return; }
  const btn = $("#pl-make"); btn.disabled = true; plStatus("Making the plan…");
  try {
    await wpLoadLibs();
    const plans = plansOf(c);
    const number = plExisting ? (plExisting.number || plans.indexOf(plExisting) + 1) : plans.length + 1;
    const bytes = await window.MPPlanPDF.build(planPdfData(c, f, number));
    const entry = { id: plExisting?.id || uid(), number, start: f.start, end: addDays(f.start, PLAN_DAYS - 1), fields: f, made_at: new Date().toISOString() };
    const list = [...((c.onboarding_progress || {}).plans || [])].filter(p => p.id !== entry.id);
    const progress = { ...(c.onboarding_progress || {}), plans: [...list, entry] };
    c.onboarding_progress = progress;
    plExisting = entry;
    await DataLayer.update("clients", c.id, { onboarding_progress: progress });
    if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }

    if (plLastUrl) URL.revokeObjectURL(plLastUrl);
    plLastUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    plLastName = `Mr Priceless 90-Day Plan - ${(c.name || "Client").replace(/[\\/:*?"<>|]+/g, "")} - ${f.start}.pdf`;
    const link = $("#pl-file"); link.href = plLastUrl; link.download = plLastName;
    $("#pl-file-name").textContent = plLastName;
    const a = document.createElement("a"); a.href = plLastUrl; a.download = plLastName; document.body.appendChild(a); a.click(); a.remove();
    $("#plan-form").hidden = true; $("#pl-done").hidden = false;
    plStatus("");
  } catch(err){
    console.error(err);
    plStatus("Couldn't make the plan: " + (err.message || err), true);
  } finally { btn.disabled = false; }
}

function renderPlans(){
  const list = $("#pl-client-list");
  if (!list) return;
  list.hidden = !PLANS_ENABLED; if ($("#pl-section-head")) $("#pl-section-head").hidden = !PLANS_ENABLED;
  if (!PLANS_ENABLED) return;
  const clients = state.clients.filter(isPlanClient);
  const infos = new Map(clients.map(c => [c.id, planInfo(c)]));
  const due = clients.filter(c => infos.get(c.id).due).length;
  const sub = $("#pl-sub");
  if (sub) sub.textContent = due ? `${due} of ${clients.length} client${clients.length === 1 ? "" : "s"} need${due === 1 ? "s" : ""} a new plan` : "Everyone has a plan running";
  if (!clients.length){ list.innerHTML = `<div class="card onb-empty"><div><h3>No clients yet</h3><p>Each client gets a 90-day plan once they're signed.</p></div></div>`; return; }
  const order = [...clients].sort((a, b) => (infos.get(b.id).due - infos.get(a.id).due) || (a.name || "").localeCompare(b.name || ""));
  list.innerHTML = order.map(c => {
    const info = infos.get(c.id), plans = plansOf(c).slice().reverse();
    const pct = info.cur ? Math.round(Math.min(PLAN_DAYS, Math.max(0, info.day)) / PLAN_DAYS * 100) : 0;
    return `
      <article class="rp-row pl-row ${info.due ? "is-due" : ""}">
        <span class="onb-card-avatar">${escapeHtml((c.name || "?").trim().charAt(0).toUpperCase())}</span>
        <div class="rp-row-id">
          <div class="rp-row-name">${escapeHtml(c.name)}</div>
          <div class="rp-row-sub">${info.cur ? `Plan ${info.cur.number || plans.length} · ${escapeHtml(planRange(info.cur.start))}` : (c.stage || "onboarding") === "onboarding" ? "Onboarding · send one after kickoff" : "Hasn't had one yet"}</div>
        </div>
        <div class="pl-progress" title="${pct}% through">${info.cur ? `<div class="onb-bar"><span style="width:${pct}%"></span></div><small>${escapeHtml(info.cur.fields?.goal || "")}</small>` : ""}</div>
        <span class="onb-status ${info.cls}">${escapeHtml(info.label)}</span>
        <div class="rp-row-actions">
          ${plans.length ? `<select class="filter-select pl-past" data-client="${c.id}" aria-label="Past plans for ${escapeHtml(c.name)}"><option value="">Past plans (${plans.length})</option>${plans.map(p => `<option value="${p.id}">Plan ${p.number || ""} · ${escapeHtml(planRange(p.start))}</option>`).join("")}</select>` : ""}
          <button type="button" class="btn ${info.due ? "gold" : "ghost"} sm" data-action="make-plan" data-id="${c.id}">${info.due ? "Make 90-day plan" : "New plan"}</button>
        </div>
      </article>`;
  }).join("");
}
function setupPlans(){
  $("#plan-form")?.addEventListener("submit", (e) => { e.preventDefault(); makePlan(); });
  $("#pl-start")?.addEventListener("change", plRenderRange);
  $("#pl-client-list")?.addEventListener("change", (e) => {
    const sel = e.target.closest(".pl-past");
    if (!sel || !sel.value) return;
    const id = sel.value; sel.value = "";
    openPlanModal(sel.dataset.client, id);
  });
  $("#pl-file")?.addEventListener("dragstart", (e) => {
    if (!plLastUrl) return;
    e.dataTransfer.effectAllowed = "copy";
    e.dataTransfer.setData("DownloadURL", `application/pdf:${plLastName}:${plLastUrl}`);
  });
  $("#pl-preview")?.addEventListener("click", () => { if (plLastUrl) window.open(plLastUrl, "_blank"); });
  $("#pl-edit")?.addEventListener("click", () => { $("#pl-done").hidden = true; $("#plan-form").hidden = false; });
}

/* ───────── Workshops: monthly consulting sessions ─────────
   Once a month we sit down with each client and look at their business.
   Three kinds of workshop: Financial, Sales and Marketing.
   - The board shows which client needs which workshop next (drag to assign),
     with a suggestion worked out from their numbers.
   - Each session is logged on the client (date, who ran it, notes, action
     items for us and for them) in client.onboarding_progress.workshops, and
     the next pick in onboarding_progress.workshop_next.
   - The library holds what each workshop covers, the questions to ask and a
     run sheet. Starter content lives here; edits are saved as rows in the
     rules table titled "workshop:<category>" (kept off the Rules page). */
const WORKSHOP_CATS = [
  { key: "financial", label: "Financial", blurb: "Pricing, margins and cash flow", duration: "45 min",
    when: "Return is under 3x, or jobs are coming in but the money isn't showing up",
    outcome: "A monthly revenue target they believe in, prices they're confident in, and a clear picture of which jobs actually make them money.",
    covers: "Making sure the jobs they're winning are actually making them money. We look at what they charge, what each job really costs them, how cash comes in and out, and set a revenue target they can plan around.",
    prep: [
      "Pull their revenue, jobs won and return to date from their reports",
      "Note their average job value and their biggest and smallest wins",
      "Ask them to bring a rough idea of their monthly running costs",
    ],
    agenda: [
      ["5 min", "Their numbers so far: what our ads have brought in, and the return"],
      ["10 min", "Work out average job value and real margin together"],
      ["10 min", "Most and least profitable job types: what to chase, what to drop"],
      ["10 min", "Pricing, deposits and payment terms"],
      ["10 min", "Set a monthly revenue target and what it means in jobs"],
    ],
    questions: [
      "What was your revenue last month, and what do you want it to be in 12 months?",
      "On a typical job, what's left after materials, labour and travel?",
      "When did you last put your prices up?",
      "Which jobs make you the most money for the time they take?",
      "How long does it usually take to get paid once a job's done?",
      "Do you know what it costs to run the business each month before you earn a cent?",
      "Are there jobs you keep taking that don't really pay?",
    ],
    leave: [
      "A monthly revenue target, and the number of jobs it takes to hit it",
      "Their top 2 job types to push in the ads",
      "2 or 3 actions for them, and ours noted in the CRM",
    ] },
  { key: "sales", label: "Sales & closing", blurb: "Winning the quotes they go out to", duration: "45 min",
    when: "Fewer than 1 in 4 quotes are turning into jobs",
    outcome: "A sharper quote visit, a quote that's easy to say yes to, and confident answers to their two most common objections.",
    covers: "Winning more of the quotes they go out to. We look at what happens at the visit, how the quote is presented and priced, and what's stopping people from saying yes.",
    prep: [
      "Check their close rate in the CRM",
      "Pick 3 recent quotes that didn't land to talk through",
      "Ask them to bring a copy of a quote they've sent",
    ],
    agenda: [
      ["5 min", "Their close rate, and what good looks like for their trade"],
      ["10 min", "Walk through a quote visit, start to finish"],
      ["10 min", "Go through the quotes that didn't land, and why"],
      ["10 min", "Tighten the quote: same day, clear options, easy yes"],
      ["10 min", "Practise the two hardest objections, and asking for the job"],
    ],
    questions: [
      "Walk me through a quote visit, from arriving to leaving.",
      "Are you pricing on the spot, or going away to think about it?",
      "How do you send the quote, and how long does it take?",
      "Do you give options, or one price?",
      "What reasons do people give when they don't go ahead?",
      "Which jobs do you close easily, and which ones slip away?",
      "Do you ask for the job before you leave?",
    ],
    leave: [
      "A same-day quote habit, with good, better and best options",
      "Their answers to the top 2 objections, written down",
      "2 or 3 actions for them, and ours noted in the CRM",
    ] },
  { key: "followup", label: "Quote follow-up", blurb: "Turning open quotes into jobs", duration: "30 min",
    when: "3 or more quotes are sitting open",
    outcome: "A follow-up routine they'll actually stick to, with the messages already written, so no quote goes quiet without a chase.",
    covers: "Chasing the quotes that are already out. Most jobs are won in the follow-up, so we set a simple routine that turns open quotes into signed work without being pushy.",
    prep: [
      "Pull their open quotes and what they're worth",
      "Note how old each one is",
    ],
    agenda: [
      ["5 min", "The open quotes, and what they're worth if half land"],
      ["10 min", "Agree the routine: call on day 2, text on day 5, check in on day 10"],
      ["10 min", "Write the follow-up texts together, ready to send"],
      ["5 min", "Who owns follow-up, and when in the week it happens"],
    ],
    questions: [
      "How many quotes are open right now, and what are they worth?",
      "What do you do after the quote's been sent?",
      "How many times do you follow up before giving up?",
      "Call, text or email: which do your customers actually reply to?",
      "Who's in charge of following up, and when do they do it?",
      "Do you know why quotes go quiet?",
      "Have you ever won a job on the third or fourth follow-up?",
    ],
    leave: [
      "The 2, 5, 10 day routine, with the texts saved on their phone",
      "Today's list of quotes to chase",
      "2 or 3 actions for them, and ours noted in the CRM",
    ] },
  { key: "marketing", label: "Content creation", blurb: "Getting them filming videos and photos", duration: "45 min",
    when: "Ads are fatiguing, or we're running low on their own footage",
    outcome: "A shot list for the next two weeks, the confidence to film on their phone, and a simple routine for getting it to us.",
    covers: "Getting them making content. Fresh videos and photos of their own work are what keep the ads performing, so we plan what to film, show them how to film it on their phone, and set a simple routine for sending it through.",
    prep: [
      "Check which of their creatives are working, and which are fatiguing",
      "Pick 3 example videos from other clients that have done well",
      "Look at what jobs they've got coming up",
    ],
    agenda: [
      ["5 min", "What's working in their ads right now, and why their own footage wins"],
      ["10 min", "Show the 3 example videos and what made them work"],
      ["15 min", "Build a shot list from the jobs they've got coming up"],
      ["10 min", "Phone filming basics: vertical, good light, before and after, talk to camera"],
      ["5 min", "Set the routine: film on the job, send it to us by Friday"],
    ],
    questions: [
      "What jobs have you got coming up that we could film?",
      "Who on the team is happy to be on camera?",
      "Do you take a photo at the start and end of every job?",
      "What do customers always ask you that we could answer in a video?",
      "What's a job you're really proud of?",
      "What stops you from filming at the moment?",
      "Would a quick video of you introducing the business feel okay?",
    ],
    leave: [
      "A shot list for the next two weeks",
      "A Friday routine for sending us photos and videos",
      "2 or 3 actions for them, and ours noted in the CRM",
    ] },
  { key: "reviews", label: "Google reviews", blurb: "Getting more 5-star reviews", duration: "30 min",
    when: "They've got fewer than 30 Google reviews, or haven't had a new one lately",
    outcome: "A review request that goes out after every finished job, so their Google rating keeps climbing without them thinking about it.",
    covers: "Building their Google reviews. Reviews win the job before they've even quoted, and they make every ad work harder. We set up a simple way to ask every happy customer, at the right moment, every time.",
    prep: [
      "Check their Google Business Profile: number of reviews, rating, latest one",
      "Get their review link ready",
      "Look at a competitor or two for comparison",
    ],
    agenda: [
      ["5 min", "Where they stand on Google against the competition"],
      ["10 min", "When and how to ask: at handover, while they're happy"],
      ["10 min", "Write the review request text together, with their link"],
      ["5 min", "Replying to reviews, good and bad"],
    ],
    questions: [
      "How many Google reviews have you got, and when did you last get one?",
      "Do you ask for a review after every job?",
      "Who could you ask today: your last 10 happy customers?",
      "When's the moment a customer is happiest with you?",
      "Do you reply to your reviews?",
      "Have you had a bad review, and how did you handle it?",
      "Who on the team could send the review request?",
    ],
    leave: [
      "A review request text saved on their phone, with their link",
      "A list of 10 recent happy customers to ask this week",
      "2 or 3 actions for them, and ours noted in the CRM",
    ] },
  { key: "googleads", label: "Google Ads", blurb: "Adding search ads on top of Meta", duration: "30 min", upsell: true, manual: true,
    when: "Meta is working well and they want more of the same, or the guarantee is met",
    outcome: "They understand how Google search ads add to what Meta's doing, and they've had a clear offer to add it.",
    covers: "Showing them what Google Ads would add. Meta finds people before they know they need the job done; Google catches the people searching for it right now. We show them the search demand in their area, what it would cost, and offer to run it.",
    prep: [
      "Look up search volume for their main services in their area",
      "Check what competitors are showing up on Google",
      "Prepare the Google Ads offer and pricing",
    ],
    agenda: [
      ["5 min", "What Meta's done for them so far"],
      ["10 min", "Search demand: how many people are searching for their services nearby"],
      ["5 min", "Who's showing up on Google right now, and who's getting those jobs"],
      ["10 min", "The offer: what we'd run, what it costs, what to expect"],
    ],
    questions: [
      "Do people find you on Google at the moment?",
      "What do you think customers type in when they need you?",
      "Which jobs would you most want people searching to find you for?",
      "Have you tried Google Ads before? How did it go?",
      "How much more work could you take on each month?",
      "Is there a season when people search for you most?",
      "What would make adding Google a no-brainer for you?",
    ],
    leave: [
      "The search demand numbers for their area",
      "A clear Google Ads proposal, with a decision date",
      "2 or 3 actions for them, and ours noted in the CRM",
    ] },
  { key: "inbound", label: "Inbound lead takeover", blurb: "We answer every lead within 3 minutes", duration: "30 min", upsell: true, manual: true,
    when: "Leads are coming in but aren't getting booked fast enough",
    outcome: "They hand over first contact on every inbound lead to us, so each one gets a reply within 3 minutes and lands in their calendar as a booked quote.",
    covers: "Taking control of all their inbound leads. The first business to respond usually wins the job, and they can't answer within 3 minutes from the tools. We show them how many leads are slipping through, how we'd handle every enquiry, and agree the handover.",
    prep: [
      "Check their quote-ready to quoted rate, and how fast leads get a reply now",
      "List every place their leads come from: ads, website, Google, phone",
      "Prepare how the takeover works and what it costs",
    ],
    agenda: [
      ["5 min", "How fast leads get a reply now, and what that's costing them"],
      ["10 min", "Map every lead source and where those leads land"],
      ["10 min", "How we'd handle it: reply within 3 minutes, qualify, book into their calendar"],
      ["5 min", "The handover: access we need, and when we start"],
    ],
    questions: [
      "When a lead comes in while you're on a job, what happens?",
      "How long does it usually take someone to get back to them?",
      "Where else do your leads come from apart from our ads?",
      "Have you lost jobs to someone who got back to them first?",
      "Who books your quote visits now, and how?",
      "What do we need to know to qualify a lead properly for you?",
      "How would it feel to only see leads once they're booked?",
    ],
    leave: [
      "A map of every lead source and who handles it",
      "A clear takeover offer, with a start date",
      "2 or 3 actions for them, and ours noted in the CRM",
    ] },
  { key: "website", label: "Website", blurb: "A site that turns visitors into quotes", duration: "30 min", upsell: true, manual: true,
    when: "They've got no website, or the one they've got looks dated and isn't bringing in enquiries",
    outcome: "They see what their website is costing them in lost trust and enquiries, and they've had a clear offer for us to build one that wins quotes.",
    covers: "Showing them what a proper website would do for them. Most people check a tradie's website before they pick up the phone, and a dated or missing site loses jobs our ads and their referrals already paid for. We look at what they've got, what their competitors have, and offer to build one that turns visitors into booked quotes.",
    prep: [
      "Look at their current site on your phone: speed, photos, reviews, how easy it is to get a quote",
      "Pull up 2 or 3 competitors' sites to compare",
      "Prepare the website offer, pricing and a couple of sites we've built",
    ],
    agenda: [
      ["5 min", "Their site as a customer sees it, on a phone"],
      ["10 min", "Side by side with competitors: what's winning people over"],
      ["5 min", "What a site that books quotes needs: their best work, reviews, a simple quote form"],
      ["10 min", "The offer: what we'd build, what it costs, how long it takes"],
    ],
    questions: [
      "When someone gets your number from a mate, do you reckon they check you out online first?",
      "How do you feel about your website at the moment?",
      "Do you get many enquiries through it? How do you know?",
      "Have you ever lost a job to someone who just looked more legit online?",
      "Which jobs would you want it to show off most?",
      "Have you got good photos of your work we could use?",
      "What's held you back from sorting the website before?",
    ],
    leave: [
      "What's costing them on their current site (or not having one)",
      "A clear website proposal, with a decision date",
      "2 or 3 actions for them, and ours noted in the CRM",
    ] },
  { key: "recruitment", label: "Recruitment & team", blurb: "Hiring and keeping good people", duration: "45 min", manual: true,
    when: "They're winning more work than the team can deliver",
    outcome: "A clear next hire, a job ad ready to go, and a plan for the new starter's first week.",
    covers: "Making sure there's a team to deliver the work coming in. We look at when to hire, who to hire, how to find good people, and how to keep them.",
    prep: [
      "Compare the jobs they're winning with what the team can deliver",
      "Look at what they're turning away or pushing back",
    ],
    agenda: [
      ["10 min", "Capacity: what's being turned away or delayed"],
      ["10 min", "The first role to fill, and why that one"],
      ["15 min", "Write the job ad together (we can run it as an ad)"],
      ["10 min", "Where to find candidates, and a first-week plan"],
    ],
    questions: [
      "Are you turning work away or pushing jobs back because you're stretched?",
      "If you had one more person, what would you hand over first?",
      "Apprentice, qualified tradie or admin: which would free you up most?",
      "Where have your best people come from?",
      "What does a new starter need to know on day one?",
      "What would a hire cost you, and what would it free up?",
      "Is anyone on the team at risk of leaving?",
    ],
    leave: [
      "The role to hire for, and a job ad ready to run",
      "A simple first-week plan for the new starter",
      "2 or 3 actions for them, and ours noted in the CRM",
    ] },
  { key: "operations", label: "Systems & operations", blurb: "Scheduling and admin", duration: "45 min", manual: true,
    when: "The owner is doing everything and things are falling through the cracks",
    outcome: "Their top time drains named, one thing templated or automated, and clear owners for the admin.",
    covers: "Freeing up their time so the business doesn't rely on them for everything. We look at scheduling, admin, what happens once a job is won, and the tools they use.",
    prep: [
      "Check their CRM stages match how they actually work",
      "Ask them to list the tools and apps they use",
    ],
    agenda: [
      ["10 min", "Map the steps from signed quote to job done and paid"],
      ["10 min", "Their top 3 time drains"],
      ["15 min", "Pick one thing to template or automate this month"],
      ["10 min", "Who owns each admin task"],
    ],
    questions: [
      "What eats most of your time that isn't on the tools?",
      "How do jobs get scheduled, and who does it?",
      "What happens between a signed quote and the job starting?",
      "Where do things fall through the cracks?",
      "What tools or apps are you using right now?",
      "What do you do over and over that could be a template?",
      "If you took two weeks off, what would stop?",
    ],
    leave: [
      "One template or automation to set up this month",
      "A clear owner for each admin task",
      "2 or 3 actions for them, and ours noted in the CRM",
    ] },
];
const WORKSHOP_MAP = Object.fromEntries(WORKSHOP_CATS.map(c => [c.key, c]));
const WORKSHOP_RULE_PREFIX = "workshop:";
const isWorkshopRule = (r) => String(r?.title || "").startsWith(WORKSHOP_RULE_PREFIX);
// The library entry for a category: saved edits if there are any, else the starter content.
function workshopContent(key){
  const base = WORKSHOP_MAP[key];
  const row = state.rules.find(r => r.title === WORKSHOP_RULE_PREFIX + key);
  if (!row) return base;
  try { const saved = JSON.parse(row.content || "{}"); return { ...base, ...saved, rowId: row.id }; } catch(e){ return { ...base, rowId: row.id }; }
}
const workshopsOf = (c) => [...((c.onboarding_progress || {}).workshops || [])].sort((a, b) => String(b.date).localeCompare(String(a.date)));
const isWorkshopClient = (c) => !["onboarding", "churned"].includes(c.stage || "onboarding");

// Which workshop their numbers point to, and why. Uses the latest report,
// their creatives and what they've already had recently.
function workshopSuggestion(c){
  const rep = monthReportsFor(c.id).slice(-1)[0]?.metrics || {};
  const n = (k) => toNum(rep[k]);
  const recent = new Set(workshopsOf(c).filter(w => daysSince(w.date) <= 60).map(w => w.category));
  const ideas = [];
  const quoted = n("quoted"), jobs = n("jobsMonth"), ready = n("quoteReady"), enq = n("enquiries"), roi = n("roiToDate");
  const openQuotes = n("openQuotesCount") ?? (quoted != null && jobs != null ? Math.max(0, quoted - jobs) : null);
  if (openQuotes >= 3) ideas.push({ cat: "followup", why: `${openQuotes} quotes still waiting on a decision`, weight: openQuotes >= 6 ? 3.2 : 2.2 });
  if (quoted >= 4 && jobs != null && jobs / quoted < 0.25) ideas.push({ cat: "sales", why: `Only ${Math.round(jobs / quoted * 100)}% of quotes are closing`, weight: 3 });
  if (ready >= 4 && quoted != null && quoted / ready < 0.5) ideas.push({ cat: "inbound", why: `Only ${Math.round(quoted / ready * 100)}% of quote-ready leads got booked: offer to take over inbound`, weight: 2.5 });
  if (jobs >= 6) ideas.push({ cat: "recruitment", why: `${jobs} jobs won this month: check the team can keep up`, weight: 1.2 });
  const fatiguing = clientFatiguingCount(c);
  if (fatiguing >= 2) ideas.push({ cat: "marketing", why: `${fatiguing} ads are fatiguing: they need fresh videos`, weight: 2 });
  const target = n("quoteTarget") || c.quote_target, got = n("quotesBooked");
  const everHad = (cat) => workshopsOf(c).some(w => w.category === cat);
  if (!everHad("googleads") && ((roi != null && roi >= 5) || (target && got >= target))) ideas.push({ cat: "googleads", why: roi != null && roi >= 5 ? `Meta's returning ${fmtTimes(roi)}: offer Google Ads` : "Guarantee met: offer Google Ads", weight: 1.6 });
  if (!everHad("website") && !(c.website || "").trim()) ideas.push({ cat: "website", why: "No website on file: offer to build one", weight: 1.4 });
  if (roi != null && roi < 3) ideas.push({ cat: "financial", why: `Return to date is ${fmtTimes(roi)}`, weight: 2.5 });
  if (n("revenueMonth") > 0 && !recent.has("financial")) ideas.push({ cat: "financial", why: "Jobs are coming in: check pricing and margins", weight: 1 });
  const pick = ideas.filter(i => !recent.has(i.cat)).sort((a, b) => b.weight - a.weight)[0];
  if (pick) return pick;
  // Nothing stands out: whichever they haven't had for longest.
  const lastBy = (cat) => workshopsOf(c).find(w => w.category === cat)?.date || "";
  // Upsells, recruitment and operations come from the numbers or a manual pick, never the rotation.
  const rotation = WORKSHOP_CATS.filter(w => !w.manual).sort((a, b) => lastBy(a.key).localeCompare(lastBy(b.key)))[0];
  return { cat: rotation.key, why: lastBy(rotation.key) ? `Longest since their last ${rotation.label.toLowerCase()} workshop` : `Haven't had a ${rotation.label.toLowerCase()} workshop yet`, weight: 0 };
}
const doneThisMonth = (c) => workshopsOf(c).find(w => ymOf(w.date) === ymOf(localDayStr()));
const openActions = (c, owner) => workshopsOf(c).flatMap(w => (w.actions || []).filter(a => !a.done && (!owner || a.owner === owner)));

async function saveWorkshopProgress(c, patch){
  const progress = { ...(c.onboarding_progress || {}), ...patch };
  Object.keys(patch).forEach(k => { if (patch[k] === null) delete progress[k]; });
  c.onboarding_progress = progress;
  await DataLayer.update("clients", c.id, { onboarding_progress: progress });
  if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); }
}

/* The page */
function renderWorkshops(){
  const board = $("#ws-board");
  if (!board) return;
  const tab = state.wsTab || "board";
  $$("[data-ws-tab]").forEach(b => { const on = b.dataset.wsTab === tab; b.classList.toggle("active", on); b.setAttribute("aria-pressed", on); });
  $("#ws-board-wrap").hidden = tab !== "board";
  $("#ws-library").hidden = tab !== "library";
  const clients = state.clients.filter(isWorkshopClient).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const done = clients.filter(doneThisMonth);
  const ours = clients.reduce((s, c) => s + openActions(c, "us").length, 0), theirs = clients.reduce((s, c) => s + openActions(c, "them").length, 0);
  const month = monthNameOf(localDayStr());
  const kpis = $("#ws-kpis");
  if (kpis) kpis.innerHTML = `
    <div class="onb-kpi"><span class="onb-kpi-label">Done in ${escapeHtml(month)}</span><span class="onb-kpi-value">${done.length}<small> of ${clients.length}</small></span><span class="onb-kpi-sub">${clients.length - done.length ? `${clients.length - done.length} still to run` : "everyone's had theirs"}</span></div>
    <div class="onb-kpi ${ours ? "warn" : ""}"><span class="onb-kpi-label">Our open actions</span><span class="onb-kpi-value">${ours}</span><span class="onb-kpi-sub">from past workshops</span></div>
    <div class="onb-kpi"><span class="onb-kpi-label">Their open actions</span><span class="onb-kpi-value">${theirs}</span><span class="onb-kpi-sub">to check in on next time</span></div>`;
  if (tab === "library"){ renderWorkshopLibrary(); return; }
  const cols = [{ key: "", label: "Not picked yet", blurb: "Suggested from their numbers" }, ...WORKSHOP_CATS];
  const nextOf = (c) => { const k = (c.onboarding_progress || {}).workshop_next || ""; return WORKSHOP_MAP[k] ? k : ""; };
  board.innerHTML = cols.map((col, i) => {
    const list = clients.filter(c => nextOf(c) === col.key).sort((a, b) => Boolean(doneThisMonth(a)) - Boolean(doneThisMonth(b)) || (a.name || "").localeCompare(b.name || ""));
    return `
      <section class="onb-col ws-col" data-stage="${col.key || "none"}" data-ws-cat="${col.key}" aria-label="${escapeHtml(col.label)}">
        <header class="onb-col-head">
          <span class="onb-col-num">${i ? WORKSHOP_ICONS[col.key] : "?"}</span>
          <div><div class="onb-col-title">${escapeHtml(col.label)}${col.upsell ? `<span class="ws-upsell">Upsell</span>` : ""}</div><div class="onb-col-blurb">${escapeHtml(col.blurb)}</div></div>
          <span class="onb-col-count">${list.length}</span>
        </header>
        <div class="onb-col-body">
          ${boardColumnCards("ws", col.key || "none", list.map(c => workshopCardHtml(c, col.key)))}
          <div class="onb-drop-hint">${list.length ? "Drop here" : "Drag a client here"}</div>
        </div>
      </section>`;
  }).join("");
  if (state.wsOpenId) renderWorkshopModal();
}
const WORKSHOP_ICONS = {
  financial: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>`,
  sales: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/></svg>`,
  followup: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>`,
  marketing: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>`,
  reviews: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z"/></svg>`,
  googleads: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>`,
  inbound: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M13 2L3 14h9l-1 8 10-12h-9z"/></svg>`,
  website: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 9h20M6 6.5h.01M9 6.5h.01"/></svg>`,
  recruitment: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0112 0v1"/><path d="M19 8v6M16 11h6"/></svg>`,
  operations: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="3"/><path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>`,
};
// The workshop pick-lists (logging a session, the 90-day plan) follow the library.
function fillWorkshopSelects(){
  const opts = WORKSHOP_CATS.map(w => `<option value="${w.key}">${escapeHtml(w.label)}</option>`).join("");
  ["#ws-category", "#pl-m1-ws", "#pl-m2-ws", "#pl-m3-ws"].forEach(sel => { const el = $(sel); if (el){ const v = el.value; el.innerHTML = opts; if (v) el.value = v; } });
}
function workshopCardHtml(c, colKey){
  const last = workshopsOf(c)[0];
  const thisMonth = doneThisMonth(c);
  const sug = workshopSuggestion(c);
  const ours = openActions(c, "us").length, theirs = openActions(c, "them").length;
  const status = thisMonth
    ? `<span class="onb-status track">Done ${escapeHtml(fmtShortDate(thisMonth.date))} · ${escapeHtml(WORKSHOP_MAP[thisMonth.category]?.label || "")}</span>`
    : `<span class="onb-status client">Due in ${escapeHtml(monthNameOf(localDayStr()))}</span>`;
  const suggestion = !colKey
    ? `<div class="ws-sug ws-sug-${sug.cat}"><span>Suggested: <b>${escapeHtml(WORKSHOP_MAP[sug.cat].label)}</b></span><em>${escapeHtml(sug.why)}</em>
         <button type="button" class="ws-sug-use" data-action="ws-use-suggestion" data-id="${c.id}" data-cat="${sug.cat}">Use</button></div>`
    : (sug.cat === colKey && sug.weight > 0 ? `<div class="ws-why">${escapeHtml(sug.why)}</div>` : "");
  return `
    <article class="onb-card ws-card" draggable="true" data-action="ws-open" data-id="${c.id}" tabindex="0" aria-label="${escapeHtml(c.name)}">
      <div class="onb-card-top">
        <span class="onb-card-avatar">${escapeHtml((c.name || "?").trim().charAt(0).toUpperCase())}</span>
        <div class="onb-card-id">
          <div class="onb-card-name">${escapeHtml(c.name)}</div>
          <div class="onb-card-meta">${last ? `Last: ${escapeHtml(WORKSHOP_MAP[last.category]?.label || "Workshop")} · ${escapeHtml(fmtShortDate(last.date))}` : "No workshops yet"}</div>
        </div>
      </div>
      ${status}
      ${suggestion}
      ${ours || theirs ? `<div class="cl-card-stats"><span><b>${ours}</b> ours open</span><span><b>${theirs}</b> theirs open</span></div>` : ""}
    </article>`;
}

/* Dragging a client to the workshop they need next */
function setupWorkshopDrag(){
  const board = $("#ws-board");
  if (!board) return;
  let dragId = null;
  board.addEventListener("dragstart", (e) => {
    const card = e.target.closest?.(".ws-card"); if (!card) return;
    dragId = card.dataset.id; card.classList.add("dragging"); board.classList.add("is-dragging");
    if (e.dataTransfer){ e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", dragId); }
  });
  board.addEventListener("dragend", (e) => {
    e.target.closest?.(".ws-card")?.classList.remove("dragging"); board.classList.remove("is-dragging");
    $$("#ws-board .onb-col.drag-over").forEach(col => col.classList.remove("drag-over")); dragId = null;
  });
  board.addEventListener("dragover", (e) => {
    const col = e.target.closest?.(".ws-col"); if (!col || !dragId) return;
    e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    $$("#ws-board .onb-col.drag-over").forEach(x => { if (x !== col) x.classList.remove("drag-over"); });
    col.classList.add("drag-over");
  });
  board.addEventListener("dragleave", (e) => { const col = e.target.closest?.(".ws-col"); if (col && !col.contains(e.relatedTarget)) col.classList.remove("drag-over"); });
  board.addEventListener("drop", async (e) => {
    const col = e.target.closest?.(".ws-col"); if (!col || !dragId) return;
    e.preventDefault(); col.classList.remove("drag-over");
    const c = state.clients.find(x => x.id === dragId); dragId = null;
    if (c && ((c.onboarding_progress || {}).workshop_next || "") !== col.dataset.wsCat) await saveWorkshopProgress(c, { workshop_next: col.dataset.wsCat || null });
  });
  board.addEventListener("keydown", (e) => {
    const card = e.target.closest?.(".ws-card");
    if (card && e.target === card && (e.key === "Enter" || e.key === " ")){ e.preventDefault(); card.click(); }
  });
}

/* A client's workshops: log one, see past ones, tick off actions */
function openWorkshopModal(id){
  state.wsOpenId = id;
  const c = state.clients.find(x => x.id === id);
  if (!c) return;
  $("#ws-form").reset();
  $("#ws-date").value = localDayStr();
  const lined = (c.onboarding_progress || {}).workshop_next;
  $("#ws-category").value = WORKSHOP_MAP[lined] ? lined : workshopSuggestion(c).cat;
  const person = window.getActivePerson ? window.getActivePerson() : "";
  $("#ws-by").innerHTML = Object.entries(ASSIGNEES).map(([k, a]) => `<option value="${k}" ${k === person ? "selected" : ""}>${escapeHtml(a.label)}</option>`).join("");
  $("#ws-actions-us").value = ""; $("#ws-actions-them").value = "";
  $("#ws-status").textContent = ""; if ($("#ws-file")) $("#ws-file").hidden = true;
  renderWorkshopModal();
  openModal("ws-modal");
}
function renderWorkshopModal(){
  const c = state.clients.find(x => x.id === state.wsOpenId);
  if (!c){ state.wsOpenId = null; return; }
  $("#ws-modal-title").textContent = `${c.name} · workshops`;
  const sug = workshopSuggestion(c);
  $("#ws-modal-sub").innerHTML = `Suggested next: <b>${escapeHtml(WORKSHOP_MAP[sug.cat].label)}</b> · ${escapeHtml(sug.why)}`;
  const cat = workshopContent($("#ws-category").value || sug.cat);
  $("#ws-prompts").innerHTML = `
    ${cat.outcome ? `<p class="ws-prompt-goal"><b>Goal:</b> ${escapeHtml(cat.outcome)}</p>` : ""}
    ${(cat.agenda || []).length ? `<h4>Run sheet · ${escapeHtml(cat.label)}</h4><ol class="wsl-agenda compact">${workshopAgenda(cat).map(([t, step]) => `<li><span class="wsl-time">${escapeHtml(t)}</span><span>${escapeHtml(step)}</span></li>`).join("")}</ol>` : ""}
    <h4>Questions to ask</h4><ol>${(cat.questions || []).map(q => `<li>${escapeHtml(q)}</li>`).join("")}</ol>`;
  const past = workshopsOf(c);
  $("#ws-history").innerHTML = past.length ? past.map(w => `
    <article class="ws-past">
      <header><span class="ws-pill ws-pill-${escapeHtml(w.category)}">${escapeHtml(WORKSHOP_MAP[w.category]?.label || "Workshop")}</span><b>${escapeHtml(fmtShortDate(w.date))}</b><span class="ws-by">${escapeHtml(ASSIGNEES[w.by]?.label || "")}</span>
        <button type="button" class="btn ghost sm ws-pdf-btn" data-action="ws-pdf" data-id="${c.id}" data-ws="${escapeHtml(w.id)}" title="Make the summary PDF">PDF</button>
        <button type="button" class="icon-btn ws-del" data-action="ws-delete" data-id="${c.id}" data-ws="${escapeHtml(w.id)}" title="Delete this workshop">${ICONS.trash}</button></header>
      ${(w.plan || []).length ? `<div class="ws-past-plan"><b>Plan:</b> ${w.plan.map(escapeHtml).join(" · ")}</div>` : ""}
      ${w.notes ? `<p>${escapeHtml(w.notes)}</p>` : ""}
      ${(w.actions || []).length ? `<ul class="ws-actions">${w.actions.map((a, i) => `
        <li class="${a.done ? "done" : ""}"><button type="button" class="ws-action-hit" data-action="ws-toggle-action" data-id="${c.id}" data-ws="${escapeHtml(w.id)}" data-i="${i}" aria-pressed="${!!a.done}"><span class="task-check ${a.done ? "done" : ""}">${TASK_CHECK_SVG}</span><span>${escapeHtml(a.text)}</span></button><em>${a.owner === "them" ? "Them" : "Us"}</em></li>`).join("")}</ul>` : ""}
    </article>`).join("") : `<p class="ws-none">No workshops logged yet.</p>`;
}
async function logWorkshop(){
  const c = state.clients.find(x => x.id === state.wsOpenId);
  if (!c) return;
  const lines = (id, owner) => $(id).value.split("\n").map(s => s.trim()).filter(Boolean).map(text => ({ text, owner, done: false }));
  const entry = {
    id: uid(), date: $("#ws-date").value || localDayStr(), category: $("#ws-category").value, by: $("#ws-by").value,
    notes: $("#ws-notes").value.trim(), plan: $("#ws-plan").value.split("\n").map(x => x.trim()).filter(Boolean),
    actions: [...lines("#ws-actions-us", "us"), ...lines("#ws-actions-them", "them")],
  };
  const makePdf = $("#ws-make-pdf")?.checked;
  const btn = $("#ws-log-btn"); if (btn){ btn.disabled = true; btn.textContent = makePdf ? "Logging and making the PDF…" : "Logging…"; }
  const progress = c.onboarding_progress || {};
  // Logging the workshop they were lined up for clears the pick for next month.
  await saveWorkshopProgress(c, { workshops: [...(progress.workshops || []), entry], workshop_next: progress.workshop_next === entry.category ? null : (progress.workshop_next || null) });
  $("#ws-form").reset(); $("#ws-date").value = localDayStr();
  $("#ws-category").value = (c.onboarding_progress || {}).workshop_next || workshopSuggestion(c).cat;
  $("#ws-make-pdf").checked = makePdf;
  renderWorkshopModal();
  $("#ws-status").textContent = `Logged ${WORKSHOP_MAP[entry.category]?.label || "the"} workshop for ${fmtShortDate(entry.date)}.`;
  if (makePdf) await makeWorkshopPdf(c, entry);
  if (btn){ btn.disabled = false; btn.textContent = "Log workshop"; }
}

/* The workshop summary PDF the client gets after each session */
let wsLastUrl = null, wsLastName = "";
function workshopPdfData(c, w){
  const cat = workshopContent(w.category) || {};
  const reps = monthReportsFor(c.id).filter(r => r.period_end <= w.date);
  const last = reps[reps.length - 1] || monthReportsFor(c.id).slice(-1)[0], m = last?.metrics || {};
  const target = toNum(m.quoteTarget) || c.quote_target || 10, got = toNum(m.quotesBooked);
  const stats = last ? [
    { label: "Revenue won to date", value: toNum(m.revenueToDate) != null ? fmtMoney(m.revenueToDate) : "", sub: toNum(m.revenueMonth) != null ? `${fmtMoney(m.revenueMonth)} in ${monthNameOf(last.period_end)}` : "", gold: true },
    { label: "Return on investment", value: toNum(m.roiToDate) != null ? fmtTimes(toNum(m.roiToDate)) : "", sub: toNum(m.investedToDate) != null ? `on ${fmtMoney(m.investedToDate)} invested` : "" },
    { label: "Quotes booked", value: got != null ? `${got} of ${target}` : "", sub: `${monthNameOf(last.period_end)} guarantee` },
    { label: "Enquiries", value: toNum(m.enquiries) != null ? String(m.enquiries) : "", sub: `in ${monthNameOf(last.period_end)}` },
  ] : [];
  const lined = (c.onboarding_progress || {}).workshop_next;
  const nextKey = WORKSHOP_MAP[lined] && lined !== w.category ? lined : null;
  const person = window.getActivePerson ? window.getActivePerson() : null;
  let am = {}; try { am = JSON.parse(localStorage.getItem(wpAmKey(person)) || "{}"); } catch(e){}
  return {
    clientName: c.name, workshopLabel: cat.label || "Workshop", workshopTitle: `${cat.label || "Business"} workshop`,
    dateLabel: localDateOnly(w.date).toLocaleDateString("en-NZ", { day: "numeric", month: "long", year: "numeric" }),
    runBy: ASSIGNEES[w.by]?.label || "", outcome: cat.outcome || cat.covers || "",
    stats, statsAsOf: last ? monthNameOf(last.period_end) : "",
    learnings: String(w.notes || "").split("\n").map(x => x.trim()).filter(Boolean),
    plan: w.plan || [],
    usActions: (w.actions || []).filter(a => a.owner !== "them").map(a => a.text),
    themActions: (w.actions || []).filter(a => a.owner === "them").map(a => a.text),
    nextWorkshop: nextKey ? WORKSHOP_MAP[nextKey].label + " workshop" : "",
    nextLabel: `Around ${localDateOnly(addDays(w.date, 30)).toLocaleDateString("en-NZ", { day: "numeric", month: "long" })}`,
    contactName: am.account_manager || ASSIGNEES[w.by]?.label || "", contactPhone: am.phone || "",
  };
}
async function makeWorkshopPdf(c, w){
  const status = $("#ws-status");
  try {
    await wpLoadLibs();
    const bytes = await window.MPWorkshopPDF.build(workshopPdfData(c, w));
    if (wsLastUrl) URL.revokeObjectURL(wsLastUrl);
    wsLastUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    wsLastName = `Mr Priceless Workshop - ${(c.name || "Client").replace(/[\\/:*?"<>|]+/g, "")} - ${WORKSHOP_MAP[w.category]?.label || "Workshop"} - ${w.date}.pdf`;
    const link = $("#ws-file");
    if (link){ link.href = wsLastUrl; link.download = wsLastName; link.hidden = false; $("#ws-file-name").textContent = wsLastName; }
    const a = document.createElement("a"); a.href = wsLastUrl; a.download = wsLastName; document.body.appendChild(a); a.click(); a.remove();
    if (status) status.textContent += " Summary PDF saved to your Downloads.";
  } catch(err){
    console.error(err);
    if (status) status.textContent = "Couldn't make the PDF: " + (err.message || err);
  }
}

/* Library: pick a workshop on the left, everything about it on the right */
// Run sheet steps are [time, step]; saved edits store them the same way.
const workshopAgenda = (w) => (w.agenda || []).map(x => Array.isArray(x) ? x : String(x).split("|").map(t => t.trim())).map(([t, step]) => step ? [t, step] : ["", t]);
function workshopClients(key){
  const clients = state.clients.filter(isWorkshopClient);
  const next = clients.filter(c => (c.onboarding_progress || {}).workshop_next === key);
  const had = clients.map(c => ({ c, w: workshopsOf(c).find(w => w.category === key) })).filter(x => x.w).sort((a, b) => String(b.w.date).localeCompare(String(a.w.date)));
  return { next, had };
}
function renderWorkshopLibrary(){
  const lib = $("#ws-library");
  if (!lib) return;
  const key = WORKSHOP_MAP[state.wsLibKey] ? state.wsLibKey : WORKSHOP_CATS[0].key;
  const w = workshopContent(key);
  const { next, had } = workshopClients(key);
  const list = (items, cls) => `<ul class="${cls}">${(items || []).map(t => `<li>${escapeHtml(t)}</li>`).join("")}</ul>`;
  const chip = (c, sub) => `<button type="button" class="wsl-client" data-action="ws-open" data-id="${c.id}"><span class="onb-card-avatar">${escapeHtml((c.name || "?").trim().charAt(0).toUpperCase())}</span><span><b>${escapeHtml(c.name)}</b>${sub ? `<small>${escapeHtml(sub)}</small>` : ""}</span></button>`;
  lib.innerHTML = `
    <nav class="wsl-nav" aria-label="Workshops">
      ${WORKSHOP_CATS.map(base => {
        const n = workshopClients(base.key).next.length;
        return `<button type="button" class="wsl-pick ws-lib-${base.key} ${base.key === key ? "active" : ""}" data-action="ws-lib-pick" data-cat="${base.key}" aria-pressed="${base.key === key}">
          <span class="ws-lib-icon">${WORKSHOP_ICONS[base.key] || ""}</span>
          <span class="wsl-pick-text"><b>${escapeHtml(base.label)}</b><small>${escapeHtml(base.blurb)}</small></span>
          ${base.upsell ? `<span class="ws-upsell">Upsell</span>` : n ? `<span class="wsl-count" title="Lined up next">${n}</span>` : ""}
        </button>`;
      }).join("")}
    </nav>
    <article class="wsl-detail ws-lib-${key}">
      <header class="wsl-hero">
        <span class="ws-lib-icon big">${WORKSHOP_ICONS[key] || ""}</span>
        <div class="wsl-hero-text">
          <div class="wsl-eyebrow">Workshop${w.duration ? ` · ${escapeHtml(w.duration)}` : ""}${w.upsell ? ` · <span class="ws-upsell">Upsell</span>` : ""}</div>
          <h2>${escapeHtml(w.label)}</h2>
          <p>${escapeHtml(w.covers || "")}</p>
        </div>
        <button type="button" class="btn ghost sm" data-action="ws-edit-lib" data-cat="${key}">Edit</button>
      </header>
      <div class="wsl-top">
        ${w.outcome ? `<div class="wsl-outcome"><span>They walk away with</span><p>${escapeHtml(w.outcome)}</p></div>` : ""}
        ${w.when ? `<div class="wsl-when"><span>Run it when</span><p>${escapeHtml(w.when)}</p></div>` : ""}
      </div>
      <div class="wsl-cols">
        <section class="wsl-sec"><h4>Before the session</h4>${list(w.prep, "ws-check")}</section>
        <section class="wsl-sec"><h4>Leave them with</h4>${list(w.leave, "wsl-leave")}</section>
      </div>
      <section class="wsl-sec"><h4>Run sheet</h4>
        <ol class="wsl-agenda">${workshopAgenda(w).map(([t, step]) => `<li><span class="wsl-time">${escapeHtml(t)}</span><span>${escapeHtml(step)}</span></li>`).join("")}</ol>
      </section>
      <section class="wsl-sec"><h4>Questions to ask</h4><ol class="wsl-q">${(w.questions || []).map(q => `<li>${escapeHtml(q)}</li>`).join("")}</ol></section>
      <section class="wsl-sec wsl-clients">
        <div><h4>Lined up next</h4>${next.length ? `<div class="wsl-client-list">${next.map(c => chip(c, workshopSuggestion(c).cat === key ? workshopSuggestion(c).why : "")).join("")}</div>` : `<p class="ws-none">Nobody yet. Drag a client into this column on the board.</p>`}</div>
        <div><h4>Had it</h4>${had.length ? `<div class="wsl-client-list">${had.slice(0, 8).map(({ c, w: log }) => chip(c, fmtShortDate(log.date))).join("")}</div>` : `<p class="ws-none">No one's had this workshop yet.</p>`}</div>
      </section>
    </article>`;
}
function openWorkshopLibEditor(key){
  const w = workshopContent(key);
  $("#ws-lib-key").value = key;
  $("#ws-lib-title").textContent = `Edit ${w.label} workshop`;
  const set = (id, v) => { $(id).value = v || ""; };
  set("#ws-lib-covers", w.covers);
  set("#ws-lib-outcome", w.outcome);
  set("#ws-lib-when", w.when);
  set("#ws-lib-duration", w.duration);
  set("#ws-lib-prep", (w.prep || []).join("\n"));
  set("#ws-lib-agenda", workshopAgenda(w).map(([t, step]) => t ? `${t} | ${step}` : step).join("\n"));
  set("#ws-lib-questions", (w.questions || []).join("\n"));
  set("#ws-lib-leave", (w.leave || []).join("\n"));
  openModal("ws-lib-modal");
}
async function saveWorkshopLib(){
  const key = $("#ws-lib-key").value;
  const lines = (id) => $(id).value.split("\n").map(s => s.trim()).filter(Boolean);
  const content = JSON.stringify({
    covers: $("#ws-lib-covers").value.trim(), outcome: $("#ws-lib-outcome").value.trim(), when: $("#ws-lib-when").value.trim(), duration: $("#ws-lib-duration").value.trim(),
    prep: lines("#ws-lib-prep"), agenda: lines("#ws-lib-agenda").map(l => l.split("|").map(t => t.trim())).map(([t, step]) => step ? [t, step] : ["", t]),
    questions: lines("#ws-lib-questions"), leave: lines("#ws-lib-leave"),
  });
  const existing = state.rules.find(r => r.title === WORKSHOP_RULE_PREFIX + key);
  if (existing) await DataLayer.update("rules", existing.id, { content, updated_at: new Date().toISOString() });
  else await DataLayer.insert("rules", { title: WORKSHOP_RULE_PREFIX + key, content, sort_order: 9000 });
  closeModal("ws-lib-modal");
  if (IS_CONFIGURED){ await DataLayer.fetchAll(); renderAll(); } else renderWorkshops();
}

function setupWorkshops(){
  fillWorkshopSelects();
  setupWorkshopDrag();
  $$("[data-ws-tab]").forEach(b => b.addEventListener("click", () => { state.wsTab = b.dataset.wsTab; renderWorkshops(); }));
  $("#ws-category")?.addEventListener("change", renderWorkshopModal);
  $("#ws-file")?.addEventListener("dragstart", (e) => { if (!wsLastUrl) return; e.dataTransfer.effectAllowed = "copy"; e.dataTransfer.setData("DownloadURL", `application/pdf:${wsLastName}:${wsLastUrl}`); });
  $("#ws-form")?.addEventListener("submit", (e) => { e.preventDefault(); logWorkshop(); });
  $("#ws-lib-form")?.addEventListener("submit", (e) => { e.preventDefault(); saveWorkshopLib(); });
  $("#ws-modal")?.addEventListener("click", (e) => { if (e.target.closest("[data-close='ws-modal']") || e.target.id === "ws-modal") state.wsOpenId = null; });
}
async function handleWorkshopAction(action, id, btn){
  if (action === "ws-edit-lib"){ openWorkshopLibEditor(btn.dataset.cat); return true; }
  if (action === "ws-lib-pick"){ state.wsLibKey = btn.dataset.cat; renderWorkshopLibrary(); return true; }
  const c = state.clients.find(x => x.id === id);
  if (!c) return false;
  if (action === "ws-open"){ openWorkshopModal(id); return true; }
  if (action === "ws-pdf"){
    const w = workshopsOf(c).find(x => x.id === btn.dataset.ws);
    if (w){ if (!$("#ws-modal").classList.contains("visible")) openWorkshopModal(id); $("#ws-status").textContent = "Making the PDF…"; await makeWorkshopPdf(c, w); }
    return true;
  }
  if (action === "ws-use-suggestion"){ await saveWorkshopProgress(c, { workshop_next: btn.dataset.cat }); return true; }
  if (action === "ws-toggle-action" || action === "ws-delete"){
    const list = [...((c.onboarding_progress || {}).workshops || [])].map(w => ({ ...w, actions: [...(w.actions || [])] }));
    const w = list.find(x => x.id === btn.dataset.ws);
    if (!w) return true;
    if (action === "ws-delete"){
      if (!confirm("Delete this workshop and its notes?")) return true;
      await saveWorkshopProgress(c, { workshops: list.filter(x => x.id !== w.id) });
    } else {
      const a = w.actions[Number(btn.dataset.i)];
      if (a) a.done = !a.done;
      await saveWorkshopProgress(c, { workshops: list });
    }
    renderWorkshopModal();
    return true;
  }
  return false;
}

async function syncClientAds(clientId, btnEl){
  const client = state.clients.find(c => c.id === clientId);
  if (!client) return;
  if (!client.meta_ad_account_id){ alert("This client needs a Meta Ad Account ID set first (Edit Client)."); return; }
  const btn = btnEl || $("#sync-client-ads-btn");
  const btnLabel = btn ? btn.textContent : "";
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
    if (btn){ btn.disabled = false; btn.textContent = btnLabel; }
    alert(`Demo mode: refreshed ${withMetaId.length} existing creative${withMetaId.length===1?"":"s"}. Connect Supabase + Meta to actually discover and import new ads from the account.`);
    renderAll();
    return;
  }
  const { data, error } = await supabase.functions.invoke("sync-client-ads", { body: { client_id: clientId } });
  if (btn){ btn.disabled = false; btn.textContent = btnLabel; }
  if (error || data?.error){ alert("Couldn't sync the ad account: " + (data?.error || error.message)); return; }
  const pl = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  alert(`Synced ${client.name}: found ${pl(data.campaigns_found ?? 0, "campaign")}, ${pl(data.adsets_found ?? 0, "ad set")} and ${pl(data.ads_found, "ad")}.\n${data.creatives_created} new creative${data.creatives_created===1?"":"s"}, ${data.creatives_updated} updated, ${pl(data.campaigns_created, "new campaign")}.${data.stats_error ? `\n\nThe ads were saved, but Meta wouldn't send their stats this time (${data.stats_error}). They'll fill in on the next sync.` : ""}`);
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
  const scope = $("#region-data-scope");
  if (!$("#region-data-total")) return;
  const country = state.dialerCountry;
  const region = state.dialerFilter.region;
  const pool = state.prospects.filter(inDialerCountry);
  const filtered = region ? pool.filter(p => p.region === region) : pool;
  if (scope) scope.textContent = `${DIALER_COUNTRIES[country].label} · ${region || (country === "AU" ? "All states" : "All regions")}`;
  const st = (id,v) => { const el = $(id); if (el) el.textContent = v; };
  st("#region-data-total", filtered.length);
  st("#region-data-calls", filtered.reduce((s,p) => s + Number(p.calls_made||0), 0).toLocaleString());
  st("#region-data-bookings", filtered.filter(p => p.last_outcome === "booked_meeting").length);
  st("#region-data-nevercalled", filtered.filter(p => !p.calls_made).length);
  st("#region-data-followups", filtered.filter(p => p.last_outcome === "call_back").length);
  st("#region-data-notinterested", filtered.filter(p => p.last_outcome === "not_interested").length);
  st("#region-data-disqualified", filtered.filter(p => p.last_outcome === "disqualified").length);
  st("#region-data-returning", filtered.filter(isReturning).length);
  st("#region-data-noanswer", filtered.filter(p => p.last_outcome === "no_answer").length);
}

// Shows which of the canonical Region/Industry combos actually have
// prospects on file yet, so the team can see at a glance where territory
// still hasn't been touched instead of guessing from memory.
// A heatmap of every NZ region worked (AU is a different operation entirely
// - see Aus Dialler - so it doesn't belong in this coverage picture). No
// target/threshold - just whether a region has been touched at all yet.
// Sorted emptiest-first since those are the regions that actually need
// attention; clicking a chip jumps the main Prospecting list straight to
// that region instead of just being decorative.
function renderRegionCoverage(){
  const grid = $("#coverage-grid");
  if (!grid) return;

  const sel = $("#coverage-industry-select");
  const industry = state.coverageIndustry || "";
  if (sel){
    const options = [...new Set([...HOME_SERVICES_INDUSTRIES, ...state.prospects.map(p => p.industry).filter(Boolean)])].sort((a,b) => a.localeCompare(b));
    sel.innerHTML = `<option value="">All industries</option>` + options.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");
    sel.value = industry;
  }

  const counts = {};
  state.prospects.forEach(p => {
    if (!p.region || (industry && p.industry !== industry)) return;
    counts[p.region] = (counts[p.region]||0) + 1;
  });

  const emptyStatus = industry ? "missing" : "empty";
  const rows = NZ_REGIONS.map(region => {
    const count = counts[region] || 0;
    const done = regionCompletion(region);
    return { region, count, done, status: done ? "done" : count === 0 ? emptyStatus : "filling" };
  });

  const st = (id,v) => { const el = $(id); if (el) el.textContent = v; };
  st("#coverage-count-empty", rows.filter(r => r.status === "empty" || r.status === "missing").length);
  st("#coverage-count-filling", rows.filter(r => r.status === "filling").length);
  st("#coverage-count-done", rows.filter(r => r.status === "done").length);
  st("#coverage-label-empty", industry ? `have no ${industry} prospects` : "not started");
  st("#coverage-label-filling", industry ? `have ${industry} prospects` : "have prospects");
  $("#coverage-dot-empty")?.classList.toggle("missing", !!industry);
  $("#coverage-dot-empty")?.classList.toggle("empty", !industry);

  const noun = industry ? `${industry} prospect` : "prospect";
  // Completed regions sit at the end, longest-completed last.
  const sorted = [...rows].sort((a,b) => (!!a.done - !!b.done) || (a.done && b.done ? new Date(b.done.completed_at) - new Date(a.done.completed_at) : 0) || b.count - a.count || a.region.localeCompare(b.region));
  grid.innerHTML = sorted.map(r => {
    const since = r.done ? monthsSinceLabel(r.done.completed_at) : null;
    const countText = r.done ? `Done ${since.label === "under a month" ? "this month" : since.label + " ago"}`
      : r.status === "filling" ? `${r.count} ${noun}${r.count===1?"":"s"}` : (industry ? "None yet" : "Not started");
    return `
    <div class="coverage-chip ${r.status}${since && since.months >= 6 ? " is-stale" : ""}">
      <button type="button" class="coverage-chip-main" data-action="filter-region-coverage" data-region="${escapeHtml(r.region)}" title="${escapeHtml(r.region)} - ${r.count} ${escapeHtml(noun)}${r.count===1?"":"s"}">
        <span class="coverage-chip-name">${escapeHtml(r.region)}</span>
        <span class="coverage-chip-count">${escapeHtml(countText)}</span>
        ${since && since.months >= 6 ? `<span class="coverage-chip-revisit">Time to revisit</span>` : ""}
      </button>
      <button type="button" class="coverage-tick ${r.done ? "checked" : ""}" data-action="${r.done ? "reopen-region" : "complete-region"}" data-region="${escapeHtml(r.region)}" ${r.done ? `data-id="${r.done.id}"` : ""}
        title="${r.done ? `Completed ${fmtDate(r.done.completed_at)}${r.done.completed_by ? " by " + escapeHtml(prospectCallerLabel(r.done.completed_by)) : ""} - click to reopen` : `Mark ${escapeHtml(r.region)} as completed`}"
        aria-label="${r.done ? "Reopen" : "Mark completed"} ${escapeHtml(r.region)}">${r.done ? TASK_CHECK_SVG : ""}</button>
    </div>`;
  }).join("");
}
// Tick off a region+industry combo once it's been fully worked - its
// prospects drop out of Prospecting for everyone (see isVerticalCompleted)
// without deleting anything, and reactivating just un-ticks it. Active
// combos are derived live from whatever NZ prospects actually exist, not a
// fixed matrix - there's no point offering a checkbox for a combo nobody's
// ever imported.
function renderVerticalCoverage(){
  const wrap = $("#vertical-coverage-body");
  if (!wrap) return;

  const groups = {};
  state.prospects.forEach(p => {
    if (!p.region || !p.industry || AU_REGIONS.includes(p.region)) return;
    if (isVerticalCompleted(p.region, p.industry)) return;
    const key = `${p.region} ${p.industry}`;
    groups[key] = (groups[key]||0) + 1;
  });
  const active = Object.entries(groups)
    .map(([key,count]) => { const [region,industry] = key.split(" "); return { region, industry, count }; })
    .sort((a,b) => b.count - a.count || a.region.localeCompare(b.region));

  const completed = [...state.completedVerticals].filter(v => v.industry !== REGION_DONE).sort((a,b) => new Date(b.completed_at) - new Date(a.completed_at));

  const activeHtml = active.length ? active.map(v => `
    <div class="vertical-row">
      <button type="button" class="vertical-check" data-action="complete-vertical" data-region="${escapeHtml(v.region)}" data-industry="${escapeHtml(v.industry)}" title="Mark ${escapeHtml(v.region)} · ${escapeHtml(v.industry)} as fully worked"></button>
      <div class="vertical-row-info">
        <div class="vertical-row-name">${escapeHtml(v.region)} · ${escapeHtml(v.industry)}</div>
        <div class="vertical-row-sub">${v.count} prospect${v.count===1?"":"s"}</div>
      </div>
    </div>
  `).join("") : `<p class="vertical-empty">No region + industry combos with prospects yet.</p>`;

  const completedHtml = completed.length ? completed.map(v => {
    const count = state.prospects.filter(p => p.region === v.region && p.industry === v.industry).length;
    return `
    <div class="vertical-row is-complete">
      <button type="button" class="vertical-check checked" data-action="reactivate-vertical" data-id="${v.id}" title="Reactivate - brings these prospects back into Prospecting">${TASK_CHECK_SVG}</button>
      <div class="vertical-row-info">
        <div class="vertical-row-name">${escapeHtml(v.region)} · ${escapeHtml(v.industry)}</div>
        <div class="vertical-row-sub">${count} prospect${count===1?"":"s"} tucked away - completed ${(l => l === "under a month" ? "this month" : l + " ago")(monthsSinceLabel(v.completed_at).label)} (${fmtDate(v.completed_at)})${v.completed_by ? " by "+escapeHtml(prospectCallerLabel(v.completed_by)) : ""}</div>
      </div>
    </div>`;
  }).join("") : `<p class="vertical-empty">Nothing marked complete yet.</p>`;

  wrap.innerHTML = `
    <div class="vertical-coverage-col">
      <div class="card-subhead" style="padding-left:0;">Active</div>
      ${activeHtml}
    </div>
    <div class="vertical-coverage-col">
      <div class="card-subhead" style="padding-left:0;">Completed</div>
      ${completedHtml}
    </div>
  `;
}
function renderCoverageMap(){
  const byRegion = {};
  const industriesSeen = new Set();
  // NZ only - AU numbers are a different operation (Aus Dialler), not part
  // of Prospecting's own coverage picture.
  state.prospects.forEach(p => {
    if (!p.region || !NZ_REGIONS.includes(p.region)) return;
    if (!byRegion[p.region]) byRegion[p.region] = { total: 0, industries: {} };
    byRegion[p.region].total += 1;
    if (p.industry){
      byRegion[p.region].industries[p.industry] = (byRegion[p.region].industries[p.industry] || 0) + 1;
      industriesSeen.add(p.industry);
    }
  });

  const coveredRegions = Object.keys(byRegion);
  $("#coverage-regions-started").textContent = `${coveredRegions.length} / ${NZ_REGIONS.length}`;
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

  const unmappedRegions = NZ_REGIONS.filter(r => !coveredRegions.includes(r));
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
    // NZ only, same as the list itself - an AU region option here would
    // always return an empty list, which is exactly the kind of dead-end
    // dropdown clutter Prospecting's meant to not have any more.
    const regions = dialerDistinctValues("region").filter(r => NZ_REGIONS.includes(r));
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
      <td>${phoneHtml(p.phone)}</td>
      <td>${[p.region,p.industry].filter(Boolean).map(escapeHtml).join(" · ") || "-"}</td>
      <td>
        <button class="btn ${called ? "ghost" : "gold"} prospect-call-btn" data-action="log-prospect-call" data-id="${p.id}">
          ${calledLabel}
        </button>
        ${p.last_outcome === "not_interested" ? `<div class="row-sub" style="margin-top:4px;">Marked Not Interested</div>` : ""}
        ${p.last_outcome === "disqualified" ? `<div class="row-sub" style="margin-top:4px;">Marked Disqualified</div>` : ""}
        ${p.last_outcome === "call_back" ? `<div class="row-sub" style="margin-top:4px;">Follow-up scheduled</div>` : ""}
        ${isReturning(p) ? `<div class="row-sub" style="margin-top:4px;">${escapeHtml(OUTCOMES[p.last_outcome]?.label || "Cooling down")} - back ${fmtDate(p.snoozed_until)}</div>` : ""}
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
// anything sharing a phone number or business name with another row gets
// flagged and pushed to its own section at the very bottom instead of
// silently sitting in the regular flow, so nobody calls the same business
// twice.
function renderProspectList(){
  const groupsWrap = $("#prospecting-groups");
  if (!groupsWrap) return;
  renderProspectFilters();
  const baseFiltered = dialerFilteredProspects();

  // Prospecting is NZ only - Australian numbers are Aus Dialler's territory
  // entirely, a separate operation with its own page, and shouldn't turn up
  // here just because they live in the same shared dial_prospects table.
  // Untagged/blank-region prospects still show (safer than hiding an
  // un-tagged lead outright), only a prospect explicitly tagged with an AU
  // region gets excluded.
  const nzOnly = baseFiltered.filter(p => !p.region || !AU_REGIONS.includes(p.region));

  // A region+industry combo ticked off as fully worked (see Lead Engine's
  // Vertical Coverage) drops out of Prospecting entirely, for everyone -
  // nothing gets deleted, it's just excluded here, so unticking it on Lead
  // Engine brings the exact same prospects straight back.
  const activeOnly = nzOnly.filter(p => !isVerticalCompleted(p.region, p.industry));

  // Vertical assignments are set from the Lead Engine page (Rocky/Max
  // only, see canAccessLeadEngine) but the restriction itself applies to
  // whoever has a focus set on their own key, admins included - if Rocky
  // assigns himself a vertical, it scopes him too, same as anyone else. An
  // admin who wants to see everything just leaves their own focus unset.
  // Anyone with a focus set only sees prospects in that industry, plus
  // anything they've personally brought in themselves, so narrowing
  // someone's focus never locks them out of leads they went and found on
  // their own.
  const activePerson = window.getActivePerson ? window.getActivePerson() : null;
  const myFocus = activePerson ? state.teamFocus[activePerson] : null;
  const scoped = myFocus
    ? activeOnly.filter(p => (p.industry||"") === myFocus || personKeyFromEmail(p.created_by) === activePerson)
    : activeOnly;

  // Not Interested and Call Back are parked out of the normal flow entirely
  // (see isParked) rather than just snoozed on a timer, so they get their
  // own dedicated views instead of cluttering the region-grouped active list
  // or silently resurfacing after a cooldown expires.
  const notInterested = scoped.filter(p => p.last_outcome === "not_interested");
  const disqualified = scoped.filter(p => p.last_outcome === "disqualified");
  const followUp = scoped.filter(p => p.last_outcome === "call_back");
  // No Answer gets pulled out of the general Returning bucket into its own
  // view - it's the one people actually want to check on ("did these come
  // back?"), and lumped in with Decision Maker Unavailable and Booked
  // Meeting cooldowns it was invisible as its own thing.
  const noAnswer = scoped.filter(p => p.last_outcome === "no_answer" && isSnoozed(p));
  const returning = scoped.filter(p => isReturning(p) && p.last_outcome !== "no_answer");
  const activePool = scoped.filter(p => !isParked(p) && !isSnoozed(p));

  const viewCounts = { active: activePool.length, no_answer: noAnswer.length, follow_up: followUp.length, not_interested: notInterested.length, disqualified: disqualified.length, returning: returning.length };
  const viewLabels = { active: "Active", no_answer: "No Answer", follow_up: "Follow Up", not_interested: "Not Interested", disqualified: "Disqualified", returning: "Returning" };
  const viewSelect = $("#prospecting-view-select");
  if (viewSelect){
    Array.from(viewSelect.options).forEach(opt => { opt.textContent = `${viewLabels[opt.value]} (${viewCounts[opt.value]})`; });
    viewSelect.value = state.prospectingView;
  }

  const view = state.prospectingView || "active";
  const filtered = { active: activePool, no_answer: noAnswer, follow_up: followUp, not_interested: notInterested, disqualified: disqualified, returning: returning }[view] || activePool;

  if (!filtered.length){
    const emptyMsg = {
      active: scoped.length ? "Nobody's ready to call right now - check Follow Up or Returning." : "No prospects yet. Import a list above.",
      no_answer: "Nobody's currently sitting on a No Answer cooldown.",
      follow_up: "No follow-ups scheduled.",
      not_interested: "Nobody's been marked Not Interested.",
      disqualified: "Nobody's been marked Disqualified.",
      returning: "Nobody's currently cooling down.",
    }[view];
    groupsWrap.innerHTML = emptyState(emptyMsg);
    return;
  }

  // Duplicates only make sense against the active calling pool - the other
  // views are already a narrow, purposeful list, not something to further
  // reorganise.
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

  // Grouped by region AND industry together, not just region - a region
  // full of several different trades mixed into one flat section is exactly
  // what made a bad import (or just a busy list) hard to work through.
  const regionGroups = {};
  clean.forEach(p => {
    const region = p.region || "No Region Set";
    const industry = p.industry || "No Industry Set";
    const key = `${region} · ${industry}`;
    (regionGroups[key] = regionGroups[key] || []).push(p);
  });
  const regionNames = Object.keys(regionGroups).sort((a,b) => a.localeCompare(b));

  let html = "";
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
    const a = ASSIGNEES[p];
    return `
      <div class="team-focus-chip">
        <div class="team-focus-avatar ${a.cls}">${escapeHtml(a.label[0])}</div>
        <div class="team-focus-info">
          <div class="team-focus-name">${escapeHtml(a.label)}</div>
          <select class="team-focus-select" data-team-focus-person="${p}">${options}</select>
        </div>
      </div>`;
  }).join("");
}

// Every section the CRM draws, with the pages it draws on ("*" = always,
// e.g. the shared dropdowns). renderAll draws the page you're looking at
// straight away and the rest just after, while the browser is idle, so a
// save or a live update never stalls the screen redrawing pages nobody's on.
const RENDERERS = [
  [renderDashboard, ["dashboard"]], [renderPlaybookUsagePicker, ["*"]], [renderMeetingsPipeline, ["deals"]],
  [renderContacts, ["contacts"]], [renderDeals, ["deals"]], [renderNurture, ["deals"]], [renderCommission, ["commission"]],
  [renderRegionData, ["dialer", "lead-engine"]], [renderTeamFocusPanel, ["lead-engine"]], [renderRegionCoverage, ["lead-engine"]],
  [renderVerticalCoverage, ["lead-engine"]], [renderProspectList, ["*"]], [renderDialer, ["dialer"]], [renderClients, ["clients"]],
  [renderOnboarding, ["onboarding"]], [renderCreativeLibrary, ["creative"]], [renderContentProduction, ["content-production"]], [renderAdsMonth, ["ads-month"]], [renderContentLibrary, ["content-library"]], [amNavCount, ["*"]],
  [renderTasks, ["tasks"]], [renderReporting, ["reporting"]], [renderReceipts, ["receipts"]], [renderPlans, ["reporting"]],
  [renderWorkshops, ["workshops"]], [renderWeeklyReport, ["reporting"]], [renderLeadCenterImport, ["reporting"]], [renderTeam, ["team"]],
  [renderCalendarGrid, ["calendar"]], [renderPlaybooks, ["playbooks"]], [renderRules, ["rules"]], [renderEmailTemplates, ["email-templates"]],
  [renderExpenses, ["expenses"]], [renderStatistics, ["statistics"]], [fillContactDropdowns, ["*"]],
];
let renderBacklog = [], renderBacklogTimer = null;
function runRenderer(fn){ try { fn(); } catch(err){ console.error(fn.name, err); } }
function flushRenders(){
  if (renderBacklogTimer){ (window.cancelIdleCallback || clearTimeout)(renderBacklogTimer); renderBacklogTimer = null; }
  const todo = renderBacklog; renderBacklog = [];
  todo.forEach(runRenderer);
}
function renderAll(){
  showJarvisFab();
  const now = [], later = [];
  RENDERERS.forEach(([fn, pages]) => (pages.includes("*") || pages.includes(state.page) ? now : later).push(fn));
  now.forEach(runRenderer);
  renderBacklog = later;
  if (renderBacklogTimer) (window.cancelIdleCallback || clearTimeout)(renderBacklogTimer);
  renderBacklogTimer = window.requestIdleCallback ? requestIdleCallback(flushRenders, { timeout: 400 }) : setTimeout(flushRenders, 60);
}

/* ───────── Render: Statistics (long-term, any person / any time range) ───────── */
function statsRangeBounds(range, customFrom, customTo){
  const today = new Date();
  const toStr = localDayStr;
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
// A meeting counts as closed once the client has signed - Onboarding onwards.
const STATS_CLOSED_MEETING_STAGES = new Set([...MEETING_CLOSE_STAGES, "onboarding", ADHOC_STAGE]);
// p is a person key, or null for deals nobody is assigned to (calls always have a person).
function statsForPerson(p, bounds){
  const rows = p ? state.callActivity.filter(r => r.person === p && inStatsRange(r.activity_date, bounds)) : [];
  const calls = rows.reduce((s,r) => s + (r.calls||0), 0);
  const convos = rows.reduce((s,r) => s + (r.conversations||0), 0);
  const mine = (d) => p ? d.assignee === p : !ASSIGNEES[d.assignee];
  const dealsBooked = state.deals.filter(d => mine(d) && inStatsRange(d.created_at, bounds));
  const meetingsBooked = dealsBooked.length;
  const closedMeetings = dealsBooked.filter(d => STATS_CLOSED_MEETING_STAGES.has(d.stage)).length;
  const closedDeals = state.deals.filter(d => mine(d) && (d.stage === "closed_won" || d.stage === ADHOC_STAGE) && inStatsRange(d.updated_at||d.created_at, bounds)).length;
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
  // The whole team also takes in deals with no one assigned, so the totals match the pipeline.
  const none = f.person ? null : statsForPerson(null, bounds);
  const unassigned = !!none && none.meetingsBooked + none.closedDeals > 0;
  const scope = f.person ? [f.person] : unassigned ? [...people, null] : people;
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
        <td>${p ? escapeHtml(ASSIGNEES[p].label) : `<span class="muted">Unassigned</span>`}</td>
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
function renderPlaybookMarkdown(raw, checked, opts = {}){
  checked = checked || {};
  const inline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  // Words to say: [Name]-style blanks stand out as things to fill in.
  const sayHtml = (s) => inline(s).replace(/\[([^\]]{1,40})\]/g, `<span class="pb-fill">$1</span>`);
  const sayBlock = (s) => `<blockquote class="pb-say"><span class="pb-say-label">Say</span><span class="pb-say-text">${sayHtml(s)}</span><button type="button" class="pb-say-copy" data-action="pb-copy-say" title="Copy">Copy</button></blockquote>`;
  const lines = String(raw||"").split("\n");
  let html = "", listType = null, checkIdx = opts.startIdx || 0;
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
    if (task && opts.plainChecks){ if (listType !== "ul"){ closeList(); html += "<ul>"; listType = "ul"; } html += `<li>${inline(task[1])}</li>`; continue; }
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
    // "> " is a script line: the words to actually say on the call.
    const say = line.match(/^>\s*(.*)$/);
    if (say){ closeList(); html += sayBlock(say[1].replace(/^"(.*)"$/, "$1")); continue; }
    // **"What they say"** - what you say back: an objection card.
    const obj = line.match(/^\*\*"(.+?)"\*\*\s*[-–—:]\s*(.+)$/);
    if (obj){ closeList(); html += `<div class="pb-obj"><div class="pb-obj-they"><span>They say</span>“${inline(obj[1])}”</div><div class="pb-obj-you"><span>You say</span>${sayHtml(obj[2])}</div></div>`; continue; }
    // A whole line in quotes is a line to say, too.
    const quoted = line.match(/^"([^"]{12,})"$/);
    if (quoted){ closeList(); html += sayBlock(quoted[1]); continue; }
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
  if (textareaId === "rule-content"){
    const doc = parseRuleSections(ta.value);
    preview.innerHTML = (doc.intro ? `<div class="rule-intro">${renderPlaybookMarkdown(doc.intro, {}).html}</div>` : "")
      + (doc.sections.length ? `<div class="rule-doc">${renderRuleSectionsHtml(doc.sections)}</div>` : "");
    return;
  }
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
// Playbooks that ship with the app (js/builtin-playbooks.js) get added to the
// shared table once, the first time someone signed in loads the CRM without
// them. Remembered per browser so a deleted one doesn't keep coming back.
let builtinPlaybooksChecked = false;
async function ensureBuiltinPlaybooks(){
  if (builtinPlaybooksChecked || !IS_CONFIGURED || !state.user || !state.playbooksLoaded) return;
  builtinPlaybooksChecked = true;
  for (const pb of window.MP_BUILTIN_PLAYBOOKS || []){
    const key = "mp_builtin_pb_" + pb.title;
    let seen = false; try { seen = !!localStorage.getItem(key); } catch(e){}
    if (!seen && !state.playbooks.some(p => (p.title || "").trim().toLowerCase() === pb.title.toLowerCase())){
      const row = await DataLayer.insert("playbooks", { title: pb.title, content: pb.content, sort_order: pb.sort_order });
      if (!row) continue;
    }
    try { localStorage.setItem(key, "1"); } catch(e){}
  }
}
/* ───────── Playbooks ─────────
   Two views. The library: Meeting Structure pinned at the top, then every
   playbook as a card grouped by what it's for, and a search across them all. The
   reader: one playbook as numbered chapters (its "## " sections) with a
   chapter list that follows you down the page, lines to say as big copyable
   script cards and objections as "they say / you say" cards. Nothing to
   tick: where you're up to tracks itself as you scroll (per browser). */
const PB_CATS = [
  { key: "objections", label: "Objections & technique", re: /objection|technique|tone|rebuttal|pushback/i },
  { key: "delivery", label: "Service delivery", re: /deliver|ads\b|onboard|campaign|client|report|workshop/i },
  { key: "meetings", label: "Meetings & closing", re: /meeting|clos|discovery|pitch|offer/i },
  { key: "calling", label: "Cold calling", re: /cold|call|dial|script|prospect/i },
  { key: "other", label: "Everything else", re: /.^/ },
];
const pbCat = (p) => PB_CATS.find(c => c.re.test(p.title || "")) || PB_CATS[PB_CATS.length - 1];
const PB_GOAL_RE = /^(goal|the goal|what this (meeting|call|doc) is for|purpose)$/i;
// "## " sections. The goal section becomes the playbook's lead line instead of a chapter.
function pbParse(p){
  const segs = [];
  let cur = { title: null, lines: [] };
  for (const line of String(p.content || "").split("\n")){
    const h = line.trim().match(/^#{1,2}\s+(.*)$/);
    if (h){ segs.push(cur); cur = { title: h[1].trim(), lines: [] }; }
    else cur.lines.push(line);
  }
  segs.push(cur);
  let lead = "";
  const chapters = [];
  segs.forEach(s => {
    const body = s.lines.join("\n").trim();
    if (s.title === null){ if (body) lead = body; return; }
    if (!lead && PB_GOAL_RE.test(s.title)){ lead = body; return; }
    chapters.push({ title: s.title, body });
  });
  if (!chapters.length && lead){ chapters.push({ title: "The playbook", body: lead }); lead = ""; }
  const words = (t) => (String(t).match(/\S+/g) || []).length;
  chapters.forEach(c => {
    c.mins = Math.max(1, Math.round(words(c.body) / 200));
    c.says = (c.body.match(/^\s*>/gm) || []).length + (c.body.match(/^\s*"[^"\n]{12,}"\s*$/gm) || []).length;
    c.objs = (c.body.match(/^\s*\*\*"[^"]+"\*\*\s*[-–—]/gm) || []).length;
  });
  // The lead: the goal, else the first plain sentence anywhere in it.
  const firstPlain = (t) => String(t).split("\n").map(s => s.trim()).filter(s => s && !/^(#|[-*•]\s|\d+\.\s|>|\*\*")/.test(s))[0] || "";
  const leadText = (lead.replace(/^>\s*/gm, "").split("\n").map(s => s.trim()).filter(Boolean)[0] || firstPlain(p.content)).replace(/\*\*/g, "");
  return { lead: leadText, chapters, mins: Math.max(1, Math.round(words(p.content || "") / 200)),
    says: chapters.reduce((n, c) => n + c.says, 0), objs: chapters.reduce((n, c) => n + c.objs, 0) };
}
// Where you got to in each playbook: the furthest chapter you've scrolled to,
// tracked as you read (nothing to tick). Per browser.
const pbPosKey = (id) => "pbx-pos-" + id;
function pbPos(id){ try { return Number(localStorage.getItem(pbPosKey(id))) || 0; } catch { return 0; } }
function pbSavePos(id, i){ try { if (i > pbPos(id)) localStorage.setItem(pbPosKey(id), String(i)); } catch(e){} }
// Meeting Structure is where everyone starts, so it's pinned at the top.
const PB_PINNED_RE = /meeting structure/i;
let pbSearch = "";
let pbObserver = null;
const pbLastKey = "pbx-last";
const pbHighlight = (text, q) => {
  const safe = escapeHtml(text);
  if (!q) return safe;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig");
  return safe.replace(re, m => `<mark>${m}</mark>`);
};
function pbSearchResults(list, q){
  const out = [];
  const ql = q.toLowerCase();
  list.forEach(p => {
    const doc = pbParse(p);
    if ((p.title || "").toLowerCase().includes(ql)) out.push({ p, sec: -1, title: p.title, snip: doc.lead });
    doc.chapters.forEach((c, i) => {
      const plain = c.body.replace(/\*\*/g, "").replace(/^\s*(>|[-*•]|\d+\.)\s*/gm, "").replace(/\[[ xX]?\]\s*/g, "");
      const hitTitle = c.title.toLowerCase().includes(ql), at = plain.toLowerCase().indexOf(ql);
      if (!hitTitle && at < 0) return;
      const from = Math.max(0, at - 60), snip = at < 0 ? plain.slice(0, 140) : (from ? "…" : "") + plain.slice(from, at + 100).replace(/\s+/g, " ") + "…";
      out.push({ p, sec: i, title: c.title, snip });
    });
  });
  return out.slice(0, 40);
}
function renderPlaybooks(){
  ensureBuiltinPlaybooks();
  const root = $("#pbx");
  if (!root) return;
  const list = [...state.playbooks].sort((a, b) => (PB_PINNED_RE.test(b.title) - PB_PINNED_RE.test(a.title)) || (a.sort_order || 0) - (b.sort_order || 0));
  const p = state.selectedPlaybookId && list.find(x => x.id === state.selectedPlaybookId);
  if (state.selectedPlaybookId && !p) state.selectedPlaybookId = null;
  const searchFocused = document.activeElement?.id === "pbx-search";
  root.innerHTML = p ? pbReaderHtml(p, list) : pbLibraryHtml(list);
  if (p) pbWireReader(p);
  else if (searchFocused){ const s = $("#pbx-search"); if (s){ s.focus(); s.setSelectionRange(s.value.length, s.value.length); } }
}
function pbMetaChips(doc){
  return `<span>${doc.chapters.length} chapter${doc.chapters.length === 1 ? "" : "s"}</span><span>${doc.mins} min read</span>`
    + (doc.says ? `<span>${doc.says} line${doc.says === 1 ? "" : "s"} to say</span>` : "")
    + (doc.objs ? `<span>${doc.objs} objection${doc.objs === 1 ? "" : "s"}</span>` : "");
}
function pbLibraryHtml(list){
  if (!list.length) return `<div class="pbx-empty"><div class="pbx-empty-icon">${ICONS.book}</div><h3>No playbooks yet</h3><p>Add your first script or process and the whole team gets it.</p><button class="btn gold" data-action="pbx-add">+ Add Playbook</button></div>`;
  const docs = new Map(list.map(p => [p.id, pbParse(p)]));
  let last = null; try { last = list.find(x => x.id === localStorage.getItem(pbLastKey)); } catch(e){}
  const pinned = list.find(p => PB_PINNED_RE.test(p.title || ""));
  const rest = list.filter(p => p !== pinned);
  const q = pbSearch.trim();
  const card = (p) => {
    const doc = docs.get(p.id), cat = pbCat(p);
    return `<button type="button" class="pbx-card pbx-cat-${cat.key}" data-action="select-playbook" data-id="${p.id}">
      <span class="pbx-card-icon">${playbookIcon(p.title)}</span>
      <span class="pbx-card-title">${escapeHtml(p.title)}</span>
      <span class="pbx-card-lead">${escapeHtml(doc.lead || "Open to read it.")}</span>
      <span class="pbx-card-meta">${pbMetaChips(doc)}</span>
      <span class="pbx-card-go">Read →</span>
    </button>`;
  };
  const groups = PB_CATS.map(c => ({ c, items: rest.filter(p => pbCat(p).key === c.key) })).filter(g => g.items.length);
  const results = q ? pbSearchResults(list, q) : null;
  const pinDoc = pinned && docs.get(pinned.id);
  return `
    <div class="pbx-lib">
      <label class="pbx-search">
        ${ICONS.search}
        <input id="pbx-search" type="search" placeholder="Search every playbook - try “price” or “not interested”" value="${escapeHtml(pbSearch)}" autocomplete="off">
      </label>
      ${results ? `
        <div class="pbx-results">
          <div class="pbx-results-head">${results.length ? `${results.length} match${results.length === 1 ? "" : "es"} for “${escapeHtml(q)}”` : `Nothing matches “${escapeHtml(q)}”`}</div>
          ${results.map(r => `<button type="button" class="pbx-result pbx-cat-${pbCat(r.p).key}" data-action="pbx-open-at" data-id="${r.p.id}" data-sec="${r.sec}">
            <span class="pbx-result-where"><span class="pbx-dot"></span>${escapeHtml(r.p.title)}${r.sec >= 0 ? ` <em>›</em> ${pbHighlight(r.title, q)}` : ""}</span>
            <span class="pbx-result-snip">${pbHighlight(r.snip, q)}</span>
          </button>`).join("")}
        </div>` : `
        ${pinned ? `
        <button type="button" class="pbx-feature pbx-cat-${pbCat(pinned).key}" data-action="select-playbook" data-id="${pinned.id}">
          <span class="pbx-feature-icon">${playbookIcon(pinned.title)}</span>
          <span class="pbx-feature-text">
            <span class="pbx-k">Start here</span>
            <b>${escapeHtml(pinned.title)}</b>
            <span class="pbx-feature-lead">${escapeHtml(pinDoc.lead)}</span>
            <span class="pbx-feature-steps">${pinDoc.chapters.slice(0, 8).map((c, i) => `<span><i>${i + 1}</i>${escapeHtml(c.title.replace(/^\d+\.\s*/, "").replace(/\s*\([^)]*\)\s*$/, ""))}</span>`).join("")}</span>
          </span>
          <span class="pbx-feature-go">Open →</span>
        </button>` : ""}
        ${last && last !== pinned ? (() => { const d = docs.get(last.id), at = Math.min(pbPos(last.id), d.chapters.length - 1); return `
        <button type="button" class="pbx-continue pbx-cat-${pbCat(last).key}" data-action="pbx-open-at" data-id="${last.id}" data-sec="${at > 0 ? at : -1}">
          <span class="pbx-continue-icon">${playbookIcon(last.title)}</span>
          <span class="pbx-continue-text"><span class="pbx-k">Pick up where you left off</span><b>${escapeHtml(last.title)}</b></span>
          <span class="pbx-continue-at">${at > 0 ? `Chapter ${at + 1}: ${escapeHtml(d.chapters[at].title)}` : "From the start"}</span>
          <span class="pbx-continue-go">Continue →</span>
        </button>`; })() : ""}
        ${groups.map(g => `
          <section class="pbx-group">
            <h3 class="pbx-group-title pbx-cat-${g.c.key}"><span class="pbx-dot"></span>${escapeHtml(g.c.label)}<span class="pbx-group-count">${g.items.length}</span></h3>
            <div class="pbx-grid">${g.items.map(card).join("")}</div>
          </section>`).join("")}`}
    </div>`;
}
function pbReaderHtml(p, list){
  const doc = pbParse(p), cat = pbCat(p);
  const chapters = doc.chapters.map((c, i) => {
    const r = renderPlaybookMarkdown(c.body, {}, { plainChecks: true });
    const prev = doc.chapters[i - 1], next = doc.chapters[i + 1];
    return `
      <section class="pbx-ch" id="pbx-ch-${i}" data-sec="${i}">
        <header class="pbx-ch-head">
          <span class="pbx-ch-num">${i + 1}</span>
          <div class="pbx-ch-titles"><span class="pbx-k">Chapter ${i + 1} of ${doc.chapters.length} · ${c.mins} min</span><h3>${escapeHtml(c.title)}</h3></div>
        </header>
        <div class="pbx-ch-body playbook-content" data-playbook="${p.id}">${r.html || `<p class="pbx-muted">Nothing in this chapter yet.</p>`}</div>
        ${next || prev ? `<footer class="pbx-ch-foot">
          ${prev ? `<button type="button" class="pbx-prev" data-action="pbx-goto" data-sec="${i - 1}">← ${escapeHtml(prev.title)}</button>` : "<span></span>"}
          ${next ? `<button type="button" class="pbx-next" data-action="pbx-goto" data-sec="${i + 1}"><span class="pbx-k">Next</span>${escapeHtml(next.title)} →</button>` : ""}
        </footer>` : ""}
      </section>`;
  }).join("");
  const idx = list.findIndex(x => x.id === p.id), nextPb = list[idx + 1] || list[0];
  return `
    <div class="pbx-reader pbx-cat-${cat.key}">
      <div class="pbx-bar">
        <button type="button" class="pbx-back" data-action="pbx-home">← All playbooks</button>
        <span class="pbx-bar-title">${escapeHtml(p.title)}</span>
        <span class="pbx-bar-prog" id="pbx-bar-prog">Chapter 1 of ${doc.chapters.length}</span>
        <button class="icon-btn" data-action="edit-playbook" data-id="${p.id}" title="Edit">${ICONS.edit}</button>
        <button class="icon-btn" data-action="delete-playbook" data-id="${p.id}" title="Delete">${ICONS.trash}</button>
        <span class="pbx-readbar"><i id="pbx-read-fill"></i></span>
      </div>
      <header class="pbx-hero">
        <div class="pbx-hero-text">
          <span class="pbx-chip"><span class="pbx-dot"></span>${escapeHtml(cat.label)}</span>
          <h2>${escapeHtml(p.title)}</h2>
          ${doc.lead ? `<p class="pbx-hero-lead">${escapeHtml(doc.lead)}</p>` : ""}
          <div class="pbx-hero-meta">${pbMetaChips(doc)}<span>Updated ${fmtDate(p.updated_at || p.created_at)}</span></div>
        </div>
      </header>
      <div class="pbx-body">
        <nav class="pbx-toc" aria-label="Chapters">
          <span class="pbx-k">In this playbook</span>
          ${doc.chapters.map((c, i) => `<button type="button" class="pbx-toc-item" data-action="pbx-goto" data-sec="${i}" data-toc="${i}">
            <span class="pbx-toc-num">${i + 1}</span><span class="pbx-toc-text">${escapeHtml(c.title)}</span>
          </button>`).join("")}
        </nav>
        <main class="pbx-chapters">
          ${chapters}
          ${nextPb && nextPb.id !== p.id ? `<div class="pbx-finish">
            <span class="pbx-finish-icon">📖</span>
            <div><b>That's the playbook.</b><p>Up next: ${escapeHtml(nextPb.title)}</p></div>
            <button type="button" class="btn gold" data-action="select-playbook" data-id="${nextPb.id}">Read ${escapeHtml(nextPb.title)} →</button>
          </div>` : ""}
        </main>
      </div>
    </div>`;
}
let pbScrollHandler = null;
function pbWireReader(p){
  try { localStorage.setItem(pbLastKey, p.id); } catch(e){}
  const secs = $$("#pbx .pbx-ch");
  if (pbObserver) pbObserver.disconnect();
  const visible = new Set();
  const total = secs.length;
  // As you read: the chapter you're on lights up, the ones above it show as read.
  const setActive = (i) => {
    $$("#pbx .pbx-toc-item").forEach(b => { const n = +b.dataset.toc; b.classList.toggle("active", n === i); b.classList.toggle("is-read", n < i); });
    secs.forEach(s => s.classList.toggle("is-current", +s.dataset.sec === i));
    const prog = $("#pbx-bar-prog"); if (prog) prog.textContent = `Chapter ${i + 1} of ${total}`;
    pbSavePos(p.id, i);
  };
  pbObserver = new IntersectionObserver(entries => {
    entries.forEach(en => { en.isIntersecting ? visible.add(+en.target.dataset.sec) : visible.delete(+en.target.dataset.sec); });
    if (visible.size) setActive(Math.min(...visible));
  }, { rootMargin: "-120px 0px -55% 0px" });
  secs.forEach(s => pbObserver.observe(s));
  if (!pbScrollHandler){
    pbScrollHandler = () => {
      const fill = $("#pbx-read-fill"), main = $("#pbx .pbx-chapters");
      if (!fill || !main || state.page !== "playbooks") return;
      const r = main.getBoundingClientRect(), span = r.height - innerHeight * 0.5;
      fill.style.width = Math.max(0, Math.min(100, (-r.top + 120) / Math.max(1, span) * 100)) + "%";
    };
    window.addEventListener("scroll", pbScrollHandler, { passive: true });
  }
  pbScrollHandler();
}
function pbGoto(i){
  const el = $(`#pbx-ch-${i}`);
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + scrollY - 90, behavior: "smooth" });
}

/* ───────── Rules (per-channel standards, shared with the whole team) ─────────
   Rendered as a numbered rulebook rather than a stack of collapsed cards:
   every rule is visible without clicking, each gets a reference number
   ("2.3") the team can quote in chat, and the active list's sections show
   up as an index in the left rail so long lists can be jumped around
   instead of scrolled through. Search filters down to the matching rules
   and highlights the hit. */
function ruleIcon(title){
  const t = String(title||"").toLowerCase();
  if (t.includes("meta") || t.includes("facebook") || t.includes("instagram")) return ICONS.megaphone;
  if (t.includes("google") && (t.includes("ad") || t.includes("ads"))) return ICONS.megaphone;
  if (t.includes("seo")) return ICONS.search;
  if (t.includes("landing") || t.includes("website") || t.includes("web")) return ICONS.globe;
  return ICONS.shield;
}
const ruleInline = (s) => escapeHtml(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
// Splits raw content on "## " headings into sections, then each section's
// lines into items: bullets / numbered lines / checkboxes are rules, other
// headings are sub-headings, and plain lines are notes - unless a section
// has no bullets at all, in which case each plain line is treated as a rule
// (people often just type one rule per line). Content above the first
// heading is the list's intro; if there are no headings at all, it all
// becomes a single unnamed section so it still gets numbered.
function parseRuleSections(raw){
  const segments = [];
  let current = { heading: null, lines: [] };
  for (const line of String(raw||"").split("\n")){
    const h = line.trim().match(/^##\s+(.*)$/);
    if (h){ segments.push(current); current = { heading: h[1].trim(), lines: [] }; }
    else current.lines.push(line);
  }
  segments.push(current);
  const toItems = (lines) => {
    const items = [];
    for (const rawLine of lines){
      const line = rawLine.trim();
      if (!line) continue;
      const sub = line.match(/^#{1,6}\s+(.*)$/);
      if (sub){ items.push({ type:"subhead", text: sub[1] }); continue; }
      const li = line.match(/^(?:[-*•]\s*\[[ xX]?\]\s+|[-*•]\s+|\d+[.)]\s+)(.*)$/);
      if (li){ items.push({ type:"rule", text: li[1] }); continue; }
      items.push({ type:"note", text: line });
    }
    if (!items.some(i => i.type === "rule")) items.forEach(i => { if (i.type === "note") i.type = "rule"; });
    return items;
  };
  const introSeg = segments[0].heading === null ? segments.shift() : null;
  const sections = segments.map(seg => ({ heading: seg.heading, items: toItems(seg.lines) }));
  let intro = introSeg ? introSeg.lines.join("\n").trim() : "";
  if (!sections.length && intro){ sections.push({ heading: null, items: toItems(introSeg.lines) }); intro = ""; }
  sections.forEach(s => { s.ruleCount = s.items.filter(i => i.type === "rule").length; });
  return { intro, sections, totalRules: sections.reduce((n, s) => n + s.ruleCount, 0) };
}
function renderRuleSectionsHtml(sections){
  const numbered = sections.length > 1 || sections[0]?.heading;
  return sections.map((s, si) => {
    let n = 0;
    const items = s.items.map(it => {
      if (it.type === "subhead") return `<li class="rule-subhead">${ruleInline(it.text)}</li>`;
      if (it.type === "note") return `<li class="rule-note">${ruleInline(it.text)}</li>`;
      n++;
      const ref = numbered ? `${si+1}.${n}` : `${n}`;
      return `<li class="rule-item"><span class="rule-ref">${ref}</span><span class="rule-text">${ruleInline(it.text)}</span></li>`;
    }).join("");
    return `
      <section class="rule-section" id="rule-sec-${si}" data-idx="${si}">
        ${s.heading ? `<header class="rule-section-head">
          <span class="rule-section-num">${String(si+1).padStart(2,"0")}</span>
          <h4>${ruleInline(s.heading)}</h4>
          <span class="rule-section-count">${s.ruleCount} rule${s.ruleCount===1?"":"s"}</span>
        </header>` : ""}
        ${items ? `<ol class="rule-items">${items}</ol>` : `<p class="rule-note rule-empty-note">No rules in this section yet.</p>`}
      </section>`;
  }).join("");
}
let ruleSearchQuery = "";
let ruleSectionObserver = null;
function renderRules(){
  const listEl = $("#rules-list");
  const viewer = $("#rule-viewer");
  if (!listEl || !viewer) return;
  const list = state.rules.filter(r => !isWorkshopRule(r)).sort((a,b) => (a.sort_order||0) - (b.sort_order||0));
  if (!list.length){
    listEl.innerHTML = "";
    viewer.innerHTML = `<div class="playbook-empty"><div class="playbook-empty-icon">${ICONS.shield}</div>No rule lists yet.<br>Add one for Meta Ads, Google Ads, Landing Pages, SEO, or anything else.</div>`;
    return;
  }
  if (!state.selectedRuleId || !list.find(r => r.id === state.selectedRuleId)){
    state.selectedRuleId = list[0].id;
  }
  const r = list.find(x => x.id === state.selectedRuleId);
  const doc = parseRuleSections(r.content);
  const headed = doc.sections.filter(s => s.heading);

  listEl.innerHTML = list.map(item => {
    const active = item.id === state.selectedRuleId;
    const d = active ? doc : parseRuleSections(item.content);
    const sub = d.totalRules
      ? `${d.totalRules} rule${d.totalRules===1?"":"s"}${d.sections.filter(s => s.heading).length ? ` · ${d.sections.filter(s => s.heading).length} sections` : ""}`
      : "No rules written yet";
    const toc = active && headed.length > 1 ? `
      <nav class="rule-toc" aria-label="Sections">
        ${doc.sections.map((s, i) => s.heading ? `
          <button type="button" class="rule-toc-link" data-rule-jump="${i}">
            <span class="rule-toc-num">${String(i+1).padStart(2,"0")}</span>
            <span class="rule-toc-title">${ruleInline(s.heading)}</span>
            <span class="rule-toc-count">${s.ruleCount}</span>
          </button>` : "").join("")}
      </nav>` : "";
    return `
    <button type="button" class="playbook-list-item ${active ? "active" : ""}" data-action="select-rule" data-id="${item.id}">
      <span class="playbook-list-item-icon">${ruleIcon(item.title)}</span>
      <span class="playbook-list-item-text">
        <div class="playbook-list-item-title">${escapeHtml(item.title)}</div>
        <div class="playbook-list-item-sub">${sub}</div>
      </span>
    </button>${toc}`;
  }).join("");

  const isEmpty = !doc.intro && !doc.totalRules && !doc.sections.length;
  const bodyHtml = isEmpty ? `
    <div class="playbook-empty">
      <div class="playbook-empty-icon">${ICONS.shield}</div>
      No rules written for ${escapeHtml(r.title)} yet.<br>
      <button type="button" class="btn gold sm" style="margin-top:16px;" data-action="edit-rule" data-id="${r.id}">Write the rules</button>
    </div>` : `
    <div class="rule-toolbar">
      <div class="search">
        ${ICONS.search}
        <input type="text" id="rule-search" placeholder="Search ${escapeHtml(r.title)} rules..." value="${escapeHtml(ruleSearchQuery)}" autocomplete="off">
      </div>
      <span class="rule-search-meta" id="rule-search-meta"></span>
    </div>
    ${doc.intro ? `<div class="rule-intro">${renderPlaybookMarkdown(doc.intro, {}).html}</div>` : ""}
    <div class="rule-doc">${renderRuleSectionsHtml(doc.sections)}</div>
    <div class="rule-no-results" id="rule-no-results" hidden></div>`;

  viewer.innerHTML = `
    <div class="playbook-viewer-head">
      <div class="playbook-viewer-head-title">
        <span class="playbook-viewer-icon">${ruleIcon(r.title)}</span>
        <div><h3>${escapeHtml(r.title)}</h3><p>${doc.totalRules} rule${doc.totalRules===1?"":"s"} · Updated ${fmtDate(r.updated_at||r.created_at)}</p></div>
      </div>
      <div class="playbook-viewer-actions">
        <button class="icon-btn" data-action="edit-rule" data-id="${r.id}" title="Edit">${ICONS.edit}</button>
        <button class="icon-btn" data-action="delete-rule" data-id="${r.id}" title="Delete">${ICONS.trash}</button>
      </div>
    </div>
    ${bodyHtml}
  `;
  wireRuleControls(doc.totalRules);
}
function highlightRuleHtml(html, q){
  if (!q) return html;
  const re = new RegExp(escapeHtml(q).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  // Only touch text between tags, so <strong> etc. stay intact.
  return html.replace(/>([^<]+)</g, (m, text) => ">" + text.replace(re, "<mark>$&</mark>") + "<");
}
function wireRuleControls(totalRules){
  const search = $("#rule-search");
  const meta = $("#rule-search-meta");
  const noResults = $("#rule-no-results");
  const sections = $$("#rule-viewer .rule-section");
  // The searchable/highlightable part of each row - for numbered rules
  // that's just the text, so searching "1" doesn't match every "1.x" ref.
  const textOf = (li) => $(".rule-text", li) || li;
  sections.forEach(sec => $$(".rule-item, .rule-note, .rule-subhead", sec).forEach(li => { textOf(li).dataset.html = textOf(li).innerHTML; }));
  sections.forEach(sec => { const h = $("h4", sec); if (h) h.dataset.html = h.innerHTML; });

  const applySearch = () => {
    const q = ruleSearchQuery.trim().toLowerCase();
    let hits = 0;
    sections.forEach(sec => {
      const h = $("h4", sec);
      const headingHit = !!q && !!h && h.textContent.toLowerCase().includes(q);
      if (h) h.innerHTML = headingHit ? highlightRuleHtml(">" + h.dataset.html + "<", q).slice(1, -1) : h.dataset.html;
      let secHits = 0;
      $$(".rule-item, .rule-note, .rule-subhead", sec).forEach(li => {
        const el = textOf(li);
        const match = !q || headingHit || el.textContent.toLowerCase().includes(q);
        li.hidden = !match;
        el.innerHTML = q && match ? highlightRuleHtml(">" + el.dataset.html + "<", q).slice(1, -1) : el.dataset.html;
        if (match && li.classList.contains("rule-item")) secHits++;
      });
      sec.hidden = !!q && !headingHit && !secHits;
      hits += secHits;
    });
    $$("#rules-list .rule-toc-link").forEach(btn => {
      const sec = sections[+btn.dataset.ruleJump];
      btn.classList.toggle("dimmed", !!sec?.hidden);
    });
    if (meta) meta.textContent = q ? `${hits} of ${totalRules} rule${totalRules===1?"":"s"}` : "";
    if (noResults){
      noResults.hidden = !q || hits > 0 || sections.some(s => !s.hidden);
      noResults.innerHTML = `No rules match "<strong>${escapeHtml(ruleSearchQuery.trim())}</strong>". <button type="button" class="link-btn" id="rule-search-clear">Clear search</button>`;
      $("#rule-search-clear")?.addEventListener("click", () => { ruleSearchQuery = ""; search.value = ""; applySearch(); search.focus(); });
    }
  };
  search?.addEventListener("input", () => { ruleSearchQuery = search.value; applySearch(); });
  search?.addEventListener("keydown", (e) => { if (e.key === "Escape"){ ruleSearchQuery = ""; search.value = ""; applySearch(); } });
  if (ruleSearchQuery) applySearch();

  $$("#rules-list .rule-toc-link").forEach(btn => btn.addEventListener("click", () => {
    $(`#rule-sec-${btn.dataset.ruleJump}`)?.scrollIntoView({ behavior:"smooth", block:"start" });
  }));

  // Scroll-spy: highlight whichever section is currently at the top of the
  // reading area in the rail's index.
  ruleSectionObserver?.disconnect();
  if (!("IntersectionObserver" in window) || !sections.length) return;
  const setActive = (idx) => $$("#rules-list .rule-toc-link").forEach(b => b.classList.toggle("active", b.dataset.ruleJump === String(idx)));
  const visible = new Set();
  ruleSectionObserver = new IntersectionObserver(entries => {
    entries.forEach(en => { en.isIntersecting ? visible.add(+en.target.dataset.idx) : visible.delete(+en.target.dataset.idx); });
    if (visible.size) setActive(Math.min(...visible));
  }, { rootMargin: "-90px 0px -55% 0px" });
  sections.forEach(s => ruleSectionObserver.observe(s));
}

/* ───────── Email Templates ───────── */
// Email templates that ship with the app (js/builtin-email-templates.js):
// any whose title isn't in the shared table yet get added in one go, the
// first time someone signed in loads the CRM. Remembered per browser.
let builtinEmailTemplatesChecked = false;
async function ensureBuiltinEmailTemplates(){
  if (builtinEmailTemplatesChecked || !IS_CONFIGURED || !state.user || !state.emailTemplatesLoaded) return;
  builtinEmailTemplatesChecked = true;
  const KEY = "mp_builtin_et_v1";
  let seen = {}; try { seen = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch(e){}
  const have = new Set(state.emailTemplates.map(t => (t.title || "").trim().toLowerCase()));
  const rows = (window.MP_BUILTIN_EMAIL_TEMPLATES || []).filter(t => !seen[t.title] && !have.has(t.title.toLowerCase()))
    .map(({ title, subject, body, sort_order }) => ({ title, subject, body, sort_order }));
  if (rows.length){
    const { error } = await supabase.from("email_templates").insert(rows);
    if (error){ console.error(error); return; }
    await DataLayer.fetchAll(); renderAll();
  }
  (window.MP_BUILTIN_EMAIL_TEMPLATES || []).forEach(t => { seen[t.title] = 1; });
  try { localStorage.setItem(KEY, JSON.stringify(seen)); } catch(e){}
}
// "Group · Name" titles are listed under a heading for the group.
const etSplit = (title) => { const i = String(title || "").indexOf(" · "); return i > 0 ? [title.slice(0, i), title.slice(i + 3)] : ["", title || ""]; };
function renderEmailTemplates(){
  ensureBuiltinEmailTemplates();
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
  let lastGroup = null;
  listEl.innerHTML = list.map(t => {
    const [group, name] = etSplit(t.title);
    const head = group !== lastGroup ? `<div class="et-group-head">${escapeHtml(group || "Templates")}</div>` : "";
    lastGroup = group;
    return `${head}
    <button type="button" class="playbook-list-item ${t.id === state.selectedEmailTemplateId ? "active" : ""}" data-action="select-email-template" data-id="${t.id}">
      <span class="playbook-list-item-icon">${ICONS.book}</span>
      <span class="playbook-list-item-text">
        <div class="playbook-list-item-title">${escapeHtml(name)}</div>
        <div class="playbook-list-item-sub">${escapeHtml(t.subject || "No subject set")}</div>
      </span>
    </button>
  `;}).join("");
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
// One Call button everywhere a phone number shows up outside the Dialer
// itself (Contacts, Deals) - reuses the same Twilio Device placeCall() the
// Dialer uses when Supabase is configured, falls back to a plain tel: link
// in demo mode same as the Dialer's own IS_CONFIGURED branch does.
function callButtonHtml(phone, name){
  if (!phone) return "";
  const label = `Call ${formatPhone(phone)}`;
  return IS_CONFIGURED
    ? `<button class="icon-btn" data-action="call-number" data-phone="${escapeHtml(phone)}" data-name="${escapeHtml(name||"")}" title="${escapeHtml(label)}">${ICONS.phone}</button>`
    : `<a class="icon-btn" href="tel:${escapeHtml(phone.replace(/[^0-9+]/g,""))}" title="${escapeHtml(label)}">${ICONS.phone}</a>`;
}

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

  $("#pbx")?.addEventListener("input", (e) => {
    if (e.target.id !== "pbx-search") return;
    pbSearch = e.target.value; renderPlaybooks();
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
    if (deal) window.bookMeetingInTracker?.(company || name, x, y, slotIdx);
    if (!IS_CONFIGURED) return; renderAll();
  });

  $("#add-deal-btn").addEventListener("click", () => {
    $("#deal-form").reset();
    $("#deal-form-id").value = "";
    $("#deal-contract-type").value = "retainer";
    $("#deal-assignee").value = "";
    toggleDealContractFields();
    toggleDealCommissionFields();
    $("#deal-modal-title").textContent = "New Deal";
    $("#deal-contacts-rows").innerHTML = "";
    addDealContactRow();
    openModal("deal-modal");
  });
  $("#deal-contract-type")?.addEventListener("change", toggleDealContractFields);
  $("#deal-commission")?.addEventListener("input", updateDealCommissionVisibility);
  $("#deal-assignee")?.addEventListener("change", toggleDealCommissionFields);
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
    const isMoneyType = contractType === "retainer" || contractType === "ppl";
    const row = {
      title: $("#deal-title").value.trim(),
      contract_type: contractType,
      value: isMoneyType ? Number($("#deal-value").value || 0) : 0,
      percentage: isMoneyType ? null : Number($("#deal-percentage").value || 0),
      stage: $("#deal-stage").value,
      contact_id: contactId,
      contact_name: contactId ? contactName(contactId) : "",
      assignee: $("#deal-assignee").value || null,
      commission_initial_amount: $("#deal-commission").value !== "" ? Number($("#deal-commission").value) : null,
      commission_invoice_date: $("#deal-commission-invoice-date").value || null,
      updated_at: new Date().toISOString(),
    };
    if (!row.title) return;
    const stageBefore = id ? state.deals.find(d => d.id === id)?.stage : null;
    const deal = id ? await DataLayer.update("deals", id, row) : await DataLayer.insert("deals", { ...row, notes: "" });
    if (deal) await saveDealContactRows(deal.id);
    const createdClient = deal ? await maybeCreateClientFromDeal(deal) : null;
    if (deal && !createdClient && row.stage === "onboarding" && stageBefore !== "onboarding") openWelcomePackForDeal(deal);
    if (deal) await maybeCreateNoShowFollowup(deal);
    if (deal) await onDealStageChanged(deal, stageBefore);
    // Keep the linked client's Ad Start Date lined up with what was just
    // entered here as the invoice date - one date, editable from either
    // Deals or Clients, instead of two fields that can drift apart.
    if (deal){
      const linkedClient = clientForDeal(deal.id);
      if (linkedClient && linkedClient.ad_start_date !== row.commission_invoice_date){
        await DataLayer.update("clients", linkedClient.id, { ad_start_date: row.commission_invoice_date });
      }
    }
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
  $("#prospect-region")?.addEventListener("change", (e) => {
    if (e.target.value) $("#prospect-country-code").value = countryCodeForRegion(e.target.value);
  });
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
      phone: $("#client-phone").value.trim(),
      email: $("#client-email").value.trim(),
      website: $("#client-website").value.trim(),
      industry: $("#client-industry").value.trim() || null,
      cost_per_lead: $("#client-cpl").value !== "" ? Number($("#client-cpl").value) : null,
      monthly_ad_spend: $("#client-monthly-ad-spend").value !== "" ? Number($("#client-monthly-ad-spend").value) : null,
      quote_target: $("#client-quote-target").value !== "" ? Number($("#client-quote-target").value) : null,
      notes: $("#client-notes").value.trim(),
      meta_ad_account_id: $("#client-meta-account").value.trim(),
      ad_start_date: $("#client-ad-start-date").value || null,
      report_email: $("#client-report-email").value.trim(),
      churn_risk: $("#client-churn-risk").value || null,
      stage,
      updated_at: new Date().toISOString(),
    };
    if (!existing || existing.stage !== stage) row.stage_changed_at = new Date().toISOString();
    if (!row.name) return;
    let savedId = id;
    if (id) await DataLayer.update("clients", id, row);
    else savedId = (await DataLayer.insert("clients", row))?.id;
    closeModal("client-modal");
    const enteredOnboarding = stage === "onboarding" && (!existing || existing.stage !== "onboarding");
    if (IS_CONFIGURED) renderAll();
    if (enteredOnboarding && savedId) openWelcomePack(savedId);
  });

  $("#client-info-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = $("#client-info-form-id").value;
    if (!id) return;
    const row = {
      services: $("#client-info-services-input").value.trim(),
      renewal_date: $("#client-info-renewal-input").value || null,
      qualified_lead_structure: $("#client-info-qls-input").value.trim(),
      key_contacts: $("#client-info-contacts-input").value.trim(),
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
  setupClientsBoardDrag();
  $$("[data-cl-view]").forEach(btn => btn.addEventListener("click", () => {
    state.clientsView = btn.dataset.clView;
    try { localStorage.setItem("mp_clients_view", state.clientsView); } catch(e){}
    renderClientsList();
  }));
  $("#clients-stage-chips")?.addEventListener("click", (e) => {
    const chip = e.target.closest("[data-cl-filter]");
    if (!chip) return;
    state.clientsStageFilter = chip.dataset.clFilter;
    renderClientsList();
  });
  $("#clients-gallery")?.addEventListener("change", async (e) => {
    const sel = e.target.closest(".client-stage-select");
    if (!sel) return;
    const before = state.clients.find(x => x.id === sel.dataset.id)?.stage || "onboarding";
    await DataLayer.update("clients", sel.dataset.id, { stage: sel.value, stage_changed_at: new Date().toISOString(), updated_at: new Date().toISOString() });
    if (sel.value === "onboarding" && before !== "onboarding") openWelcomePack(sel.dataset.id);
    if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll();
  });

  $("#add-ad-creative-btn")?.addEventListener("click", () => {
    $("#ad-creative-form").reset(); $("#ad-creative-form-id").value=""; $("#ad-creative-modal-title").textContent="Add Ad Creative";
    $("#ad-creative-current-image").innerHTML = "";
    populateAdCreativeClientSelect(state.selectedClientId);
    populateAdCreativeCampaignSelect(state.selectedClientId);
    openModal("ad-creative-modal");
  });
  $("#vs-root")?.addEventListener("input", (e) => { if (e.target.closest("#vs-editor") && e.target.id !== "vs-stage") vsQueueSave(); });
  $("#vs-root")?.addEventListener("change", async (e) => {
    if (e.target.id !== "vs-stage") return;
    await vsSaveNow();
    const row = state.clientContent.find(r => r.id === vsOpenId); if (!row) return;
    const d = vsData(row); d.stage = e.target.value;
    const patch = { script: JSON.stringify(d), status: (VS_STAGES.find(s => s.key === d.stage) || VS_STAGES[0]).status };
    Object.assign(row, patch); await DataLayer.update("client_content", row.id, patch);
  });
  $("#vs-email-copy")?.addEventListener("click", async (e) => {
    try { await navigator.clipboard.writeText($("#vs-email-subject").value + "\n\n" + $("#vs-email-body").value); e.target.textContent = "Copied"; setTimeout(() => { e.target.textContent = "Copy email"; }, 1500); } catch(err){}
  });
  $("#am-root")?.addEventListener("change", async (e) => {
    const inp = e.target.closest(".am-slot-title");
    if (!inp) return;
    await amSetSlot(inp.dataset.id, inp.dataset.slot, { t: inp.value.trim() });
  });
  $("#creative-view-toggle")?.addEventListener("click", (e) => { const b = e.target.closest("[data-cr-view]"); if (b) setCreativeView(b.dataset.crView); });
  $("#creative-stats-view")?.addEventListener("click", (e) => {
    const scope = e.target.closest("[data-cs-scope]");
    if (scope){ csScope = scope.dataset.csScope; renderCreativeStats(); }
    if (e.target.closest('[data-action="cs-refresh-ghl"]')) csPullGhl(true);
  });
  $("#creative-stats-view")?.addEventListener("change", async (e) => {
    const sel = e.target.closest(".cs-ind-select");
    if (!sel || !sel.value) return;
    await DataLayer.update("clients", sel.dataset.client, { industry: sel.value, updated_at: new Date().toISOString() });
    if (IS_CONFIGURED) await DataLayer.fetchAll();
    renderCreativeStats();
  });
  $("#add-creative-lib-btn")?.addEventListener("click", () => {
    $("#ad-creative-form").reset(); $("#ad-creative-form-id").value=""; $("#ad-creative-modal-title").textContent="Add Ad Creative";
    $("#ad-creative-current-image").innerHTML = "";
    populateAdCreativeClientSelect(state.creativeFilter.client);
    populateAdCreativeCampaignSelect(state.creativeFilter.client);
    openModal("ad-creative-modal");
  });
  $("#ad-creative-client")?.addEventListener("change", (e) => populateAdCreativeCampaignSelect(e.target.value));
  $("#link-ad-account-btn")?.addEventListener("click", () => {
    $("#link-ad-account-form").reset();
    populateLinkAdAccountClientSelect();
    $("#link-ad-account-new-name-field").style.display = "";
    openModal("link-ad-account-modal");
  });
  $("#link-ad-account-client")?.addEventListener("change", (e) => {
    const isNew = e.target.value === "__new__";
    $("#link-ad-account-new-name-field").style.display = isNew ? "" : "none";
    if (isNew){
      $("#link-ad-account-new-name").value = "";
      $("#link-ad-account-id-input").value = "";
    } else {
      const c = state.clients.find(x => x.id === e.target.value);
      $("#link-ad-account-id-input").value = c?.meta_ad_account_id || "";
    }
  });
  $("#link-ad-account-form")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const metaAccountId = $("#link-ad-account-id-input").value.trim();
    if (!metaAccountId) return;
    const selected = $("#link-ad-account-client").value;
    const submitBtn = $("#link-ad-account-submit");
    let clientId;
    if (selected === "__new__"){
      const name = $("#link-ad-account-new-name").value.trim();
      if (!name){ alert("Give the new client a name."); return; }
      const created = await DataLayer.insert("clients", { name, meta_ad_account_id: metaAccountId, stage: "onboarding" });
      if (!created) return;
      clientId = created.id;
    } else {
      clientId = selected;
      await DataLayer.update("clients", clientId, { meta_ad_account_id: metaAccountId, updated_at: new Date().toISOString() });
    }
    closeModal("link-ad-account-modal");
    await syncClientAds(clientId, submitBtn);
  });
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
      client_id: $("#ad-creative-client").value || null,
      campaign_id: $("#ad-creative-campaign").value || null,
      name: $("#ad-creative-name").value.trim(),
      meta_ad_id: $("#ad-creative-meta-id").value.trim() || null,
      result: $("#ad-creative-result").value,
      notes: $("#ad-creative-notes").value.trim(),
    };
    // New creatives need a client; an existing one from a deleted client can stay unlinked.
    if (!row.name || (!id && !row.client_id)) return;
    if (file){
      const imageUrl = await uploadAdCreativeImage(file);
      if (imageUrl) row.image_url = imageUrl;
    }
    // Picking a different performer tag by hand keeps it, even over the $50 rule.
    const before = id ? state.adCreatives.find(x => x.id === id) : null;
    if (before && before.result !== row.result) row.result_manual = true;
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
    if (action.startsWith("onb-") && await handleOnbAction(action, id, btn)) return;
    if (action === "delete-contact" && confirm("Delete this contact?")) await DataLayer.remove("contacts", id);
    if (action === "select-playbook"){ state.selectedPlaybookId = id; pbSearch = ""; renderPlaybooks(); window.scrollTo({ top: 0, behavior: "smooth" }); }
    if (action === "pbx-home"){ state.selectedPlaybookId = null; renderPlaybooks(); window.scrollTo({ top: 0 }); }
    if (action === "pbx-add") $("#add-playbook-btn")?.click();
    if (action === "pbx-goto") pbGoto(+btn.dataset.sec);
    if (action === "pbx-open-at"){
      state.selectedPlaybookId = id; pbSearch = ""; renderPlaybooks(); window.scrollTo({ top: 0 });
      if (+btn.dataset.sec >= 0) setTimeout(() => pbGoto(+btn.dataset.sec), 60);
    }
    if (action === "pb-copy-say"){
      const text = btn.closest(".pb-say")?.querySelector(".pb-say-text")?.textContent || "";
      try { await navigator.clipboard.writeText(text); } catch(e){}
      btn.textContent = "Copied"; btn.classList.add("copied");
      setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("copied"); }, 1400);
    }
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
    if (action === "select-rule"){ if (state.selectedRuleId !== id) ruleSearchQuery = ""; state.selectedRuleId = id; renderRules(); window.scrollTo({ top:0, behavior:"smooth" }); }
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
      $("#deal-commission").value = d.commission_initial_amount ?? "";
      $("#deal-commission-invoice-date").value = clientForDeal(d.id)?.ad_start_date || d.commission_invoice_date || "";
      toggleDealContractFields();
      updateDealCommissionVisibility();
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
    if (action === "dial-tel"){
      // Deliberately not logging an outcome here - see the matching comment
      // in startCall(). The prospect stays put as Up Now until a real
      // outcome gets picked from the buttons right below the Call button.
      const activePerson = window.getActivePerson ? window.getActivePerson() : null;
      if (activePerson) DataLayer.update("dial_prospects", id, { claimed_by: activePerson, claimed_at: new Date().toISOString() });
    }
    if (action === "start-call") await startCall(id);
    // Calling straight off a Contact or a Deal - same Twilio Device as the
    // Dialer, just skipping the dial_prospects queue/claim entirely since
    // there's no prospect row backing these calls.
    if (action === "call-number") await placeCall(btn.dataset.phone, btn.dataset.name);
    if (action === "dial-outcome"){
      // Call Back and Not Interested both need a required field captured
      // (a follow-up date, or a reason why) that a one-click button can't
      // supply, so those two route through the same modal Prospecting uses.
      // Disqualified is deliberately a single click straight to the next
      // prospect, same as No Answer / Booked Meeting - no reason required.
      if (outcome === "call_back" || outcome === "not_interested"){
        openLogCallModal(state.prospects.find(x => x.id === id), outcome);
      } else {
        await logDialOutcome(id, outcome);
      }
    }
    if (action === "reactivate-prospect") await reactivateProspect(id);
    if (action === "toggle-stage-expand"){
      const key = btn.dataset.stage;
      state.expandedStages[key] = !state.expandedStages[key];
      renderDealsList();
      return;
    }
    if (action === "filter-region-coverage"){
      const country = AU_REGIONS.includes(btn.dataset.region) ? "AU" : "NZ";
      if (state.dialerCountry !== country){ state.dialerCountry = country; try { localStorage.setItem(DIALER_COUNTRY_KEY, country); } catch(e){} }
      state.dialerFilter.region = btn.dataset.region;
      state.dialerFilter.industry = "";
      renderProspectViews();
      $('.nav-item[data-page="dialer"]')?.click();
    }
    if (action === "complete-vertical"){
      const region = btn.dataset.region, industry = btn.dataset.industry;
      const activePerson = window.getActivePerson ? window.getActivePerson() : null;
      await DataLayer.insert("completed_verticals", { region, industry, completed_at: new Date().toISOString(), completed_by: state.user?.email || activePerson || "demo" });
      if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll();
    }
    if (action === "reactivate-vertical") { await DataLayer.remove("completed_verticals", id); if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll(); }
    if (action === "complete-region"){
      const region = btn.dataset.region;
      if (!confirm(`Mark ${region} as completed? Its prospects come off Prospecting for everyone until you reopen it.`)) return;
      const activePerson = window.getActivePerson ? window.getActivePerson() : null;
      await DataLayer.insert("completed_verticals", { region, industry: REGION_DONE, completed_at: new Date().toISOString(), completed_by: state.user?.email || activePerson || "demo" });
      if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll();
    }
    if (action === "reopen-region"){
      if (!confirm(`Reopen ${btn.dataset.region}? Its prospects come back into Prospecting.`)) return;
      await DataLayer.remove("completed_verticals", id); if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll();
    }
    if (action === "view-client"){ state.selectedClientId = id; renderClients(); $('.nav-item[data-page="clients"]')?.click(); }
    if (action === "back-to-clients"){ state.selectedClientId = null; renderClients(); }
    if (action === "toggle-board-col"){
      const key = btn.dataset.key;
      if (boardExpanded.has(key)) boardExpanded.delete(key); else boardExpanded.add(key);
      if (key.startsWith("onb:")) renderOnboarding(); else if (key.startsWith("ws:")) renderWorkshops(); else renderClientsList();
      return;
    }
    if (action === "toggle-creative-seg"){
      const key = btn.dataset.key;
      if (state.creativeSegOpen.has(key)) state.creativeSegOpen.delete(key); else state.creativeSegOpen.add(key);
      renderCreativeLibrary();
      return;
    }
    if (action === "jump-creative-seg"){
      const key = btn.dataset.key;
      const seg = CREATIVE_SEGMENTS.find(x => x.key === key);
      if (seg?.collapsed && !state.creativeSegOpen.has(key)){ state.creativeSegOpen.add(key); renderCreativeLibrary(); }
      document.getElementById("cr-seg-" + key)?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    if (action === "open-workshops-page"){ $('.nav-item[data-page="workshops"]')?.click(); return; }
    if (action === "vs-new"){ const cid = $("#vs-new-client")?.value; if (!cid){ $("#vs-new-client")?.focus(); return; } await vsCreate(cid); window.scrollTo({ top: 0 }); return; }
    if (action === "vs-open"){ vsOpenId = id; renderContentLibrary(); window.scrollTo({ top: 0 }); return; }
    if (action === "vs-close"){ await vsSaveNow(); vsOpenId = null; renderContentLibrary(); return; }
    if (action === "vs-email"){ await vsMakeEmail(); return; }
    if (action === "vs-delete"){ if (!confirm("Delete this script?")) return; await DataLayer.remove("client_content", id); vsOpenId = null; if (IS_CONFIGURED) await DataLayer.fetchAll(); renderContentLibrary(); return; }
    if (action === "am-script"){
      const ym = amYm(), existing = vsRows().find(r => r.client_id === id && vsData(r).month === ym);
      $('.nav-item[data-page="content-library"]')?.click();
      if (existing){ vsOpenId = existing.id; renderContentLibrary(); } else await vsCreate(id, ym);
      window.scrollTo({ top: 0 }); return;
    }
    if (action === "am-month"){
      const step = +btn.dataset.step, base = new Date(amYm() + "-01T00:00:00");
      if (step === 0) state.amMonth = null; else { base.setMonth(base.getMonth() + step); state.amMonth = ymOf(localDayStr(base)); }
      if (state.amMonth === ymOf(localDayStr())) state.amMonth = null;
      renderAdsMonth(); return;
    }
    if (action === "am-filter"){ state.amFilter = btn.dataset.filter; renderAdsMonth(); return; }
    if (action === "am-tap"){
      const c = state.clients.find(x => x.id === id);
      const cur = amClientProgress(c).slots.find(s => s.key === btn.dataset.slot)?.status || "";
      const next = AM_CYCLE[cur] ?? "made";
      const r = btn.getBoundingClientRect();
      await amSetSlot(id, btn.dataset.slot, { s: next });
      renderAdsMonth(); renderClients();
      if (next === "live") pbConfetti(r.left + r.width / 2, r.top, 22);
      return;
    }
    if (action === "am-set"){
      const c = state.clients.find(x => x.id === id);
      const cur = amClientProgress(c).slots.find(s => s.key === btn.dataset.slot)?.status || "";
      // Tapping the step it's already on steps it back one.
      const steps = AM_STEPS.map(x => x.key), want = btn.dataset.step;
      const next = cur === want ? (steps[steps.indexOf(want) - 1] || "") : want;
      await amSetSlot(id, btn.dataset.slot, { s: next });
      renderAdsMonth(); renderClients();
      if (next === "live"){ const r = btn.getBoundingClientRect(); if (typeof pbConfetti === "function") pbConfetti(r.left + r.width / 2, r.top, 22); }
      return;
    }
    if (action === "toggle-churned"){ state.showChurned = !state.showChurned; renderClients(); return; }
    if (action === "open-onboarding-board"){ const c = state.clients.find(x => normalizeClientStage(x.stage) === "onboarding"); if (c) openOnbModal(c.id); }
    if (action === "creatives-done"){
      const c = state.clients.find(x => x.id === id);
      if (c) await moveClientStage(c, "live");
    }
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
      await DataLayer.update("clients", id, { stage: "live", stage_changed_at: new Date().toISOString() });
      if (!IS_CONFIGURED) return; await DataLayer.fetchAll(); renderAll();
    }
    if (action === "open-welcome-pack"){ if (state.selectedClientId) openWelcomePack(state.selectedClientId); }
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
      $("#client-info-qls-input").value = c.qualified_lead_structure||"";
      $("#client-info-contacts-input").value = c.key_contacts||"";
      openModal("client-info-modal");
    }
    if (action === "delete-client-row"){
      const c = state.clients.find(x => x.id === id);
      if (c && confirm(DELETE_CLIENT_CONFIRM(c.name))) await deleteClientKeepingCreatives(c);
    }
    if (action === "delete-client"){
      const c = state.clients.find(x => x.id === state.selectedClientId);
      if (c && confirm(DELETE_CLIENT_CONFIRM(c.name))) await deleteClientKeepingCreatives(c);
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
      if (!a.client_id || !state.clients.some(c => c.id === a.client_id)){
        const sel = $("#ad-creative-client");
        sel.insertAdjacentHTML("afterbegin", `<option value="">${escapeHtml(a.client_name || archivedClientName(a.client_id) || "No client")} (deleted)</option>`);
        sel.value = "";
      }
      populateAdCreativeCampaignSelect(a.client_id, a.campaign_id);
      $("#ad-creative-name").value = a.name||"";
      $("#ad-creative-meta-id").value = a.meta_ad_id||"";
      const resultSel = $("#ad-creative-result");
      resultSel.querySelector('option[value="engagement"]')?.remove();
      if (a.result === "engagement") resultSel.insertAdjacentHTML("beforeend", `<option value="engagement">Engagement Post</option>`);
      resultSel.value = a.result||"testing";
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
    if (action.startsWith("make-report") || action === "make-plan" || action.startsWith("rp-")){ if (await handleReportAction(action, id)) return; }
    if (action.startsWith("ws-") && await handleWorkshopAction(action, id, btn)) return;
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
function renderProspectViews(){ renderDialer(); renderProspectList(); renderRegionData(); }
function setupDialerFilters(){
  $("#dialer-search")?.addEventListener("input", (e) => { state.dialerFilter.search = e.target.value; renderProspectViews(); });
  $("#dialer-filter-region")?.addEventListener("change", (e) => { state.dialerFilter.region = e.target.value; state.dialerFilter.industry = ""; renderProspectViews(); });
  $$("#dialer-country [data-country]").forEach(b => b.addEventListener("click", () => setDialerCountry(b.dataset.country)));
  $("#dialer-filter-industry")?.addEventListener("change", (e) => { state.dialerFilter.industry = e.target.value; renderProspectViews(); });
  $("#dialer-filter-owner")?.addEventListener("change", (e) => { state.dialerOwnerFilter = e.target.value; renderProspectViews(); });
  $("#dialer-queue-view-select")?.addEventListener("change", (e) => { state.dialerQueueView = e.target.value; renderProspectViews(); });
  // Switching who's dialing also re-scopes the leads filter to that
  // person's own leads, so switching "You are" from Rocky to Max shows
  // Max's leads instead of leaving Rocky's leads on screen under Max's name.
  // (Industry scoping itself now comes straight from their Team Focus
  // assignment on every render - see renderProspectList - rather than a
  // one-off manual filter set here, which used to go stale across a switch.)
  $("#dialer-person-select")?.addEventListener("change", (e) => {
    window.setActivePerson?.(e.target.value);
    state.dialerOwnerFilter = e.target.value;
    renderProspectViews();
  });
  $("#dialer-playbook-select")?.addEventListener("change", async (e) => {
    const activePerson = window.getActivePerson ? window.getActivePerson() : null;
    if (activePerson) await savePlaybookUsage(activePerson, e.target.value);
  });
  $("#dialer-call-mode")?.addEventListener("change", (e) => { setCallMode(e.target.value); renderDialer(); });
  $("#dialer-view-playbook-btn")?.addEventListener("click", () => {
    const id = $("#dialer-playbook-select")?.value;
    if (!id){ alert("Pick a playbook first."); return; }
    state.selectedPlaybookId = id;
    // Nav click only toggles page visibility (see setupNav) - renderAll
    // already keeps every page's markup current regardless of which is
    // showing, but the Playbooks pane needs an explicit re-render here so
    // it reflects the pick made just now rather than whatever was selected
    // last time renderAll happened to run.
    renderPlaybooks();
    $('.nav-item[data-page="playbooks"]')?.click();
  });
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
  setupWelcomePack();
  setupOnboarding();
  setupReporting();
  setupReceipts();
  setupNurture();
  setupJarvis();
  setupPlans();
  setupWorkshops();
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
