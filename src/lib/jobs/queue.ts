import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { type Db, schema } from "@/lib/db";

/**
 * Postgres job queue. Plain functions over the `job` table; the worker (worker.ts) is the only caller of
 * `claim`, `complete` and `fail`. Authorization is the caller's: `enqueue` and `retryJob` are called from your
 * own data functions after `assertCan()`, and `retryJob` takes an `ownerId` so a user can't retry someone else's job.
 *
 * Every function takes a handle: `db()` or a transaction. Enqueue inside the transaction that saves the thing the job
 * is about, so a rolled-back save leaves no job. Never hold a transaction across a handler.
 */

type Handle = Pick<Db, "select" | "insert" | "update" | "delete" | "execute">;
const { job } = schema;

/** Delays before attempts 2, 3 and 4. Attempt n's failure waits `BACKOFF_MS[n - 1]` (the last entry repeats). */
export const BACKOFF_MS = [15_000, 60_000, 240_000] as const;
export const DEFAULT_MAX_ATTEMPTS = 4;

export function backoffMs(failedAttempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(failedAttempts, 1), BACKOFF_MS.length) - 1];
}

const MAX_PAYLOAD_BYTES = 4_096;

const enqueueSchema = z.object({
  kind: z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/),
  /** One queued or running job per (kind, key). Omit it to allow duplicates. */
  key: z.string().min(1).max(200).optional(),
  ownerId: z.string().min(1).max(200).optional(),
  /** Ids and small parameters only: no personal data, no secrets. */
  payload: z
    .record(z.string(), z.unknown())
    .refine((p) => Buffer.byteLength(JSON.stringify(p)) <= MAX_PAYLOAD_BYTES, "payload too large")
    .default({}),
  delayMs: z.number().int().min(0).max(7 * 86_400_000).default(0),
  maxAttempts: z.number().int().min(1).max(10).default(DEFAULT_MAX_ATTEMPTS),
});
export type EnqueueInput = z.input<typeof enqueueSchema>;

const ACTIVE_KEYED = sql`${job.status} in ('queued', 'running') and ${job.key} is not null`;
const secs = (ms: number) => sql`make_interval(secs => ${ms / 1000})`;

/**
 * Add a job unless one with the same (kind, key) is already queued or running; then return that one.
 * Safe to call from several requests or instances at once.
 */
export async function enqueue(tx: Handle, input: EnqueueInput): Promise<{ id: string; created: boolean }> {
  const v = enqueueSchema.parse(input);
  for (let i = 0; i < 3; i++) {
    const [row] = await tx
      .insert(job)
      .values({
        kind: v.kind,
        key: v.key ?? null,
        ownerId: v.ownerId ?? null,
        payload: v.payload,
        maxAttempts: v.maxAttempts,
        runAfter: sql`now() + ${secs(v.delayMs)}`,
      })
      .onConflictDoNothing({ target: [job.kind, job.key], where: ACTIVE_KEYED })
      .returning({ id: job.id });
    if (row) return { id: row.id, created: true };
    // Someone else holds the key. If that job finished between our insert and this read, insert again.
    const [existing] = await tx
      .select({ id: job.id })
      .from(job)
      .where(and(eq(job.kind, v.kind), eq(job.key, v.key as string), sql`${job.status} in ('queued', 'running')`))
      .limit(1);
    if (existing) return { id: existing.id, created: false };
  }
  throw new Error("enqueue: could not settle on a job");
}

export type ClaimedJob = {
  id: string;
  kind: string;
  key: string | null;
  ownerId: string | null;
  payload: Record<string, unknown>;
  /** 1 on the first run. */
  attempts: number;
  maxAttempts: number;
  /** Proves this claim is current; `complete` and `fail` do nothing once the lease was reclaimed. */
  lockToken: string;
};

const inList = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

/**
 * Take up to `limit` due jobs of the given kinds and lease them for `leaseMs`. Several workers can call this at
 * once: `for update skip locked` hands each row to exactly one of them, and the update runs in the same statement,
 * so no transaction stays open while the handler runs. Due means queued with `run_after` passed, or running with an
 * expired lease (the worker died or its instance scaled in) and attempts left.
 */
export async function claim(tx: Handle, opts: { kinds: readonly string[]; limit: number; leaseMs: number }): Promise<ClaimedJob[]> {
  if (opts.kinds.length === 0 || opts.limit < 1) return [];
  const rows = await tx.execute<{
    id: string;
    kind: string;
    key: string | null;
    owner_id: string | null;
    payload: Record<string, unknown>;
    attempts: number;
    max_attempts: number;
    lock_token: string;
  }>(sql`
    with picked as materialized (
      select id from job
      where kind in (${inList(opts.kinds)})
        and ((status = 'queued' and run_after <= now())
          or (status = 'running' and locked_until < now() and attempts < max_attempts))
      order by run_after, created_at
      limit ${Math.floor(opts.limit)}
      for update skip locked
    )
    update job set status = 'running', attempts = job.attempts + 1, locked_until = now() + ${secs(opts.leaseMs)},
      lock_token = gen_random_uuid(), updated_at = now()
    from picked where job.id = picked.id
    returning job.id, job.kind, job.key, job.owner_id, job.payload, job.attempts, job.max_attempts, job.lock_token
  `);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    key: r.key,
    ownerId: r.owner_id,
    payload: r.payload,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lockToken: r.lock_token,
  }));
}

/**
 * A job whose lease expired after its last allowed attempt will never be claimed again (it keeps crashing the
 * process, or keeps timing out past the lease). Mark it failed so the UI shows Retry and its key is free.
 */
export async function failExhausted(tx: Handle, kinds: readonly string[]): Promise<number> {
  if (kinds.length === 0) return 0;
  const rows = await tx.execute(sql`
    update job set status = 'failed', last_error = 'lease_expired', locked_until = null, lock_token = null,
      finished_at = now(), updated_at = now()
    where kind in (${inList(kinds)}) and status = 'running' and locked_until < now() and attempts >= max_attempts
    returning id
  `);
  return rows.length;
}

const holds = (j: Pick<ClaimedJob, "id" | "lockToken">) =>
  and(eq(job.id, j.id), eq(job.lockToken, j.lockToken), eq(job.status, "running"));

/** Mark a claimed job done. False when the lease was lost (someone else reclaimed it). */
export async function complete(tx: Handle, j: ClaimedJob): Promise<boolean> {
  const rows = await tx
    .update(job)
    .set({ status: "done", lockedUntil: null, lockToken: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(holds(j))
    .returning({ id: job.id });
  return rows.length > 0;
}

export type FailOptions = {
  /** Short code stored in `last_error` (`[a-z0-9_]`, max 40). Never a message. */
  code: string;
  /** Don't retry: go straight to `failed`. */
  permanent?: boolean;
  /** Retry after this long without using up an attempt (for example "the host is busy, try in 5 s"). */
  deferMs?: number;
};

/**
 * Record a failed attempt: back to `queued` after the backoff (15 s, 1 min, 4 min), or `failed` once attempts run out
 * or the failure is permanent. Returns the new status, or null when the lease was lost.
 */
export async function fail(tx: Handle, j: ClaimedJob, opts: FailOptions): Promise<"queued" | "failed" | null> {
  const code = /^[a-z0-9_]{1,40}$/.test(opts.code) ? opts.code : "error";
  const deferred = opts.deferMs !== undefined && !opts.permanent;
  const exhausted = opts.permanent === true || (!deferred && j.attempts >= j.maxAttempts);
  const next = exhausted ? "failed" : "queued";
  const delay = deferred ? (opts.deferMs as number) : backoffMs(j.attempts);
  const rows = await tx
    .update(job)
    .set({
      status: next,
      attempts: deferred ? Math.max(j.attempts - 1, 0) : j.attempts,
      runAfter: exhausted ? sql`${job.runAfter}` : sql`now() + ${secs(Math.max(0, delay))}`,
      lastError: code,
      lockedUntil: null,
      lockToken: null,
      finishedAt: exhausted ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(holds(j))
    .returning({ id: job.id });
  return rows.length > 0 ? next : null;
}

/**
 * Manual Retry for a failed job, found by id or by (kind, key). Resets attempts and runs it as soon as a worker is
 * free (call `kick()` after). Pass `ownerId` to refuse other users' jobs. Returns `not_found` when no failed job
 * matches, `already_active` when a newer job with the same key is queued or running.
 */
export async function retryJob(
  tx: Handle,
  which: { id: string } | { kind: string; key: string },
  opts: { ownerId?: string } = {},
): Promise<"retried" | "not_found" | "already_active"> {
  const where = "id" in which ? sql`id = ${which.id}` : sql`kind = ${which.kind} and key = ${which.key}`;
  const owner = opts.ownerId !== undefined ? sql`and owner_id = ${opts.ownerId}` : sql``;
  try {
    const rows = await tx.execute(sql`
      update job set status = 'queued', attempts = 0, run_after = now(), last_error = null, finished_at = null, updated_at = now()
      where id = (select id from job where ${where} ${owner} and status = 'failed' order by created_at desc limit 1)
      returning id
    `);
    return rows.length > 0 ? "retried" : "not_found";
  } catch (err) {
    // The partial unique index refuses a second active job for one key.
    if (sqlState(err) === "23505") return "already_active";
    throw err;
  }
}

function sqlState(err: unknown): string | undefined {
  for (let e = err as { code?: unknown; cause?: unknown } | undefined, i = 0; e && i < 5; e = e.cause as typeof e, i++) {
    if (typeof e.code === "string") return e.code;
  }
  return undefined;
}

export type JobState = "queued" | "retrying" | "running" | "done" | "failed";
export type JobStatus = {
  id: string;
  state: JobState;
  attempts: number;
  maxAttempts: number;
  /** Seconds until a queued job may run again (0 when due now). */
  retryInSeconds: number;
  /** Short error code of the last failed attempt, or null. */
  lastError: string | null;
};

/**
 * The newest job for (kind, key), shaped for a status chip: `queued` (not started), `retrying` (failed before,
 * waiting for its backoff), `running`, `done`, `failed` (show Retry). Never returns the payload.
 */
export async function jobStatus(tx: Handle, which: { kind: string; key: string; ownerId?: string }): Promise<JobStatus | null> {
  const owner = which.ownerId !== undefined ? sql`and owner_id = ${which.ownerId}` : sql``;
  const rows = await tx.execute<{
    id: string;
    status: "queued" | "running" | "done" | "failed";
    attempts: number;
    max_attempts: number;
    retry_in: number;
    last_error: string | null;
  }>(sql`
    select id, status, attempts, max_attempts, last_error,
      greatest(0, ceil(extract(epoch from (run_after - now()))))::int as retry_in
    from job where kind = ${which.kind} and key = ${which.key} ${owner}
    order by created_at desc limit 1
  `);
  const r = rows[0];
  if (!r) return null;
  const state: JobState = r.status === "queued" && r.attempts > 0 ? "retrying" : r.status;
  return {
    id: r.id,
    state,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    retryInSeconds: r.status === "queued" ? r.retry_in : 0,
    lastError: r.last_error,
  };
}

/** Counts for an admin page or /api/health (numbers only). */
export async function queueStats(tx: Handle): Promise<{ queued: number; running: number; failed: number; oldestQueuedSeconds: number }> {
  const [r] = await tx.execute<{ queued: number; running: number; failed: number; oldest: number }>(sql`
    select count(*) filter (where status = 'queued')::int as queued,
      count(*) filter (where status = 'running')::int as running,
      count(*) filter (where status = 'failed')::int as failed,
      coalesce(max(extract(epoch from (now() - run_after))) filter (where status = 'queued' and run_after <= now()), 0)::int as oldest
    from job where status in ('queued', 'running', 'failed')
  `);
  return { queued: r.queued, running: r.running, failed: r.failed, oldestQueuedSeconds: r.oldest };
}

/** Delete finished rows: `done` after 7 days, `failed` after 30. The worker calls this about once an hour. */
export async function pruneJobs(tx: Handle, opts: { doneDays?: number; failedDays?: number } = {}): Promise<number> {
  const rows = await tx.execute(sql`
    delete from job where (status = 'done' and finished_at < now() - make_interval(days => ${opts.doneDays ?? 7}))
      or (status = 'failed' and finished_at < now() - make_interval(days => ${opts.failedDays ?? 30}))
    returning id
  `);
  return rows.length;
}
