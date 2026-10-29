// The pipeline's Store, backed by the CRM's Supabase tables (sql/101).

import type { Step, Store } from "./pipeline.ts";

const must = <T>(r: { data: T; error: any }, what: string): T => {
  if (r.error) throw new Error(`${what}: ${r.error.message}`);
  return r.data;
};

export function supabaseStore(db: any): Store {
  return {
    async claimSteps(n) {
      return must(await db.rpc("creative_claim_steps", { n }), "claim steps") || [];
    },
    async getStep(id) {
      return must(await db.from("creative_steps").select("*").eq("id", id).maybeSingle(), "read step") as Step | null;
    },
    async getJob(id) {
      return must(await db.from("creative_jobs").select("*").eq("id", id).maybeSingle(), "read job");
    },
    async updateJob(id, patch) {
      must(await db.from("creative_jobs").update(patch).eq("id", id), "update job");
    },
    async getClient(id) {
      return must(await db.from("clients").select("id, name, industry, website, services, client_rules, branding_expectations, lead_area, lead_region, lead_fit").eq("id", id).maybeSingle(), "read client");
    },
    async getBrand(clientId) {
      return must(await db.from("client_brand").select("*").eq("client_id", clientId).maybeSingle(), "read brand");
    },
    async getActivePlaybook() {
      return must(await db.from("creative_playbook_versions").select("version_no, content").eq("active", true).maybeSingle(), "read playbook");
    },
    async listAngles(jobId) {
      return must(await db.from("creative_angles").select("*").eq("job_id", jobId).order("position"), "read angles") || [];
    },
    async insertAngles(rows) {
      must(await db.from("creative_angles").upsert(rows, { onConflict: "job_id,position", ignoreDuplicates: true }), "save angles");
    },
    async setAngleSelection(jobId, ids) {
      must(await db.from("creative_angles").update({ selected: false }).eq("job_id", jobId), "untick angles");
      if (ids.length) must(await db.from("creative_angles").update({ selected: true }).eq("job_id", jobId).in("id", ids), "tick angles");
    },
    async listConcepts(jobId) {
      return must(await db.from("creative_concepts").select("*").eq("job_id", jobId).order("concept_no"), "read concepts") || [];
    },
    async getConcept(id) {
      return must(await db.from("creative_concepts").select("*").eq("id", id).maybeSingle(), "read concept");
    },
    async insertConcepts(rows) {
      must(await db.from("creative_concepts").upsert(rows, { onConflict: "job_id,concept_no", ignoreDuplicates: true }), "save concepts");
    },
    async updateConcept(id, patch) {
      must(await db.from("creative_concepts").update(patch).eq("id", id), "update concept");
    },
    async listVersions(jobId) {
      const concepts: any[] = must(await db.from("creative_concepts").select("id").eq("job_id", jobId), "read concepts") || [];
      if (!concepts.length) return [];
      return must(await db.from("creative_versions").select("*").in("concept_id", concepts.map((c: any) => c.id)).order("version_no"), "read versions") || [];
    },
    async getVersion(id) {
      return must(await db.from("creative_versions").select("*").eq("id", id).maybeSingle(), "read version");
    },
    async insertVersion(row) {
      must(await db.from("creative_versions").upsert(row, { onConflict: "concept_id,version_no", ignoreDuplicates: true }), "save version");
    },
    async updateVersion(id, patch) {
      must(await db.from("creative_versions").update(patch).eq("id", id), "update version");
    },
    async insertReview(row) {
      must(await db.from("creative_reviews").insert(row), "save review");
    },
    async listSteps(jobId) {
      return must(await db.from("creative_steps").select("*").eq("job_id", jobId), "read steps") || [];
    },
    async queueSteps(rows) {
      // The unique index is on an expression, so check before inserting
      // rather than upserting (a duplicate is then a no-op either way).
      if (!rows.length) return;
      const have = await this.listSteps(rows[0].job_id);
      const key = (r: { kind: string; concept_id: string | null }) => `${r.kind}:${r.concept_id || ""}`;
      const seen = new Set(have.map(key));
      const todo = rows.filter((r) => !seen.has(key(r)));
      for (const r of todo) {
        const res = await db.from("creative_steps").insert(r);
        if (res.error && res.error.code !== "23505") throw new Error(`queue step: ${res.error.message}`);
      }
    },
    async updateStep(id, patch) {
      must(await db.from("creative_steps").update(patch).eq("id", id), "update step");
    },
    async logUsage(row) {
      must(await db.from("creative_usage").insert(row), "log usage");
      return Number(must(await db.rpc("creative_add_cost", { p_job: row.job_id, p_cost: row.cost_usd }), "add cost") || 0);
    },
  };
}
