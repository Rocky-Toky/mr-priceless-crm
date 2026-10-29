// Prompt templates for the creative agent. Every Claude call gets the same
// base context (playbook, client, brand, brief, past examples) plus one
// step's task, and answers in JSON against a fixed schema. Bump a template's
// version when its wording changes: the version is saved on what it made.

export const TEMPLATE_VERSIONS = {
  angles: "angles-v1",
  copy: "copy-v1",
} as const;

// What each platform allows. Meta's primary text can run long, but only
// the first 125 characters show before "See more", so the hook has to fit
// there. Google numbers are for responsive search ads.
export const PLATFORM_LIMITS: Record<string, { primary_text: number; headline: number; hook: number; label: string; ctas: string[]; notes: string }> = {
  meta: {
    label: "Meta (Facebook / Instagram) feed ad",
    primary_text: 500,
    headline: 40,
    hook: 125,
    ctas: ["Get Quote", "Book Now", "Call Now", "Contact Us", "Learn More", "Send Message", "Sign Up", "Get Offer"],
    notes: "Primary text: the first line is the hook and must work on its own within 125 characters (that's all that shows before \"See more\"). Keep the whole primary text under 500 characters. Headline: 40 characters max, shown under the image. CTA: one of Meta's button labels.",
  },
  google: {
    label: "Google responsive search ad",
    primary_text: 90,
    headline: 30,
    hook: 30,
    ctas: ["Get a Quote", "Book Now", "Call Now", "Contact Us", "Learn More"],
    notes: "primary_text is the ad's description: 90 characters max. Headline: 30 characters max, include the job or the area. Hook variants are extra headlines: 30 characters max each.",
  },
  other: {
    label: "Social / display ad",
    primary_text: 300,
    headline: 40,
    hook: 125,
    ctas: ["Get Quote", "Book Now", "Call Now", "Contact Us", "Learn More"],
    notes: "Primary text under 300 characters with the hook in the first line. Headline: 40 characters max.",
  },
};
export const limitsFor = (platform: string) => PLATFORM_LIMITS[platform] || PLATFORM_LIMITS.other;

export const SYSTEM_ROLE = `You are the senior ad strategist and copywriter at Mr Priceless, a marketing agency for trades and service businesses in New Zealand and Australia. You write direct-response ads that get local homeowners to enquire.

Follow the agency playbook below. Use only facts given in the brief, the client details and the brand details: never invent prices, offers, guarantees, awards, review counts or years in business. Respect the brand's "do not say" list exactly. Answer only with the JSON the schema asks for.`;

export type BaseContext = {
  playbook: { version_no: number; content: string } | null;
  client: Record<string, unknown>;
  brand: Record<string, unknown> | null;
  job: Record<string, any>;
  examples: unknown[]; // phase 3: 2-3 similar approved past ads
};

const clean = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (Array.isArray(v)) return v.map(clean).filter(Boolean).join("; ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};
const line = (label: string, v: unknown) => {
  const s = clean(v);
  return s ? `- ${label}: ${s}` : "";
};

// The shared context, as one block (cached across the job's calls).
export function baseContextText(ctx: BaseContext): string {
  const c = ctx.client, b = ctx.brand || {}, j = ctx.job;
  const lim = limitsFor(j.platform);
  return [
    `# Agency playbook (v${ctx.playbook?.version_no ?? 0})`,
    ctx.playbook?.content?.trim() || "(none yet)",
    "",
    "# The client",
    line("Business", c.name),
    line("Trade", c.industry),
    line("Website", c.website),
    line("Services", c.services),
    line("Area they cover", c.lead_area),
    line("Region", c.lead_region),
    line("What makes a good job for them", c.lead_fit),
    line("Their rules", c.client_rules),
    "",
    "# Brand",
    line("Voice", b.voice || c.branding_expectations) || "- Voice: not given - use the playbook's plain, local voice.",
    line("Colours", b.colours),
    line("Do NOT say", b.do_not_say),
    "",
    "# This brief",
    line("Jobs they want more of", j.target_jobs),
    line("Offer", j.offer) || "- Offer: none given - don't make one up.",
    line("Where", j.location),
    `- Platform: ${lim.label}`,
    line("Notes from the account manager", j.notes),
    "",
    "# Similar approved ads from past jobs",
    ctx.examples.length ? ctx.examples.map((e, i) => `${i + 1}. ${clean(e)}`).join("\n") : "(none yet)",
  ].filter((l) => l !== "").join("\n").replace(/\n(# )/g, "\n\n$1");
}

// Step 1: angles.
export const ANGLES_SCHEMA = {
  type: "object",
  properties: {
    angles: {
      type: "array",
      description: "3 to 5 angles, strongest first.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short name for the angle, e.g. \"Same-day hot water\"." },
          rationale: { type: "string", description: "One or two sentences: why this angle should work for this client, job and area." },
          hooks: { type: "array", description: "Exactly 3 hooks: the opening line of the ad.", items: { type: "string" } },
        },
        required: ["name", "rationale", "hooks"],
        additionalProperties: false,
      },
    },
  },
  required: ["angles"],
  additionalProperties: false,
};

export function anglesTask(job: Record<string, any>): string {
  const lim = limitsFor(job.platform);
  return `Propose 3 to 5 distinct ad angles for this brief, strongest first. We'll make ${job.concept_count} ad${job.concept_count === 1 ? "" : "s"} from the ones we pick.

An angle is the core reason a homeowner would respond: a problem, an outcome, a fear, a trigger moment or a proof point. Make each angle genuinely different from the others, not the same idea reworded. Ground them in the jobs and the area in the brief.

For each angle give a short name, a one or two sentence rationale, and exactly 3 hooks (opening lines) of ${lim.hook} characters or fewer, each a different way in.`;
}

// Step 2: copy for one concept.
export function copySchema(platform: string) {
  const lim = limitsFor(platform);
  return {
    type: "object",
    properties: {
      primary_text: { type: "string", description: `The ad's main text. Max ${lim.primary_text} characters.` },
      headline: { type: "string", description: `Max ${lim.headline} characters.` },
      cta: { type: "string", enum: lim.ctas },
      hook_variants: { type: "array", description: `Exactly 2 alternative hooks to test, max ${lim.hook} characters each.`, items: { type: "string" } },
    },
    required: ["primary_text", "headline", "cta", "hook_variants"],
    additionalProperties: false,
  };
}

export function copyTask(p: { job: Record<string, any>; angle: { name: string; rationale?: string | null; hook_options: string[] }; hookIndex: number; otherHooks: string[] }): string {
  const lim = limitsFor(p.job.platform);
  const hooks = p.angle.hook_options || [];
  const lead = hooks[p.hookIndex % Math.max(1, hooks.length)] || "";
  return [
    `Write one ${lim.label} for this angle.`,
    "",
    `Angle: ${p.angle.name}`,
    p.angle.rationale ? `Why it works: ${p.angle.rationale}` : "",
    hooks.length ? `Hooks drafted for this angle:\n${hooks.map((h, i) => `${i + 1}. ${h}`).join("\n")}` : "",
    lead ? `Lead with hook ${(p.hookIndex % hooks.length) + 1} (you can tighten the wording).` : "",
    p.otherHooks.length ? `Other ads in this job already lead with these, so take a different line:\n${p.otherHooks.map((h) => `- ${h}`).join("\n")}` : "",
    p.job.angle_note ? `Note from the reviewer on the angles (follow it):\n"""${p.job.angle_note}"""` : "",
    "",
    `Rules: ${lim.notes}`,
    "Give 2 hook_variants: other opening lines we could test in place of the first line.",
  ].filter(Boolean).join("\n");
}

// What's over the platform's limits, in words Claude can act on.
export function copyProblems(platform: string, out: { primary_text: string; headline: string; cta: string; hook_variants: string[] }): string[] {
  const lim = limitsFor(platform);
  const problems: string[] = [];
  const len = (s: string) => [...(s || "")].length;
  if (!out.primary_text?.trim()) problems.push("primary_text is empty.");
  if (!out.headline?.trim()) problems.push("headline is empty.");
  if (len(out.primary_text) > lim.primary_text) problems.push(`primary_text is ${len(out.primary_text)} characters; the limit is ${lim.primary_text}.`);
  if (len(out.headline) > lim.headline) problems.push(`headline is ${len(out.headline)} characters; the limit is ${lim.headline}.`);
  const first = (out.primary_text || "").split("\n")[0];
  if (platform !== "google" && len(first) > lim.hook) problems.push(`The first line of primary_text is ${len(first)} characters; the hook has to fit in ${lim.hook}.`);
  if (!lim.ctas.includes(out.cta)) problems.push(`cta must be one of: ${lim.ctas.join(", ")}.`);
  if (!Array.isArray(out.hook_variants) || out.hook_variants.length !== 2) problems.push("Give exactly 2 hook_variants.");
  (out.hook_variants || []).forEach((h, i) => { if (len(h) > lim.hook) problems.push(`hook_variants[${i}] is ${len(h)} characters; the limit is ${lim.hook}.`); });
  return problems;
}
