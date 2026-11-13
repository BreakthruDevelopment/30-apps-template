import type { JobGiveUp, JobHandlers } from "./worker";

/**
 * Register job handlers here: one entry per job `kind`. `instrumentation.ts` hands this map to `startWorker`.
 * The template ships none, so its worker does nothing until an app adds some.
 *
 *   export const handlers: JobHandlers = { "fetch-link": fetchLinkHandler };
 */
export const handlers: JobHandlers = {};

/**
 * Optional per-kind hook for a job that failed for good (permanent failure, attempts used up, or a lease that expired
 * on the last attempt); see `JobGiveUp`. It runs in the same transaction as the status change: use only the `tx` it is
 * given (never `db()`), keep it to a few fast statements on your own tables (no network or AI calls, never the `job`
 * table), and make it idempotent; writes made outside `tx` are not rolled back. Use it to move whatever the job was working on into a state the user can act on.
 *
 *   export const onGiveUp: Record<string, JobGiveUp> = { "fetch-link": giveUpFetch };
 */
export const onGiveUp: Record<string, JobGiveUp> = {};
