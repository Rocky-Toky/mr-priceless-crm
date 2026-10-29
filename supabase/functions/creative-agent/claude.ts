// The real Claude caller: one Messages API request that has to answer with
// JSON matching the step's schema (structured outputs), and what it cost.

import Anthropic from "npm:@anthropic-ai/sdk";
import { type Claude, type ClaudeRequest, StepError, type Usage } from "./pipeline.ts";

// US$ per million tokens: input, output, cache read, cache write (5 minutes).
// Anything not listed is priced as Opus 5, so a new model never counts as free.
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 0.2, 5],
  "claude-opus-5": [5, 25, 0.5, 6.25],
  "claude-sonnet-5-5": [2, 10, 0.2, 2.5],
  "claude-sonnet-5": [2, 10, 0.2, 2.5],
  "claude-fable-5-1": [10, 50, 1, 12.5],
};
export function costOf(model: string, u: Usage): number {
  const key = Object.keys(PRICES).find((k) => model === k || model.startsWith(`${k}-`)) || "claude-opus-5";
  const [i, o, r, w] = PRICES[key];
  return (u.input_tokens * i + u.output_tokens * o + u.cache_read_tokens * r + u.cache_write_tokens * w) / 1e6;
}

export function makeClaude(apiKey: string): Claude {
  // Our queue does the retrying (with longer waits), so only one quick retry here.
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 110_000 });
  return async (req: ClaudeRequest) => {
    let response: any;
    try {
      response = await client.beta.messages.create({
        model: req.model,
        max_tokens: req.maxTokens ?? 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
        system: req.system.map((b) => ({ type: "text", text: b.text, ...(b.cache ? { cache_control: { type: "ephemeral" } } : {}) })),
        messages: req.messages,
      } as any);
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new StepError("The Claude API key isn't working. Check the ANTHROPIC_API_KEY repo secret.", false);
      if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) throw new StepError(`Claude couldn't take the request: ${(e as any).message}`, false);
      if (e instanceof Anthropic.APIError) throw new StepError(`Claude API error: ${(e as any).message}`);
      throw new StepError(`Couldn't reach Claude: ${String((e as any)?.message || e)}`);
    }
    const u = response.usage || {};
    const usage: Usage = {
      input_tokens: u.input_tokens || 0,
      output_tokens: u.output_tokens || 0,
      cache_read_tokens: u.cache_read_input_tokens || 0,
      cache_write_tokens: u.cache_creation_input_tokens || 0,
    };
    const model = response.model || req.model;
    const cost_usd = costOf(model, usage);
    const spent = { model, usage, cost_usd };
    if (response.stop_reason === "refusal") throw new StepError("Claude declined this brief. Try rewording the notes.", false, spent);
    if (response.stop_reason === "max_tokens") throw new StepError("Claude ran out of room before finishing.", true, spent);
    const raw = (response.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("").trim();
    let data: any;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new StepError("Claude's answer wasn't valid JSON.", true, spent);
    }
    return { data, model, usage, cost_usd, raw };
  };
}
