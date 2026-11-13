import "server-only";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";
import { type ClaimedJob, claim, complete, fail, failExhaustedJobs, pruneJobs } from "./queue";

const CODE = /^[a-z0-9_]{1,40}$/;

/**
 * How jobs run in this process.
 * - `timer`: a timer claims due jobs; `nudge()` and `kick()` run them sooner. For servers that keep their CPU between
 *   requests (Oracle, Azure Container Apps).
 * - `inline`: no timer and `nudge()` does nothing; jobs run only inside `await kick({ budgetMs })`, within the request. For
 *   platforms that give no CPU after the response (AWS Lambda, Cloud Run with CPU allocated only during requests).
 *   Chosen by `JOBS_WORKER=inline`, and automatically when `AWS_LAMBDA_FUNCTION_NAME` (Lambda) or `K_SERVICE` (Cloud Run) is set.
 * - `off`: nothing runs (`JOBS_WORKER=off`: tests, scripts).
 */
export type WorkerMode = "timer" | "inline" | "off";

export function workerMode(env: Record<string, string | undefined> = process.env): WorkerMode {
  const v = env.JOBS_WORKER;
  if (v === "off" || v === "inline" || v === "timer") return v;
  // Cloud Run sets K_SERVICE; with CPU allocated only during requests it behaves like Lambda.
  return env.AWS_LAMBDA_FUNCTION_NAME || env.K_SERVICE ? "inline" : "timer";
}

/** What a handler sees. The payload is yours; never log it. */
export type JobInfo = Pick<ClaimedJob, "id" | "kind" | "key" | "ownerId" | "payload">;
export type JobContext = {
  /** Aborted at the timeout. Pass it to fetch() and other cancellable work; a handler that ignores it keeps running unseen. */
  signal: AbortSignal;
  /** 1 on the first run. */
  attempt: number;
  maxAttempts: number;
};
/**
 * Do the work and return, or throw. Handlers must be idempotent: a job can run twice (a crash after the work but
 * before `complete`, or a lease that expired while a slow handler was still running). Re-check the state you are about
 * to change instead of assuming a clean start.
 */
export type JobHandler = (job: JobInfo, ctx: JobContext) => Promise<void>;
export type JobHandlers = Record<string, JobHandler>;

/**
 * Throw this from a handler to choose how a failure is handled. Anything else a handler throws is a retryable
 * failure with code `error`. The code must match `[a-z0-9_]{1,40}`, otherwise it becomes `error`, so only safe
 * strings reach the log and `last_error` even when a handler builds a code from data. The message is the code.
 * `deferMs` must be a finite number (it is clamped to 1 s to 1 h and capped at 20 deferrals per job); otherwise the
 * failure is an ordinary retry.
 */
export class JobError extends Error {
  readonly permanent: boolean;
  readonly deferMs?: number;
  readonly code: string;
  constructor(code: string, opts: { permanent?: boolean; deferMs?: number } = {}) {
    const safe = typeof code === "string" && CODE.test(code) ? code : "error";
    super(safe);
    this.code = safe;
    this.name = "JobError";
    this.permanent = opts.permanent ?? false;
    this.deferMs = typeof opts.deferMs === "number" && Number.isFinite(opts.deferMs) ? opts.deferMs : undefined;
  }
}

/** The transaction a give-up hook runs in: the one that marks the job failed. */
export type JobTx = Parameters<Parameters<ReturnType<typeof db>["transaction"]>[0]>[0];

/**
 * Called when a job of that kind reaches `failed` for good: a permanent failure, attempts used up (including a
 * deferral that ran out of deferrals), or a lease that expired on the last attempt (the process was killed). Use it
 * to put whatever the job was working on into a state the user can act on.
 *
 * It runs in the SAME transaction as the status change, so either both commit or neither does. Rules for the body:
 * - Use only `tx`. Never `db()`: a write made outside `tx` is not rolled back when the hook fails, and it can wait
 *   on a row `tx` holds.
 * - Keep it short and local: a few statements on your own tables. No network or AI calls, nothing slow. It is capped
 *   at `hookTimeoutMs` (default 5 s; inline mode: also by what is left of the kick's budget, at least 100 ms), and
 *   `signal` aborts at that cap.
 * - Never touch the `job` table; the worker owns it.
 * - Make it idempotent.
 *
 * If the hook throws or times out, the whole transaction is rolled back (so nothing the hook did, even a late write
 * after the cap, can commit) and the worker records the failure again WITHOUT the hook: the job ends `failed`, the
 * error is logged, and the app must reconcile rows it can see are stuck (for example a link still `queued` whose job
 * is `failed`). Hooks never stop the worker. `code` is the job's `last_error`.
 */
export type JobGiveUp = (job: JobInfo, code: string, tx: JobTx, signal: AbortSignal) => Promise<void>

export type WorkerOptions = {
  handlers: JobHandlers;
  /** One optional hook per job `kind`; see `JobGiveUp`. */
  onGiveUp?: Record<string, JobGiveUp>;
  /** Timer period; also how often exhausted leases are cleaned up. Default 10 s. */
  intervalMs?: number;
  /** Jobs running at once in this process. Default 2. */
  concurrency?: number;
  /** Per-job time box. Default 25 s. Must be shorter than `leaseMs`. */
  timeoutMs?: number;
  /** How long a claim holds a job before another worker may take it. Default 60 s. */
  leaseMs?: number;
  /** Minimum gap between `nudge()`s that do anything. Default 10 s. */
  nudgeMs?: number;
  /** Clock for the nudge throttle and kick budgets (tests). */
  now?: () => number;
  /** `timer` (default) or `inline`; see `WorkerMode`. */
  mode?: "timer" | "inline";
  /** Cap for one `onGiveUp` hook (see `JobGiveUp`). Default 5 s. */
  hookTimeoutMs?: number;
  /** Budget `kick()` uses when you pass none. Default 15 s, well under API Gateway's 29 s. */
  budgetMs?: number;
};

export type KickOptions = {
  /**
   * How long this call may spend. Inline mode claims nothing once it runs out, and each job's timeout is cut to what is
   * left, so the call returns within about the budget. Timer mode stops claiming and stops waiting at the budget
   * (running jobs carry on in the background). Default 15 s.
   */
  budgetMs?: number;
  /** Run only these jobs (for example the ones this request just enqueued) instead of whatever is due. */
  ids?: readonly string[];
};

export type Worker = {
  /** Start the timer and run due jobs now. */
  start(): void;
  /** Run due jobs (or `ids`) now, within the budget; not throttled. Resolves when none are left to claim and the ones it started have finished. */
  kick(opts?: KickOptions): Promise<void>;
  /** Throttled kick for "someone is using the app" signals. Timer mode only: inline mode returns false. Never throws, never waits. */
  nudge(): boolean;
  /** Stop claiming; resolves when running jobs have finished (each is bounded by the timeout). */
  stop(): Promise<void>;
  /** Jobs running in this process. */
  inFlight(): number;
};

const MIN_BUDGET_MS = 250;
/** Expired last-attempt jobs one reap handles; the rest wait for the next interval, so a pile-up can't overrun a kick's budget. */
const MAX_REAP_ROWS = 5;
class HookFailed extends Error {}
const FIXED_MESSAGES = new Set(["database query failed", "invalid JSON or syntax", "non-error thrown"]);

/**
 * A handler's error text may quote the job's data ("could not fetch https://...", "no mailbox ada@..."), so only
 * fixed messages from safeErrorFields are logged; any other error is logged by name. Throw `JobError(code)` to get a
 * code into the log.
 */
function handlerErrorFields(err: unknown): Record<string, unknown> {
  const { error, ...rest } = safeErrorFields(err);
  return FIXED_MESSAGES.has(error) ? { error, ...rest } : rest;
}

export function createWorker(options: WorkerOptions): Worker {
  const o = { intervalMs: 10_000, concurrency: 2, timeoutMs: 25_000, leaseMs: 60_000, nudgeMs: 10_000, budgetMs: 15_000, hookTimeoutMs: 5_000, mode: "timer" as const, now: Date.now, ...options };
  const inline = options.mode === "inline";
  if (!(o.concurrency >= 1)) throw new Error("concurrency must be at least 1");
  if (!(o.timeoutMs < o.leaseMs)) throw new Error("timeoutMs must be shorter than leaseMs, or a slow job's lease can expire while it runs");
  const kinds = Object.keys(o.handlers);

  const running = new Set<Promise<void>>();
  let ticking: Promise<void> | null = null;
  let again = false;
  let wantReap = false;
  let reserved = 0;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastNudge = Number.NEGATIVE_INFINITY;
  let lastPrune = 0;
  let lastReap = Number.NEGATIVE_INFINITY;

  /**
   * Claim up to the free slots and launch the jobs. Slots are reserved while the claim is in flight, so two callers
   * (the timer and a kick) can't both fill the same free slots and exceed `concurrency`.
   * Returns null when no slot was free, else the launched jobs.
   */
  async function claimAndLaunch(timeoutFor: () => number, ids?: readonly string[], left?: () => number): Promise<Promise<void>[] | null> {
    const free = o.concurrency - running.size - reserved;
    if (free < 1) return null;
    reserved += free;
    try {
      const claimed = await claim(db(), { kinds, limit: free, leaseMs: o.leaseMs, ids });
      return claimed.map((j) => launch(j, timeoutFor(), left));
    } finally {
      reserved -= free;
    }
  }

  /**
   * Mark jobs whose lease expired on their last attempt as failed and run their hooks. They are never claimed again,
   * so without this they stay `running` and keep their key blocked. At most `MAX_REAP_ROWS` per call, each in its own
   * transaction (status change plus hook), and none after `deadline`. Housekeeping (pruning old finished jobs) rides
   * along at most once an hour.
   */
  async function reap(hookMs: () => number, deadline = Number.POSITIVE_INFINITY): Promise<void> {
    lastReap = o.now();
    let count = 0;
    while (count < MAX_REAP_ROWS && o.now() < deadline) {
      const [done] = await withHook(
        (tx) => failExhaustedJobs(tx, kinds, { limit: 1 }),
        (rows) => (rows[0] ? { job: rows[0], code: "lease_expired" } : null),
        (rows) => failExhaustedJobs(db(), kinds, { ids: rows.map((r) => r.id) }),
        hookMs,
      );
      if (!done) break;
      count++;
    }
    if (count > 0) log.warn("jobs.lease_exhausted", { count });
    if (o.now() - lastPrune > 3_600_000) {
      lastPrune = o.now();
      const pruned = await pruneJobs(db());
      if (pruned > 0) log.info("jobs.pruned", { count: pruned });
    }
  }

  async function claimOnce(): Promise<void> {
    if (wantReap) {
      wantReap = false;
      await reap(() => o.hookTimeoutMs);
    }
    if (stopped) return;
    await claimAndLaunch(() => o.timeoutMs);
  }

  /**
   * Apply a status change and run the kind's hook in one transaction. If the hook fails or times out the whole
   * transaction is rolled back, so a late write from a hook that outlived its cap finds a finished transaction and
   * cannot commit; the status change is then redone in a fresh transaction without the hook.
   */
  async function withHook<R>(
    apply: (tx: JobTx) => Promise<R>,
    hookFor: (result: R) => { job: JobInfo; code: string } | null,
    redo: (result: R) => Promise<R>,
    hookMs: () => number,
  ): Promise<R> {
    let applied: { result: R; job: JobInfo; err: unknown } | null = null;
    try {
      return await db().transaction(async (tx) => {
        const result = await apply(tx);
        const h = hookFor(result);
        const hook = h && o.onGiveUp?.[h.job.kind];
        if (h && hook) {
          try {
            await runHook(hook, tx, h.job, h.code, hookMs());
          } catch (err) {
            applied = { result, job: h.job, err };
            throw new HookFailed();
          }
        }
        return result;
      });
    } catch (err) {
      const failed = applied as { result: R; job: JobInfo; err: unknown } | null;
      if (!(err instanceof HookFailed) || !failed) throw err;
      log.error("jobs.give_up_failed", { jobId: failed.job.id, kind: failed.job.kind, ...handlerErrorFields(failed.err) });
      return redo(failed.result);
    }
  }

  async function runHook(hook: JobGiveUp, tx: JobTx, j: JobInfo, code: string, limitMs: number): Promise<void> {
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    try {
      const work = Promise.resolve().then(() =>
        hook({ id: j.id, kind: j.kind, key: j.key, ownerId: j.ownerId, payload: j.payload }, code, tx, controller.signal),
      );
      work.catch(() => {}); // a hook that outlives its timeout must not become an unhandled rejection
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new JobError("timeout"));
        }, Math.max(1, limitMs));
      });
      await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  /** The cap for one hook: `hookTimeoutMs`, and in inline mode no more than what is left of the budget (at least 100 ms). */
  function hookLimit(left?: () => number): number {
    return inline && left ? Math.min(o.hookTimeoutMs, Math.max(left(), 100)) : o.hookTimeoutMs;
  }

  function launch(j: ClaimedJob, timeoutMs: number, left?: () => number): Promise<void> {
    const p: Promise<void> = run(j, timeoutMs, left).finally(() => {
      running.delete(p);
      if (!inline) void pump(); // a slot is free: take the next due job (inline mode has no CPU to spare outside a kick)
    });
    running.add(p);
    return p;
  }

  async function kickWithinBudget(budgetMs: number, ids?: readonly string[]): Promise<void> {
    const started = o.now();
    const left = () => budgetMs - (o.now() - started);
    // Inline mode has no timer to do this, so a kick does it, at most once per interval. It counts against the budget.
    // Reaping stops at the budget; a hook may run a little past it (at least 100 ms) rather than be cut to nothing.
    if (!stopped && o.now() - lastReap >= o.intervalMs) await reap(() => hookLimit(left), started + budgetMs);
    const mine: Promise<void>[] = [];
    while (!stopped && left() >= MIN_BUDGET_MS) {
      // Inline: a job may not outlive the request, so its timeout is what is left of the budget.
      const launched = await claimAndLaunch(() => (inline ? Math.min(o.timeoutMs, Math.max(left(), MIN_BUDGET_MS)) : o.timeoutMs), ids, left);
      if (launched === null) {
        await new Promise((r) => setTimeout(r, Math.min(left(), 25))); // all slots busy: wait for one
        continue;
      }
      if (launched.length === 0) break;
      mine.push(...launched);
    }
    const all = Promise.all(mine);
    if (inline) await all;
    else {
      // Also wait for jobs the timer or a nudge started: "idle" is what callers of kick() expect.
      let budgetTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([waitIdle(), new Promise((r) => (budgetTimer = setTimeout(r, Math.max(left(), 0))))]);
      clearTimeout(budgetTimer);
    }
  }

  /** Claim as many due jobs as there are free slots. Calls overlap safely: one claim loop runs at a time. */
  function pump(): Promise<void> {
    if (ticking) {
      again = true;
      return ticking;
    }
    ticking = (async () => {
      try {
        do {
          again = false;
          await claimOnce();
        } while (again && !stopped);
      } catch (err) {
        log.error("jobs.claim_failed", safeErrorFields(err));
      } finally {
        ticking = null;
      }
    })();
    return ticking;
  }

  async function run(j: ClaimedJob, timeoutMs: number, left?: () => number): Promise<void> {
    const started = Date.now();
    const base = { jobId: j.id, kind: j.kind, attempt: j.attempts };
    const controller = new AbortController();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    let failure: { code: string; permanent?: boolean; deferMs?: number } | null = null;
    try {
      const handler = o.handlers[j.kind];
      const work = Promise.resolve().then(() =>
        handler({ id: j.id, kind: j.kind, key: j.key, ownerId: j.ownerId, payload: j.payload }, { signal: controller.signal, attempt: j.attempts, maxAttempts: j.maxAttempts }),
      );
      const timeout = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          controller.abort();
          reject(new JobError("timeout"));
        }, timeoutMs);
      });
      await Promise.race([work, timeout]);
    } catch (err) {
      if (err instanceof JobError) failure = { code: err.code, permanent: err.permanent, deferMs: err.deferMs };
      else failure = { code: "error" };
      log.warn("jobs.attempt_failed", { ...base, code: failure.code, ...(err instanceof JobError ? {} : handlerErrorFields(err)) });
    } finally {
      clearTimeout(timeoutHandle);
    }
    const ms = Date.now() - started;
    try {
      if (!failure) {
        if (await complete(db(), j)) log.info("jobs.done", { ...base, ms });
        else log.warn("jobs.lease_lost", base);
      } else {
        const failed = failure;
        const next = await withHook(
          (tx) => fail(tx, j, failed),
          (result) => (result === "failed" ? { job: j, code: failed.code } : null),
          () => fail(db(), j, failed),
          () => hookLimit(left),
        );
        if (next === null) log.warn("jobs.lease_lost", base);
        else log.info(next === "failed" ? "jobs.failed" : "jobs.will_retry", { ...base, code: failure.code, ms });
      }
    } catch (err) {
      // The lease expires and the job is reclaimed; nothing is lost.
      log.error("jobs.record_failed", { ...base, ...safeErrorFields(err) });
    }
  }

  async function waitIdle(): Promise<void> {
    for (;;) {
      if (ticking) await ticking;
      else if (running.size > 0) await Promise.race(running);
      else return;
    }
  }

  return {
    start() {
      if (inline || timer || stopped || kinds.length === 0) return;
      timer = setInterval(() => {
        wantReap = true;
        void pump();
      }, o.intervalMs);
      timer.unref?.();
      wantReap = true;
      void pump(); // leftovers from before the app went to sleep run now
    },
    async kick(opts = {}) {
      if (kinds.length === 0 || stopped) return;
      try {
        await kickWithinBudget(opts.budgetMs ?? o.budgetMs, opts.ids);
      } catch (err) {
        log.error("jobs.claim_failed", safeErrorFields(err));
      }
    },
    nudge() {
      if (inline || kinds.length === 0 || stopped) return false;
      const t = o.now();
      if (t - lastNudge < o.nudgeMs) return false;
      lastNudge = t;
      void pump();
      return true;
    },
    async stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      await waitIdle();
    },
    inFlight: () => running.size,
  };
}

// Instrumentation and route handlers can load separate copies of this module, so the singleton lives on globalThis.
const KEY = Symbol.for("30apps.jobsWorker");
const SIGTERM_KEY = Symbol.for("30apps.jobsWorker.sigterm");
type Holder = { [KEY]?: Worker; [SIGTERM_KEY]?: boolean };
const holder = globalThis as Holder;

/**
 * Start this process's worker (call from `instrumentation.ts` after `whenMigrated()`). One per process; a second call
 * returns the first. The mode comes from `workerMode()`: `JOBS_WORKER=off` starts nothing and makes `kick()` and
 * `nudge()` no-ops; `inline` (or AWS Lambda) starts no timer and runs jobs only inside `await kick({ budgetMs })`.
 * On SIGTERM a timer worker stops claiming. Next's standalone server exits right after SIGTERM without waiting, so a
 * job still running is not finished: it is reclaimed when its lease expires.
 */
export function startWorker(options: Omit<WorkerOptions, "mode">): { stop: () => Promise<void> } {
  const mode = workerMode();
  if (mode === "off") {
    log.info("jobs.worker_off");
    return { stop: async () => {} };
  }
  if (holder[KEY]) return { stop: () => stopWorker() };
  const worker = createWorker({ ...options, mode });
  holder[KEY] = worker;
  worker.start();
  if (mode === "timer" && !holder[SIGTERM_KEY]) {
    holder[SIGTERM_KEY] = true; // one listener per process, however often the worker is started and stopped
    process.once("SIGTERM", () => void stopWorker());
  }
  log.info("jobs.worker_started", { mode, kinds: Object.keys(options.handlers), concurrency: options.concurrency ?? 2 });
  return { stop: () => stopWorker() };
}

export async function stopWorker(): Promise<void> {
  const w = holder[KEY];
  holder[KEY] = undefined;
  if (w) await w.stop();
}

/**
 * Run due jobs now, within `budgetMs` (default 15 s). Timer mode: `after(() => kick())` once the enqueuing transaction
 * commits. Inline mode (Lambda, Cloud Run): `await kick({ budgetMs, ids: [id] })` inside the request, before responding.
 */
export async function kick(opts?: KickOptions): Promise<void> {
  await holder[KEY]?.kick(opts);
}

/** Call on every signed-in request, ignoring the result: at most one claim per `nudgeMs` per process. No-op inline. */
export function nudge(): boolean {
  return holder[KEY]?.nudge() ?? false;
}
