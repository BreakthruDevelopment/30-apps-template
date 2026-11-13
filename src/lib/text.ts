import { z } from "zod";

/**
 * Text input hygiene. Postgres cannot store a NUL byte (`\0`) in `text` or `jsonb`: the insert fails with an
 * error and the caller sees a 500. Reject it at the boundary with a 400 instead. Every free-text field that reaches
 * the database goes through `text()` (or `.refine(hasNoNul)` on an existing string schema).
 */
export const NUL_MESSAGE = "Text can't contain null characters";

export const hasNoNul = (value: string): boolean => !value.includes("\0");

/**
 * True when a JSON-ish value has a NUL in any string value or object key. It walks the value, so the literal text
 * `C:\u0000dir` (a backslash, then "u0000") is not a false positive. A cycle or a too-deep value counts as unsafe,
 * and so does anything `JSON.stringify` can't serialize, since it can't be stored as jsonb either.
 */
export function jsonHasNul(value: unknown, depth = 0): boolean {
  if (depth > 50) return true;
  if (typeof value === "string") return !hasNoNul(value);
  if (value === null || typeof value !== "object") return false;
  if (depth === 0) {
    try {
      JSON.stringify(value);
    } catch {
      return true; // cycle, BigInt, throwing toJSON
    }
  }
  if (Array.isArray(value)) return value.some((v) => jsonHasNul(v, depth + 1));
  return Object.entries(value).some(([k, v]) => !hasNoNul(k) || jsonHasNul(v, depth + 1));
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
