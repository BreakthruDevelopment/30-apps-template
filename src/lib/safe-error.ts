/**
 * Describe an error for a log line without leaking what caused it.
 *
 * Database errors carry user data: drizzle-orm's `DrizzleQueryError` message is
 * `Failed query: <sql>\nparams: <values>`, and a Postgres `detail` can read
 * `Key (email)=(ada@example.com) already exists`. So for anything that looks like a database
 * error this returns only a fixed message plus the SQLSTATE `code` and the `constraint` name.
 * Other errors keep their `message`, which is written by our code, not built from request data.
 * Always log `safeErrorFields(err)`, never `err.message` or the error object itself.
 */
export function safeErrorFields(err: unknown): { error: string; name?: string; code?: string; constraint?: string } {
  if (!(err instanceof Error)) return { error: "non-error thrown" };
  if (isDatabaseError(err)) {
    // drizzle wraps the driver error in `cause`; a bare postgres.js error carries the fields itself.
    return { error: "database query failed", name: err.name, ...pick(err), ...pick(err.cause) };
  }
  return { error: err.message, name: err.name };
}

function isDatabaseError(err: Error): boolean {
  if (err.name === "DrizzleQueryError" || err.name === "PostgresError") return true;
  const e = err as unknown as Record<string, unknown>;
  // Anything carrying the statement or its parameters, or wrapping a Postgres error.
  if ("query" in e || "params" in e) return true;
  const cause = e.cause as Record<string, unknown> | undefined;
  return !!cause && typeof cause === "object" && (cause.name === "PostgresError" || "query" in cause || "severity" in cause);
}

function pick(source: unknown): { code?: string; constraint?: string } {
  if (!source || typeof source !== "object") return {};
  const s = source as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  const out: { code?: string; constraint?: string } = {};
  if (typeof s.code === "string" && /^[0-9A-Z]{5}$/.test(s.code)) out.code = s.code;
  const constraint = s.constraint_name ?? s.constraint;
  // Constraint names are schema identifiers; refuse anything that doesn't look like one.
  if (typeof constraint === "string" && /^[A-Za-z0-9_]{1,63}$/.test(constraint)) out.constraint = constraint;
  return out;
}
