import { assert, assertEquals } from "jsr:@std/assert@1";
import { check, leadsOf, monthPace, summarise } from "./logic.ts";

const acc = () => summarise({
  campaigns: [{ id: "c1", name: "Leads", effective_status: "ACTIVE" }, { id: "c2", name: "CBO", effective_status: "ACTIVE", daily_budget: "8000" }],
  adsets: [
    { id: "s1", name: "Set 1", campaign_id: "c1", effective_status: "ACTIVE", daily_budget: "5000" },
    { id: "s2", name: "Set 2", campaign_id: "c2", effective_status: "ACTIVE" },
  ],
  ads: [
    { id: "a1", name: "Winner", adset_id: "s1", effective_status: "ACTIVE" },
    { id: "a2", name: "Loser", adset_id: "s1", effective_status: "ACTIVE" },
    { id: "a3", name: "Only one", adset_id: "s2", effective_status: "ACTIVE" },
    { id: "a4", name: "Old", adset_id: "s1", effective_status: "PAUSED" },
  ],
  ins7: [
    { ad_id: "a1", spend: "100", impressions: "5000", clicks: "80", actions: [{ action_type: "lead", value: "5" }] },
    { ad_id: "a2", spend: "120", impressions: "6000", clicks: "40", actions: [] },
    { ad_id: "a3", spend: "90", impressions: "4000", clicks: "30", actions: [{ action_type: "onsite_conversion.lead_grouped", value: "3" }] },
  ],
  ins30: [{ ad_id: "a4", spend: "200", impressions: "9000", clicks: "90", actions: [{ action_type: "lead", value: "10" }] }],
  crm: { a1: { leads: 5, quotes: 2, won: 1 } },
});

Deno.test("leads are the biggest of Meta's lead counts", () => {
  assertEquals(leadsOf([{ action_type: "lead", value: "2" }, { action_type: "onsite_conversion.lead_grouped", value: "3" }]), 3);
  assertEquals(leadsOf(undefined), 0);
});

Deno.test("summary: budgets in dollars, on the ad set or the campaign, totals", () => {
  const s = acc();
  assertEquals(s.adsets.find((x) => x.id === "s1")?.daily_budget, 50);
  assertEquals(s.adsets.find((x) => x.id === "s2")?.campaign_daily_budget, 80);
  assertEquals(s.totals.d7.spend, 310);
  assertEquals(s.totals.d7.leads, 8);
  assertEquals(s.live_ads, 3);
  assertEquals(s.ads.find((a) => a.id === "a1")?.crm30?.quotes, 2);
});

Deno.test("pause: real ad, never the last one running, auto only when clearly failed", () => {
  const s = acc();
  const p = check({ kind: "pause", target_type: "ad", target_id: "a2", new_daily_budget: null, reason: "", impact: "", risk: "low" }, s, { target_cpl: 40 }, "act_1");
  assert(p && p.autoOk, "a $120 ad with no leads at a $40 target can pause itself");
  assertEquals(check({ kind: "pause", target_type: "ad", target_id: "a3", new_daily_budget: null, reason: "", impact: "", risk: "low" }, s, {}, "act_1"), null);
  assertEquals(check({ kind: "pause", target_type: "ad", target_id: "nope", new_daily_budget: null, reason: "", impact: "", risk: "low" }, s, {}, "act_1"), null);
  const w = check({ kind: "pause", target_type: "ad", target_id: "a1", new_daily_budget: null, reason: "", impact: "", risk: "low" }, s, { target_cpl: 40 }, "act_1");
  assert(w && !w.autoOk, "an ad making quotes never pauses by itself");
});

Deno.test("budget: clamped to the allowed move and the daily cap, finds campaign budgets", () => {
  const s = acc();
  const up = check({ kind: "budget", target_type: "adset", target_id: "s1", new_daily_budget: 100, reason: "", impact: "", risk: "low" }, s, { max_change_pct: 20 }, "act_1");
  assertEquals(up?.new_value, 60);
  assertEquals(up?.current_value, 50);
  const capped = check({ kind: "budget", target_type: "adset", target_id: "s1", new_daily_budget: 60, reason: "", impact: "", risk: "low" }, s, { max_change_pct: 20, max_daily_budget: 55 }, "act_1");
  assertEquals(capped?.new_value, 55);
  const cbo = check({ kind: "budget", target_type: "adset", target_id: "s2", new_daily_budget: 70, reason: "", impact: "", risk: "high" }, s, {}, "act_1");
  assertEquals(cbo?.target_type, "campaign");
  assertEquals(cbo?.target_id, "c2");
  assertEquals(cbo?.new_value, 70);
  assertEquals(check({ kind: "budget", target_type: "adset", target_id: "s1", new_daily_budget: 50.5, reason: "", impact: "", risk: "low" }, s, {}, "act_1"), null);
});

Deno.test("flags never change anything and resume only for paused ads", () => {
  const s = acc();
  const f = check({ kind: "flag", target_type: "account", target_id: "x", new_daily_budget: null, reason: "Billing", impact: "", risk: "low" }, s, {}, "act_1");
  assertEquals(f?.risk, "high");
  assertEquals(f?.target_id, "act_1");
  assert(check({ kind: "resume", target_type: "ad", target_id: "a4", new_daily_budget: null, reason: "", impact: "", risk: "low" }, s, {}, "act_1"));
  assertEquals(check({ kind: "resume", target_type: "ad", target_id: "a1", new_daily_budget: null, reason: "", impact: "", risk: "low" }, s, {}, "act_1"), null);
});

Deno.test("month pace", () => {
  assertEquals(monthPace(1500, 3000, new Date(2026, 10, 15)), 1);
  assertEquals(monthPace(100, null), null);
});
