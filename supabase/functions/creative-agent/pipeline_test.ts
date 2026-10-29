// Tests for the creative agent's pipeline, with Claude and the database
// swapped for fakes. Run: deno test supabase/functions/creative-agent

import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";
import { advanceJob, BACKOFF_SECONDS, chooseAngles, type ClaudeRequest, type ClaudeResult, type Deps, MAX_ATTEMPTS, planConcepts, retryJob, reviewVersion, StepError, type Store, tick } from "./pipeline.ts";
import { copyProblems, TEMPLATE_VERSIONS } from "./prompts.ts";
import { costOf } from "./claude.ts";

// ── An in-memory Store ──
let n = 0;
const id = () => `id-${++n}`;
function memoryStore() {
  const t = {
    jobs: [] as any[], clients: [] as any[], brands: [] as any[], angles: [] as any[], concepts: [] as any[],
    versions: [] as any[], reviews: [] as any[], steps: [] as any[], usage: [] as any[],
    playbook: { version_no: 1, content: "Write plain NZ English." },
  };
  const patch = (row: any, p: Record<string, unknown>) => row && Object.assign(row, p);
  const store: Store = {
    async claimSteps(k) {
      const now = Date.now();
      const due = t.steps.filter((s) => {
        const job = t.jobs.find((j) => j.id === s.job_id);
        return job && !["failed", "paused"].includes(job.status) && s.status === "queued" && new Date(s.run_after).getTime() <= now;
      }).slice(0, k);
      due.forEach((s) => { s.status = "running"; s.attempts += 1; });
      return due.map((s) => ({ ...s }));
    },
    async getStep(i) { return t.steps.find((s) => s.id === i) || null; },
    async getJob(i) { const j = t.jobs.find((x) => x.id === i); return j ? { ...j } : null; },
    async updateJob(i, p) { patch(t.jobs.find((x) => x.id === i), p); },
    async getClient(i) { return t.clients.find((x) => x.id === i) || null; },
    async getBrand(c) { return t.brands.find((x) => x.client_id === c) || null; },
    async getActivePlaybook() { return t.playbook; },
    async listAngles(j) { return t.angles.filter((a) => a.job_id === j).map((a) => ({ ...a })); },
    async insertAngles(rows) { rows.forEach((r) => { if (!t.angles.some((a) => a.job_id === r.job_id && a.position === r.position)) t.angles.push({ id: id(), ...r }); }); },
    async setAngleSelection(j, ids) { t.angles.filter((a) => a.job_id === j).forEach((a) => (a.selected = ids.includes(a.id))); },
    async listConcepts(j) { return t.concepts.filter((c) => c.job_id === j).sort((a, b) => a.concept_no - b.concept_no).map((c) => ({ ...c })); },
    async getConcept(i) { const c = t.concepts.find((x) => x.id === i); return c ? { ...c } : null; },
    async insertConcepts(rows) { rows.forEach((r) => { if (!t.concepts.some((c) => c.job_id === r.job_id && c.concept_no === r.concept_no)) t.concepts.push({ id: id(), ...r }); }); },
    async updateConcept(i, p) { patch(t.concepts.find((x) => x.id === i), p); },
    async listVersions(j) { const cs = t.concepts.filter((c) => c.job_id === j).map((c) => c.id); return t.versions.filter((v) => cs.includes(v.concept_id)); },
    async getVersion(i) { const v = t.versions.find((x) => x.id === i); return v ? { ...v } : null; },
    async insertVersion(r) { if (!t.versions.some((v) => v.concept_id === r.concept_id && v.version_no === r.version_no)) t.versions.push({ id: id(), ...r }); },
    async updateVersion(i, p) { patch(t.versions.find((x) => x.id === i), p); },
    async insertReview(r) { t.reviews.push({ id: id(), ...r }); },
    async listSteps(j) { return t.steps.filter((s) => s.job_id === j).map((s) => ({ ...s })); },
    async queueSteps(rows) {
      rows.forEach((r) => {
        if (!t.steps.some((s) => s.job_id === r.job_id && s.kind === r.kind && (s.concept_id || null) === (r.concept_id || null))) {
          t.steps.push({ id: id(), status: "queued", attempts: 0, run_after: new Date(0).toISOString(), ...r });
        }
      });
    },
    async updateStep(i, p) { patch(t.steps.find((x) => x.id === i), p); },
    async logUsage(r) {
      t.usage.push(r);
      const j = t.jobs.find((x) => x.id === r.job_id);
      j.cost_usd = Number(j.cost_usd || 0) + Number(r.cost_usd || 0);
      return j.cost_usd;
    },
  };
  // A new job queues its angles step, like the database trigger does.
  const addJob = (p: Record<string, unknown> = {}) => {
    const client = { id: id(), name: "Westside Plumbing", industry: "Plumbing" };
    t.clients.push(client);
    const job = { id: id(), client_id: client.id, target_jobs: "Hot water cylinder replacements", offer: null, platform: "meta", location: "West Auckland", concept_count: 4, angle_check_enabled: true, notes: null, angle_note: null, status: "drafting_angles", error: null, cost_usd: 0, cost_ceiling_usd: 10, ...p };
    t.jobs.push(job);
    t.steps.push({ id: id(), job_id: job.id, kind: "angles", concept_id: null, status: "queued", attempts: 0, run_after: new Date(0).toISOString() });
    return job;
  };
  return { t, store, addJob };
}

// ── A fake Claude ──
const usage = { input_tokens: 1000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0 };
const ANGLES = {
  angles: [
    { name: "Cold shower tomorrow", rationale: "Fear of no hot water.", hooks: ["No hot water?", "Cold showers again?", "Cylinder leaking?"] },
    { name: "Same-day swap", rationale: "Speed.", hooks: ["New cylinder today.", "Hot water by tonight.", "Same-day swaps in West Auckland."] },
    { name: "Local and licensed", rationale: "Trust.", hooks: ["Licensed West Auckland plumbers.", "Local, licensed, on time.", "Your local plumber."] },
  ],
};
const COPY = { primary_text: "No hot water? We swap cylinders the same day across West Auckland.\n\nLicensed local plumbers.", headline: "Hot water back today", cta: "Get Quote", hook_variants: ["Cold showers again?", "Cylinder leaking?"] };
function fakeClaude(handler?: (req: ClaudeRequest, call: number) => any) {
  const calls: ClaudeRequest[] = [];
  const claude = async (req: ClaudeRequest): Promise<ClaudeResult> => {
    calls.push(req);
    const out = handler ? handler(req, calls.length) : ("angles" in (req.schema as any).properties ? ANGLES : COPY);
    if (out instanceof Error) throw out;
    return { data: out, model: req.model, usage, cost_usd: 0.01, raw: JSON.stringify(out) };
  };
  return { claude, calls };
}
const config = { strategyModel: "strategy-model", defaultModel: "default-model", ceilingUsd: 10 };
const setup = (handler?: (req: ClaudeRequest, call: number) => any, job: Record<string, unknown> = {}) => {
  const m = memoryStore();
  const c = fakeClaude(handler);
  const d: Deps = { store: m.store, claude: c.claude, config };
  return { ...m, ...c, d, job: m.addJob(job) };
};
const jobOf = (t: any, i: string) => t.jobs.find((j: any) => j.id === i);

Deno.test("angles step saves 3-5 angles and waits for the angle check", async () => {
  const { t, d, job, calls } = setup();
  await tick(d);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].model, "strategy-model");
  assertEquals(t.angles.length, 3);
  assertEquals(t.angles[0].hook_options.length, 3);
  assertEquals(t.angles[0].prompt_template_version, TEMPLATE_VERSIONS.angles);
  assertEquals(jobOf(t, job.id).status, "awaiting_angle_check");
  assertEquals(jobOf(t, job.id).playbook_version, 1);
  assertEquals(t.concepts.length, 0, "no copy before the angle check");
  // The base context carries the playbook, the client and the brief, and is cached.
  const base = calls[0].system.find((s) => s.cache)!.text;
  assertMatch(base, /Write plain NZ English/);
  assertMatch(base, /Westside Plumbing/);
  assertMatch(base, /Hot water cylinder replacements/);
});

Deno.test("copy is written for each concept once angles are chosen, then the job is in review", async () => {
  const { t, d, job, calls } = setup();
  await tick(d);
  const [a1, , a3] = t.angles;
  await chooseAngles(d, job.id, [a1.id, a3.id], "Keep it about same-day service.");
  assertEquals(jobOf(t, job.id).status, "generating");
  assertEquals(t.concepts.length, 4);
  // 4 concepts over 2 angles: 2 each, the second leading with the next hook.
  assertEquals(t.concepts.map((c: any) => [c.angle_id, c.hook_index]), [[a1.id, 0], [a3.id, 0], [a1.id, 1], [a3.id, 1]]);
  assertEquals(t.angles.filter((a: any) => a.selected).length, 2);
  await tick(d);
  assertEquals(calls.length, 5);
  assert(calls.slice(1).every((c) => c.model === "default-model"));
  assertMatch(calls[1].messages[0].content, /Keep it about same-day service/);
  assertEquals(t.versions.length, 4);
  assert(t.versions.every((v: any) => v.version_no === 1 && v.status === "in_review" && v.prompt_template_version === TEMPLATE_VERSIONS.copy));
  assertEquals(jobOf(t, job.id).status, "in_review");
  assertEquals(t.usage.length, 5);
  assertEquals(Number(jobOf(t, job.id).cost_usd.toFixed(2)), 0.05);
});

Deno.test("with the angle check off, the strongest angles run straight away", async () => {
  const { t, d, job } = setup(undefined, { angle_check_enabled: false, concept_count: 2 });
  await tick(d);
  await tick(d);
  assertEquals(t.angles.filter((a: any) => a.selected).map((a: any) => a.position), [1, 2]);
  assertEquals(t.versions.length, 2);
  assertEquals(jobOf(t, job.id).status, "in_review");
});

Deno.test("steps are idempotent: re-running a done step doesn't call Claude again", async () => {
  const { t, d, job, calls } = setup();
  await tick(d);
  // Pretend the worker died after saving but before marking the step done.
  const step = t.steps.find((s: any) => s.kind === "angles");
  Object.assign(step, { status: "queued", attempts: 0 });
  jobOf(t, job.id).status = "drafting_angles";
  await tick(d);
  assertEquals(calls.length, 1);
  assertEquals(t.angles.length, 3);
  assertEquals(jobOf(t, job.id).status, "awaiting_angle_check");
});

Deno.test("a failing step retries with growing waits, then the job fails with the error", async () => {
  const { t, d, job, calls } = setup(() => new StepError("Claude API error: overloaded"));
  const step = t.steps[0];
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    const before = Date.now();
    await tick(d);
    if (i < MAX_ATTEMPTS) {
      assertEquals(step.status, "queued");
      const wait = (new Date(step.run_after).getTime() - before) / 1000;
      assert(Math.abs(wait - BACKOFF_SECONDS[i - 1]) < 5, `try ${i} waits ${BACKOFF_SECONDS[i - 1]}s`);
      step.run_after = new Date(0).toISOString(); // skip the wait
    }
  }
  assertEquals(calls.length, MAX_ATTEMPTS);
  assertEquals(step.status, "failed");
  assertEquals(jobOf(t, job.id).status, "failed");
  assertMatch(jobOf(t, job.id).error, /overloaded/);
  // Nothing more happens until someone presses Retry.
  await tick(d);
  assertEquals(calls.length, MAX_ATTEMPTS);
});

Deno.test("an error a retry won't fix fails straight away", async () => {
  const { t, d, job, calls } = setup(() => new StepError("The Claude API key isn't working.", false));
  await tick(d);
  assertEquals(calls.length, 1);
  assertEquals(jobOf(t, job.id).status, "failed");
});

Deno.test("Retry re-runs only the failed step", async () => {
  let fail = true;
  const { t, d, job, calls } = setup((req) => {
    if ("angles" in (req.schema as any).properties) return ANGLES;
    if (fail) return new StepError("bad request", false);
    return COPY;
  }, { concept_count: 1 });
  await tick(d);
  await chooseAngles(d, job.id, [t.angles[0].id], null);
  await tick(d);
  assertEquals(jobOf(t, job.id).status, "failed");
  fail = false;
  await retryJob(d, job.id);
  assertEquals(jobOf(t, job.id).status, "generating");
  await tick(d);
  assertEquals(jobOf(t, job.id).status, "in_review");
  assertEquals(calls.filter((c) => "angles" in (c.schema as any).properties).length, 1, "angles weren't redone");
});

Deno.test("a job at its cost limit pauses before spending more, and can carry on", async () => {
  const { t, d, job, calls } = setup(undefined, { cost_usd: 10, cost_ceiling_usd: 10 });
  await tick(d);
  assertEquals(calls.length, 0);
  assertEquals(jobOf(t, job.id).status, "paused");
  assertMatch(jobOf(t, job.id).error, /\$10\.00 of its \$10\.00 limit/);
  await retryJob(d, job.id);
  assertEquals(jobOf(t, job.id).cost_ceiling_usd, 20);
  await tick(d);
  assertEquals(calls.length, 1);
  assertEquals(jobOf(t, job.id).status, "awaiting_angle_check");
});

Deno.test("cost is logged even when a paid call goes wrong", async () => {
  const { t, d } = setup(() => new StepError("not JSON", true, { model: "m", usage, cost_usd: 0.02 }));
  await tick(d);
  assertEquals(t.usage.length, 1);
  assertEquals(t.usage[0].cost_usd, 0.02);
});

Deno.test("copy over the platform's limits gets one fix, then fails the try", async () => {
  const long = { ...COPY, headline: "This headline is far too long for a Meta ad to show" };
  const { t, d, job, calls } = setup((req, call) => {
    if ("angles" in (req.schema as any).properties) return ANGLES;
    return call === 2 ? long : COPY;
  }, { concept_count: 1 });
  await tick(d);
  await chooseAngles(d, job.id, [t.angles[0].id], null);
  await tick(d);
  assertEquals(calls.length, 3);
  assertMatch(calls[2].messages[2].content, /headline is \d+ characters; the limit is 40/);
  assertEquals(t.versions[0].headline, COPY.headline);
});

Deno.test("reviews: reject needs a note and a redo choice; the job's approved once every concept is approved or discarded", async () => {
  const { t, d, job } = setup(undefined, { concept_count: 2 });
  await tick(d);
  await chooseAngles(d, job.id, [t.angles[0].id], null);
  await tick(d);
  const [v1, v2] = t.versions;
  let err = "";
  try { await reviewVersion(d, { versionId: v1.id, decision: "reject", note: " ", redo: "copy", reviewer: "max@x" }); } catch (e) { err = (e as Error).message; }
  assertMatch(err, /note/);
  try { await reviewVersion(d, { versionId: v1.id, decision: "reject", note: "Too salesy", redo: null, reviewer: "max@x" }); } catch (e) { err = (e as Error).message; }
  assertMatch(err, /redo/);
  await reviewVersion(d, { versionId: v1.id, decision: "reject", note: "Too salesy", redo: "copy", reviewer: "max@x" });
  assertEquals(t.reviews.length, 1);
  assertEquals(t.reviews[0].note, "Too salesy");
  assertEquals(t.versions[0].status, "rejected");
  assertEquals(jobOf(t, job.id).status, "in_review");
  await reviewVersion(d, { versionId: v2.id, decision: "approve", reviewer: "max@x" });
  assertEquals(jobOf(t, job.id).status, "in_review");
  await reviewVersion(d, { versionId: v1.id, decision: "discard", reviewer: "max@x" });
  assertEquals(jobOf(t, job.id).status, "approved");
  assertEquals(t.reviews.length, 3, "every decision is kept");
});

Deno.test("the angle check only works while the job is waiting on it", async () => {
  const { d, job } = setup();
  let err = "";
  try { await chooseAngles(d, job.id, ["x"], null); } catch (e) { err = (e as Error).message; }
  assertMatch(err, /isn't waiting/);
});

Deno.test("advanceJob waits for every concept", async () => {
  const { t, d, job } = setup(undefined, { concept_count: 3 });
  await tick(d);
  await chooseAngles(d, job.id, [t.angles[0].id], null);
  t.concepts[0].status = "in_review";
  t.steps.filter((s: any) => s.kind === "copy").forEach((s: any) => (s.status = "done"));
  await advanceJob(d, job.id);
  assertEquals(jobOf(t, job.id).status, "generating");
});

Deno.test("planConcepts spreads concepts across angles", () => {
  assertEquals(planConcepts("j", [{ id: "a" }], 3).map((c) => [c.angle_id, c.hook_index]), [["a", 0], ["a", 1], ["a", 2]]);
  assertEquals(planConcepts("j", [{ id: "a" }, { id: "b" }, { id: "c" }], 2).map((c) => c.angle_id), ["a", "b"]);
});

Deno.test("copyProblems checks Google's tighter limits", () => {
  const p = copyProblems("google", { primary_text: "x".repeat(91), headline: "y".repeat(31), cta: "Get Quote", hook_variants: ["a", "b"] });
  assertEquals(p.length, 3);
});

Deno.test("costOf prices tokens by model, and unknown models aren't free", () => {
  assertEquals(costOf("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 1e6, cache_read_tokens: 0, cache_write_tokens: 0 }), 24);
  assert(costOf("some-new-model", usage) > 0);
});

