import { z } from "zod";

/**
 * Text input hygiene. Postgres cannot store a NUL byte (`\0`) in `text` or `jsonb`: the insert fails with an
 * error and the caller sees a 500. Reject it at the boundary with a 400 instead. Every free-text field that reaches
 * the database goes through `text()` (or `.refine(hasNoNul)` on an existing string schema).
 */
export const NUL_MESSAGE = "Text can't contain null characters";

export const hasNoNul = (value: string): boolean => !value.includes("\0");

/** True when a JSON-ish value contains a NUL anywhere in a string, including object keys. Cycles are treated as unsafe. */
export function jsonHasNul(value: unknown): boolean {
  try {
    // JSON escapes a NUL as the six characters \u0000, so searching the serialized form finds it in keys and values.
    return (JSON.stringify(value) ?? "").includes("\\u0000");
  } catch {
    return true;
  }
}

/** A trimmed string of at most `max` characters, with no NUL bytes. `min` defaults to 0 (empty allowed). */
export function text(max: number, opts: { min?: number; minMessage?: string } = {}) {
  const min = opts.min ?? 0;
  return z
    .string()
    .trim()
    .min(min, opts.minMessage ?? (min === 1 ? "Required" : `Must be at least ${min} characters`))
    .max(max)
    .refine(hasNoNul, NUL_MESSAGE);
}
