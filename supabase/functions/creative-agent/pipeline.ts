// The creative agent's pipeline: one function per queue step, plus the
// actions people take (pick angles, review, retry). Everything it touches
// goes through a Store and a Claude caller, so the tests can swap in fakes.
//
//   angles step -> (angle check: a person ticks angles) -> one copy step per concept
//
// Each step checks whether its output is already saved before calling
// Claude, so running it twice (a retry, or two workers) never doubles up.

import { anglesTask, ANGLES_SCHEMA, baseContextText, copyProblems, copySchema, copyTask, SYSTEM_ROLE, TEMPLATE_VERSIONS } from "./prompts.ts";

export const MAX_ATTEMPTS = 3;
// Wait before try 2 and try 3.
export const BACKOFF_SECONDS = [30, 120, 480];

export type Step = { id: string; job_id: string; kind: string; concept_id: string | null; attempts: number; status?: string };
export type Usage = { input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number };
export type ClaudeRequest = {
  model: string;
  effort: "low" | "medium" | "high";
  system: { text: string; cache?: boolean }[];
  messages: { role: "user" | "assistant"; content: string }[];
  schema: Record<string, unknown>;
  maxTokens?: number;
};
export type ClaudeResult = { data: any; model: string; usage: Usage; cost_usd: number; raw: string };
export type Claude = (req: ClaudeRequest) => Promise<ClaudeResult>;

// An error a retry won't fix (bad key, refused request) skips straight to failed.
// `spent` is set when the call was paid for before it went wrong.
export class StepError extends Error {
  retryable: boolean;
  spent?: { model: string; usage: Usage; cost_usd: number };
  constructor(message: string, retryable = true, spent?: StepError["spent"]) {
    super(message);
    this.retryable = retryable;
    this.spent = spent;
  }
}

export interface Store {
  claimSteps(n: number): Promise<Step[]>;
  getStep(id: string): Promise<Step | null>;
  getJob(id: string): Promise<any | null>;
  updateJob(id: string, patch: Record<string, unknown>): Promise<void>;
  getClient(id: string): Promise<any | null>;
  getBrand(clientId: string): Promise<any | null>;
  getActivePlaybook(): Promise<{ version_no: number; content: string } | null>;
  listAngles(jobId: string): Promise<any[]>;
  insertAngles(rows: any[]): Promise<void>;
  setAngleSelection(jobId: string, selectedIds: string[]): Promise<void>;
  listConcepts(jobId: string): Promise<any[]>;
  getConcept(id: string): Promise<any | null>;
  insertConcepts(rows: any[]): Promise<void>; // ignores ones already there
  updateConcept(id: string, patch: Record<string, unknown>): Promise<void>;
  listVersions(jobId: string): Promise<any[]>;
  getVersion(id: string): Promise<any | null>;
  insertVersion(row: any): Promise<void>; // ignores one already there
  updateVersion(id: string, patch: Record<string, unknown>): Promise<void>;
  insertReview(row: any): Promise<void>;
  listSteps(jobId: string): Promise<Step[]>;
  queueSteps(rows: { job_id: string; kind: string; concept_id: string | null }[]): Promise<void>; // ignores ones already there
  updateStep(id: string, patch: Record<string, unknown>): Promise<void>;
  logUsage(row: any): Promise<number>; // returns the job's new total cost
}

export type Config = { strategyModel: string; defaultModel: string; ceilingUsd: number | null };
export type Deps = { store: Store; claude: Claude; config: Config; now?: () => Date };

const nowIso = (d: Deps) => (d.now ? d.now() : new Date()).toISOString();
const later = (d: Deps, seconds: number) => new Date((d.now ? d.now() : new Date()).getTime() + seconds * 1000).toISOString();

async function baseContext(d: Deps, job: any) {
  const [client, brand, playbook] = await Promise.all([d.store.getClient(job.client_id), d.store.getBrand(job.client_id), d.store.getActivePlaybook()]);
  if (!client) throw new StepError("The client for this job has been deleted.", false);
  return {
    playbook,
    text: baseContextText({ playbook, client, brand, job, examples: [] }),
  };
}

// Every call is logged and added to the job's cost, even one that failed.
async function callClaude(d: Deps, job: any, step: Step, req: ClaudeRequest): Promise<ClaudeResult> {
  const log = (s: { model: string; usage: Usage; cost_usd: number }) =>
    d.store.logUsage({ job_id: job.id, step_id: step.id, step_kind: step.kind, provider: "anthropic", model: s.model, ...s.usage, image_count: 0, cost_usd: s.cost_usd });
  let res: ClaudeResult;
  try {
    res = await d.claude(req);
  } catch (e) {
    if (e instanceof StepError && e.spent) await log(e.spent);
    throw e;
  }
  await log(res);
  return res;
}

// ── Step 1: angles ──
export async function runAngles(d: Deps, job: any, step: Step) {
  const have = await d.store.listAngles(job.id);
  if (!have.length) {
    const ctx = await baseContext(d, job);
    if (ctx.playbook && job.playbook_version == null) await d.store.updateJob(job.id, { playbook_version: ctx.playbook.version_no });
    const res = await callClaude(d, job, step, {
      model: d.config.strategyModel,
      effort: "high",
      system: [{ text: SYSTEM_ROLE }, { text: ctx.text, cache: true }],
      messages: [{ role: "user", content: anglesTask(job) }],
      schema: ANGLES_SCHEMA,
    });
    const angles = (res.data?.angles || [])
      .filter((a: any) => a && String(a.name || "").trim())
      .slice(0, 5)
      .map((a: any) => ({ ...a, hooks: (a.hooks || []).map((h: any) => String(h).trim()).filter(Boolean).slice(0, 3) }));
    if (angles.length < 3) throw new StepError(`Claude gave ${angles.length} angle${angles.length === 1 ? "" : "s"}; we need at least 3.`);
    if (angles.some((a: any) => a.hooks.length < 3)) throw new StepError("An angle came back with fewer than 3 hooks.");
    await d.store.insertAngles(angles.map((a: any, i: number) => ({
      job_id: job.id,
      position: i + 1,
      name: String(a.name).trim().slice(0, 200),
      rationale: String(a.rationale || "").trim(),
      hook_options: a.hooks,
      selected: false,
      prompt_template_version: TEMPLATE_VERSIONS.angles,
    })));
  }
  const fresh = await d.store.getJob(job.id);
  if (fresh?.status !== "drafting_angles") return;
  if (fresh.angle_check_enabled) {
    await d.store.updateJob(job.id, { status: "awaiting_angle_check", error: null, updated_at: nowIso(d) });
  } else {
    // No angle check: run with the strongest angles, one per concept.
    const angles = await d.store.listAngles(job.id);
    const picked = angles.sort((a, b) => a.position - b.position).slice(0, Math.max(1, Math.min(fresh.concept_count, angles.length)));
    await startConcepts(d, fresh, picked.map((a) => a.id), null);
  }
}

// Spread the concepts over the picked angles: 4 concepts on 2 angles is 2
// each, the second one leading with that angle's next hook.
export function planConcepts(jobId: string, angles: { id: string }[], count: number) {
  const n = Math.max(1, angles.length);
  return Array.from({ length: Math.max(1, count) }, (_, i) => ({
    job_id: jobId,
    angle_id: angles[i % n].id,
    concept_no: i + 1,
    hook_index: Math.floor(i / n) % 3,
    status: "drafting",
  }));
}

async function startConcepts(d: Deps, job: any, angleIds: string[], note: string | null) {
  const angles = (await d.store.listAngles(job.id)).sort((a, b) => a.position - b.position);
  const picked = angles.filter((a) => angleIds.includes(a.id));
  if (!picked.length) throw new StepError("Tick at least one angle.", false);
  await d.store.setAngleSelection(job.id, picked.map((a) => a.id));
  await d.store.insertConcepts(planConcepts(job.id, picked, job.concept_count));
  const concepts = await d.store.listConcepts(job.id);
  await d.store.queueSteps(concepts.map((c) => ({ job_id: job.id, kind: "copy", concept_id: c.id })));
  await d.store.updateJob(job.id, { status: "generating", angle_note: note, error: null, updated_at: nowIso(d) });
}

// The angle check: a person ticked the angles to run, with one note for all.
export async function chooseAngles(d: Deps, jobId: string, angleIds: string[], note: string | null) {
  const job = await d.store.getJob(jobId);
  if (!job) throw new StepError("That job doesn't exist.", false);
  if (job.status !== "awaiting_angle_check") throw new StepError("This job isn't waiting on an angle check.", false);
  if (!angleIds?.length) throw new StepError("Tick at least one angle.", false);
  const trimmed = (note || "").trim().slice(0, 4000) || null;
  await startConcepts(d, job, angleIds, trimmed);
}

// ── Step 2: copy for one concept ──
export async function runCopy(d: Deps, job: any, step: Step) {
  const concepts = await d.store.listConcepts(job.id);
  const concept = concepts.find((c) => c.id === step.concept_id);
  if (!concept) return; // deleted since: nothing to do
  const versions = await d.store.listVersions(job.id);
  if (!versions.some((v) => v.concept_id === concept.id)) {
    const angles = await d.store.listAngles(job.id);
    const angle = angles.find((a) => a.id === concept.angle_id);
    if (!angle) throw new StepError("This concept's angle has been deleted.", false);
    // Hooks the other concepts lead with, so this one says something else.
    const otherHooks = concepts
      .filter((c) => c.id !== concept.id)
      .map((c) => {
        const v = versions.find((x) => x.concept_id === c.id);
        if (v) return String(v.primary_text || "").split("\n")[0];
        const a = angles.find((x) => x.id === c.angle_id);
        return a?.hook_options?.[c.hook_index] || "";
      })
      .filter(Boolean);
    const ctx = await baseContext(d, job);
    const system = [{ text: SYSTEM_ROLE }, { text: ctx.text, cache: true }];
    const schema = copySchema(job.platform);
    const messages: ClaudeRequest["messages"] = [{ role: "user", content: copyTask({ job, angle, hookIndex: concept.hook_index, otherHooks }) }];
    let res = await callClaude(d, job, step, { model: d.config.defaultModel, effort: "medium", system, messages, schema });
    let problems = copyProblems(job.platform, res.data);
    if (problems.length) {
      // One go at fixing it, with what was wrong spelled out.
      messages.push({ role: "assistant", content: res.raw }, { role: "user", content: `Fix these and send the whole ad again:\n${problems.map((p) => `- ${p}`).join("\n")}` });
      res = await callClaude(d, job, step, { model: d.config.defaultModel, effort: "medium", system, messages, schema });
      problems = copyProblems(job.platform, res.data);
      if (problems.length) throw new StepError(`The copy broke the platform's limits: ${problems.join(" ")}`);
    }
    await d.store.insertVersion({
      concept_id: concept.id,
      angle_id: angle.id,
      version_no: 1,
      primary_text: String(res.data.primary_text).trim(),
      headline: String(res.data.headline).trim(),
      cta: res.data.cta,
      hook_variants: (res.data.hook_variants || []).map((h: any) => String(h).trim()),
      prompt_template_version: TEMPLATE_VERSIONS.copy,
      status: "in_review",
    });
  }
  if (concept.status === "drafting") await d.store.updateConcept(concept.id, { status: "in_review" });
}

// Once nothing's left to draft, the job moves to review.
export async function advanceJob(d: Deps, jobId: string) {
  const job = await d.store.getJob(jobId);
  if (!job || job.status !== "generating") return;
  const steps = await d.store.listSteps(jobId);
  if (steps.some((s) => s.status === "queued" || s.status === "running")) return;
  const concepts = await d.store.listConcepts(jobId);
  if (!concepts.length || concepts.some((c) => c.status === "drafting")) return;
  await d.store.updateJob(jobId, { status: "in_review", updated_at: nowIso(d) });
}

// ── The queue ──
export async function runStep(d: Deps, step: Step) {
  const job = await d.store.getJob(step.job_id);
  if (!job) return;
  try {
    if (job.status === "failed" || job.status === "paused") {
      await d.store.updateStep(step.id, { status: "queued", attempts: Math.max(0, step.attempts - 1), locked_until: null });
      return;
    }
    // Over budget: pause before spending more.
    const ceiling = Number(job.cost_ceiling_usd ?? d.config.ceilingUsd ?? 10);
    if (Number(job.cost_usd || 0) >= ceiling) {
      await d.store.updateStep(step.id, { status: "queued", attempts: Math.max(0, step.attempts - 1), locked_until: null });
      await d.store.updateJob(job.id, { status: "paused", error: `Paused: this job has spent $${Number(job.cost_usd).toFixed(2)} of its $${ceiling.toFixed(2)} limit.`, updated_at: nowIso(d) });
      return;
    }
    if (step.kind === "angles") await runAngles(d, job, step);
    else if (step.kind === "copy") await runCopy(d, job, step);
    else throw new StepError(`"${step.kind}" steps aren't built yet.`, false);
    await d.store.updateStep(step.id, { status: "done", error: null, locked_until: null, finished_at: nowIso(d) });
    await advanceJob(d, job.id);
  } catch (e) {
    const err = e instanceof StepError ? e : new StepError(String((e as any)?.message || e));
    const message = err.message.slice(0, 1000);
    if (err.retryable && step.attempts < MAX_ATTEMPTS) {
      await d.store.updateStep(step.id, { status: "queued", error: message, locked_until: null, run_after: later(d, BACKOFF_SECONDS[step.attempts - 1] ?? 480) });
    } else {
      await d.store.updateStep(step.id, { status: "failed", error: message, locked_until: null, finished_at: nowIso(d) });
      const label = step.kind === "angles" ? "Drafting the angles" : "Writing the copy";
      await d.store.updateJob(job.id, { status: "failed", error: `${label} failed${err.retryable ? ` after ${step.attempts} tries` : ""}: ${message}`, updated_at: nowIso(d) });
    }
  }
}

// One worker run: take due steps a few at a time until there are none or
// time's nearly up. An Edge Function only gets about 150 seconds, so new
// steps are only started in the first part of that.
export async function tick(d: Deps, opts: { budgetMs?: number; batch?: number } = {}) {
  const started = Date.now();
  const budget = opts.budgetMs ?? 30_000;
  let ran = 0;
  while (Date.now() - started < budget) {
    const steps = await d.store.claimSteps(opts.batch ?? 4);
    if (!steps.length) break;
    await Promise.all(steps.map((s) => runStep(d, s)));
    ran += steps.length;
  }
  return { ran };
}

// What a job's status should be from how far it's got.
async function statusFromProgress(d: Deps, job: any) {
  const [angles, concepts] = await Promise.all([d.store.listAngles(job.id), d.store.listConcepts(job.id)]);
  if (!angles.length) return "drafting_angles";
  if (!concepts.length) return job.angle_check_enabled ? "awaiting_angle_check" : "drafting_angles";
  if (concepts.some((c) => c.status === "drafting")) return "generating";
  if (concepts.every((c) => c.status === "approved" || c.status === "discarded")) return "approved";
  return "in_review";
}

// The Retry button (failed), or "keep going" (paused at the cost limit).
export async function retryJob(d: Deps, jobId: string) {
  const job = await d.store.getJob(jobId);
  if (!job) throw new StepError("That job doesn't exist.", false);
  if (job.status !== "failed" && job.status !== "paused") throw new StepError("Only a failed or paused job can be retried.", false);
  const patch: Record<string, unknown> = { error: null, updated_at: nowIso(d) };
  if (job.status === "paused" || Number(job.cost_usd || 0) >= Number(job.cost_ceiling_usd || 0)) {
    patch.cost_ceiling_usd = Math.ceil(Number(job.cost_usd || 0) + Number(d.config.ceilingUsd ?? 10));
  }
  for (const s of await d.store.listSteps(jobId)) {
    if (s.status === "failed") await d.store.updateStep(s.id, { status: "queued", attempts: 0, error: null, run_after: nowIso(d), finished_at: null });
  }
  // A job that failed before its first step was queued gets it now.
  await d.store.queueSteps([{ job_id: jobId, kind: "angles", concept_id: null }]);
  patch.status = await statusFromProgress(d, job);
  await d.store.updateJob(jobId, patch);
}

// Approve, reject (note + what to redo) or discard one version.
export async function reviewVersion(d: Deps, p: { versionId: string; decision: string; note?: string | null; redo?: string | null; reviewer: string }) {
  const version = await d.store.getVersion(p.versionId);
  if (!version) throw new StepError("That draft doesn't exist.", false);
  if (!["approve", "reject", "discard"].includes(p.decision)) throw new StepError("Pick approve, reject or discard.", false);
  const note = (p.note || "").trim().slice(0, 4000) || null;
  if (p.decision === "reject" && !note) throw new StepError("Write a note saying what's wrong.", false);
  if (p.decision === "reject" && !["copy", "image", "both"].includes(p.redo || "")) throw new StepError("Pick what to redo: copy, image or both.", false);
  const concept = await d.store.getConcept(version.concept_id);
  if (!concept) throw new StepError("That concept doesn't exist.", false);
  if (version.status === "superseded") throw new StepError("A newer draft has replaced this one.", false);
  const concepts = await d.store.listConcepts(concept.job_id);
  await d.store.insertReview({ version_id: version.id, reviewer_email: p.reviewer, decision: p.decision, redo: p.decision === "reject" ? p.redo : null, note });
  const vStatus = p.decision === "approve" ? "approved" : p.decision === "reject" ? "rejected" : "discarded";
  const cStatus = p.decision === "approve" ? "approved" : p.decision === "reject" ? "rejected" : "discarded";
  await d.store.updateVersion(version.id, { status: vStatus });
  await d.store.updateConcept(concept.id, { status: cStatus });
  const job = await d.store.getJob(concept.job_id);
  if (job && (job.status === "in_review" || job.status === "approved")) {
    const after = concepts.map((c) => (c.id === concept.id ? { ...c, status: cStatus } : c));
    const done = after.every((c) => c.status === "approved" || c.status === "discarded");
    await d.store.updateJob(job.id, { status: done ? "approved" : "in_review", updated_at: nowIso(d) });
  }
}
