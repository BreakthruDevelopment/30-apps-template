import { env } from "@/lib/env";
import { log } from "@/lib/log";
import { demoAnswer } from "./demo";
import { anthropicProvider, geminiProvider } from "./providers";
import { type AiProvider, type GenerateRequest, type GenerateResult, AiError } from "./types";

export { AiError } from "./types";
export type { GenerateRequest, GenerateResult } from "./types";

/** Hard cap on what a user can send to a model, to bound cost and abuse. */
export const MAX_PROMPT_CHARS = 12_000;

// Model names change often; set AI_MODEL per app and confirm it on Day 0.
const DEFAULT_MODELS = {
  gemini: "gemini-flash-latest",
  anthropic: "claude-haiku-5-5",
} as const;

function liveProvider(): AiProvider | null {
  const e = env();
  if (e.AI_PROVIDER === "gemini") {
    if (!e.GEMINI_API_KEY) throw new Error("AI_PROVIDER=gemini needs GEMINI_API_KEY");
    return geminiProvider(e.GEMINI_API_KEY, e.AI_MODEL ?? DEFAULT_MODELS.gemini);
  }
  if (e.AI_PROVIDER === "anthropic") {
    if (!e.ANTHROPIC_API_KEY) throw new Error("AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
    return anthropicProvider(e.ANTHROPIC_API_KEY, e.AI_MODEL ?? DEFAULT_MODELS.anthropic);
  }
  return null;
}

/** Models sometimes wrap JSON in code fences despite instructions. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const body = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(body);
  } catch {
    throw new AiError("Model did not return valid JSON", "invalid_output");
  }
}

/**
 * The one way the app talks to a model: input guardrails, provider call,
 * schema-validated output, demo fallback, and a structured log line.
 */
export async function generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
  if (req.prompt.length > MAX_PROMPT_CHARS) {
    throw new AiError(`Input is longer than ${MAX_PROMPT_CHARS} characters`, "input_rejected");
  }
  const e = env();
  const maxOutputTokens = req.maxOutputTokens ?? 800;
  const started = Date.now();
  const provider = liveProvider();

  const finish = (raw: string, name: string, model: string, demo: boolean): GenerateResult<T> => {
    const parsed = req.schema.safeParse(extractJson(raw));
    if (!parsed.success) throw new AiError("Model output failed validation", "invalid_output");
    const latencyMs = Date.now() - started;
    log.info("ai.generate", { task: req.task, provider: name, model, demo, latencyMs });
    return { data: parsed.data, provider: name, model, demo, latencyMs };
  };

  if (!provider) return finish(demoAnswer(req.task), "demo", "recorded", true);

  try {
    const raw = await provider.complete({ system: req.system, prompt: req.prompt, maxOutputTokens });
    return finish(raw, provider.name, provider.model, false);
  } catch (err) {
    const kind = err instanceof AiError ? err.kind : "provider";
    log.warn("ai.generate.failed", { task: req.task, provider: provider.name, kind });
    if (e.AI_FALLBACK_TO_DEMO && kind !== "input_rejected") {
      return finish(demoAnswer(req.task), "demo", "recorded", true);
    }
    throw err;
  }
}
