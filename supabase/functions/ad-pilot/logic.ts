// Ad pilot - the parts with no network: turning Meta's numbers into the
// picture Claude sees, what Claude must answer with, and the hard limits every
// suggestion has to pass before it can be shown, approved or run by itself.

export type Settings = {
  auto_on?: boolean;
  max_change_pct?: number;
  max_daily_budget?: number | null;
  target_cpl?: number | null;
  monthly_budget?: number | null;
  notes?: string | null;
};

export type Row = { spend: number; leads: number; clicks: number; impressions: number };
const zero = (): Row => ({ spend: 0, leads: 0, clicks: 0, impressions: 0 });

// Meta counts a lead under a few names; the biggest one is the real number.
export function leadsOf(actions: any[] | undefined): number {
  const pick = (t: string) => Number((actions || []).find((a: any) => a?.action_type === t)?.value || 0);
  return Math.max(pick("lead"), pick("onsite_conversion.lead_grouped"), pick("leadgen_grouped"), pick("offsite_conversion.fb_pixel_lead"));
}
export function rowOf(i: any): Row {
  return { spend: Number(i?.spend || 0), leads: leadsOf(i?.actions), clicks: Number(i?.clicks || 0), impressions: Number(i?.impressions || 0) };
}
const add = (a: Row, b: Row): Row => ({ spend: a.spend + b.spend, leads: a.leads + b.leads, clicks: a.clicks + b.clicks, impressions: a.impressions + b.impressions });
const cpl = (r: Row) => (r.leads ? Math.round((r.spend / r.leads) * 100) / 100 : null);
const money = (n: any) => (n == null || n === "" ? null : Math.round(Number(n)) / 100); // Meta budgets are in cents

export type Account = {
  campaigns: any[]; // id, name, effective_status, daily_budget, lifetime_budget
  adsets: any[];    // id, name, campaign_id, effective_status, daily_budget, lifetime_budget
  ads: any[];       // id, name, adset_id, campaign_id, effective_status
  ins7: any[];      // ad-level insights, last 7 days
  ins30: any[];     // ad-level insights, last 30 days
  crm?: Record<string, { leads: number; quotes: number; won: number }>; // by ad id, from their app (30 days)
};

// The picture Claude gets, and the one the CRM shows: every live ad set with
// its budget and its ads, numbers for 7 and 30 days, plus totals.
export function summarise(acc: Account) {
  const by7 = new Map(acc.ins7.map((i) => [String(i.ad_id), rowOf(i)]));
  const by30 = new Map(acc.ins30.map((i) => [String(i.ad_id), rowOf(i)]));
  const camp = new Map(acc.campaigns.map((c) => [String(c.id), c]));
  const live = (s: string) => ["ACTIVE", "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW"].includes(s);
  let t7 = zero(), t30 = zero();
  const ads = acc.ads.map((a) => {
    const r7 = by7.get(String(a.id)) || zero(), r30 = by30.get(String(a.id)) || zero();
    t7 = add(t7, r7); t30 = add(t30, r30);
    const c = acc.crm?.[String(a.id)];
    return {
      id: String(a.id), name: a.name || "", adset_id: String(a.adset_id || ""), status: a.effective_status || "",
      d7: { ...r7, cpl: cpl(r7) }, d30: { ...r30, cpl: cpl(r30) },
      crm30: c ? { leads: c.leads, quotes: c.quotes, won: c.won } : null,
    };
  }).filter((a) => live(a.status) || a.d30.spend > 0);
  const adsets = acc.adsets.map((s) => {
    const mine = ads.filter((a) => a.adset_id === String(s.id));
    const c = camp.get(String(s.campaign_id)) || {};
    const r7 = mine.reduce((x, a) => add(x, a.d7), zero()), r30 = mine.reduce((x, a) => add(x, a.d30), zero());
    // The budget sits on the ad set, or on the campaign (Advantage campaign budget).
    const onCampaign = s.daily_budget == null && c.daily_budget != null;
    return {
      id: String(s.id), name: s.name || "", status: s.effective_status || "", campaign: c.name || "", campaign_id: String(s.campaign_id || ""),
      daily_budget: onCampaign ? null : money(s.daily_budget), campaign_daily_budget: onCampaign ? money(c.daily_budget) : null,
      d7: { ...r7, cpl: cpl(r7) }, d30: { ...r30, cpl: cpl(r30) }, ads: mine.map((a) => a.id),
    };
  }).filter((s) => live(s.status) || s.d30.spend > 0);
  return {
    totals: { d7: { ...t7, cpl: cpl(t7) }, d30: { ...t30, cpl: cpl(t30) } },
    live_ads: ads.filter((a) => live(a.status)).length,
    adsets,
    ads,
  };
}

// What Claude has to answer with (structured outputs).
const nullable = (t: string) => ({ anyOf: [{ type: t }, { type: "null" }] });
export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "health", "suggestions", "lessons"],
  properties: {
    summary: { type: "string", description: "2-3 short plain-English sentences for a busy owner: how the account is going and what matters." },
    health: { type: "string", enum: ["good", "watch", "bad"] },
    suggestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "target_type", "target_id", "new_daily_budget", "reason", "impact", "risk"],
        properties: {
          kind: { type: "string", enum: ["pause", "resume", "budget", "flag"] },
          target_type: { type: "string", enum: ["ad", "adset", "campaign", "account"] },
          target_id: { type: "string", description: "The exact id from the data (use the account id for an account-wide flag)." },
          new_daily_budget: { ...nullable("number"), description: "Dollars per day, only for kind=budget." },
          reason: { type: "string", description: "Why, in one or two plain sentences with the numbers." },
          impact: { type: "string", description: "What we expect to happen, one short sentence." },
          risk: { type: "string", enum: ["low", "high"] },
        },
      },
    },
    lessons: { type: "array", items: { type: "string" }, description: "0-2 new, general lessons worth remembering for future reviews (only if clearly supported by the numbers)." },
  },
};

export const SYSTEM = `You are the ad manager for Mr Priceless, a marketing agency for tradies in New Zealand and Australia. Every client runs Meta lead ads; leads go to the tradie's own app, where they call them, quote and win jobs.
Each day you review one client's Meta ad account and suggest the few changes that will most lower the cost per quote and cost per job won, while keeping spend on budget.
Rules:
- Only use ids that appear in the data. Never invent an ad, ad set or campaign.
- Prefer fewer, clearly justified changes. If nothing needs doing, return no suggestions.
- Don't judge an ad on tiny numbers: under roughly 2x the target cost per lead spent, or under 1,000 impressions, it hasn't had a fair go.
- Leads that became quotes / jobs in the client's app (crm30) matter more than Meta's lead count.
- Keep at least one ad running in every live ad set; never pause the last one.
- Budget moves: the new_daily_budget is the whole new daily amount in dollars, on the ad set (or the campaign when the budget lives there). Stay within the limits given.
- risk "low" only for: pausing an ad that has clearly failed by the rules above, turning back on an ad you paused that was a top performer, or a budget move within the allowed percentage. Everything else is "high".
- Use kind "flag" for problems a person must look at (ads rejected, account or billing issues, spend far off the monthly budget, no leads for days, tracking looking broken). Flags never change anything.
- Write for a busy tradie-agency owner: short, plain words, no jargon, include the numbers.
- Follow the playbook lessons and the team's past "not now" notes.`;

export type Suggestion = { kind: string; target_type: string; target_id: string; new_daily_budget: number | null; reason: string; impact: string; risk: string };
export type Checked = Suggestion & { target_name: string; current_value: number | null; new_value: number | null; autoOk: boolean };

// Every suggestion goes through this before it's saved: the target must be
// real, budgets stay inside the limits, the last ad in an ad set can't be
// paused, and only clearly small changes may run by themselves.
export function check(s: Suggestion, sum: ReturnType<typeof summarise>, settings: Settings, accountId: string): Checked | null {
  const maxPct = Math.min(50, Math.max(5, Number(settings.max_change_pct) || 20));
  const base = { ...s, target_name: "", current_value: null as number | null, new_value: null as number | null, autoOk: false };
  if (s.kind === "flag") {
    const t = s.target_type === "ad" ? sum.ads.find((a) => a.id === s.target_id) : s.target_type === "adset" ? sum.adsets.find((a) => a.id === s.target_id) : null;
    return { ...base, risk: "high", target_name: t?.name || "Ad account", target_id: t ? s.target_id : accountId, target_type: t ? s.target_type : "account" };
  }
  if (s.kind === "pause" || s.kind === "resume") {
    if (s.target_type !== "ad") return null; // stage 1: ads only
    const ad = sum.ads.find((a) => a.id === s.target_id);
    if (!ad) return null;
    const running = ["ACTIVE", "IN_PROCESS", "WITH_ISSUES", "PENDING_REVIEW"].includes(ad.status);
    if (s.kind === "pause") {
      if (!running) return null;
      const set = sum.adsets.find((x) => x.id === ad.adset_id);
      const others = set ? set.ads.filter((id) => id !== ad.id && ["ACTIVE", "IN_PROCESS"].includes(sum.ads.find((a) => a.id === id)?.status || "")) : [];
      if (!others.length) return null;
      // Small enough to run by itself: it had a fair go and got nothing (or far too dear).
      const target = Number(settings.target_cpl) || 0;
      const fairGo = target ? ad.d7.spend >= 2 * target : ad.d7.spend >= 60;
      const failed = ad.d7.leads === 0 || (target > 0 && (ad.d7.cpl || 0) >= 2.5 * target);
      return { ...base, target_name: ad.name, autoOk: s.risk === "low" && fairGo && failed && !(ad.crm30 && ad.crm30.quotes > 0) };
    }
    if (running) return null;
    return { ...base, target_name: ad.name, autoOk: false };
  }
  if (s.kind === "budget") {
    const nb = Number(s.new_daily_budget);
    if (!(nb > 0)) return null;
    let current: number | null = null, name = "", type = s.target_type, id = s.target_id;
    const set = sum.adsets.find((x) => x.id === s.target_id || (x.campaign_id === s.target_id && x.campaign_daily_budget != null));
    if (!set) return null;
    if (set.daily_budget != null) { current = set.daily_budget; name = set.name; type = "adset"; id = set.id; }
    else if (set.campaign_daily_budget != null) { current = set.campaign_daily_budget; name = set.campaign; type = "campaign"; id = set.campaign_id; }
    if (current == null || current <= 0) return null;
    let next = Math.round(nb * 100) / 100;
    const hi = Math.round(current * (1 + maxPct / 100) * 100) / 100, lo = Math.round(current * (1 - maxPct / 100) * 100) / 100;
    next = Math.min(hi, Math.max(lo, next));
    if (settings.max_daily_budget && next > Number(settings.max_daily_budget)) next = Number(settings.max_daily_budget);
    if (Math.abs(next - current) < 1) return null;
    return { ...base, target_type: type, target_id: id, target_name: name, current_value: current, new_value: next, autoOk: s.risk === "low" };
  }
  return null;
}

// What's spent this month so far vs the monthly budget, as a pace (1 = on track).
export function monthPace(spentThisMonth: number, monthlyBudget: number | null | undefined, now = new Date()): number | null {
  if (!monthlyBudget) return null;
  const days = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const gone = Math.max(1, now.getDate());
  return Math.round((spentThisMonth / (monthlyBudget * gone / days)) * 100) / 100;
}
