import "server-only";
import { db } from "@/lib/db";
import { log } from "@/lib/log";
import { safeErrorFields } from "@/lib/safe-error";
import { type ClaimedJob, claim, complete, fail, failExhausted, pruneJobs } from "./queue";

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
 * failure with code `error`. The message is the code, so it is safe to log and store.
 */
export class JobError extends Error {
  readonly permanent: boolean;
  readonly deferMs?: number;
  constructor(
    readonly code: string,
    opts: { permanent?: boolean; deferMs?: number } = {},
  ) {
    super(code);
    this.name = "JobError";
    this.permanent = opts.permanent ?? false;
    this.deferMs = opts.deferMs;
  }
}

export type WorkerOptions = {
  handlers: JobHandlers;
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
  /** Clock for the nudge throttle (tests). */
  now?: () => number;
};

export type Worker = {
  /** Start the timer and run due jobs now. */
  start(): void;
  /** Run due jobs now (not throttled); resolves when this process has nothing running and nothing due. */
  kick(): Promise<void>;
  /** Throttled kick for "someone is using the app" signals. Returns whether it did anything. Never throws, never waits. */
  nudge(): boolean;
  /** Stop claiming; resolves when running jobs have finished (each is bounded by the timeout). */
  stop(): Promise<void>;
  /** Jobs running in this process. */
  inFlight(): number;
};

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
  const o = { intervalMs: 10_000, concurrency: 2, timeoutMs: 25_000, leaseMs: 60_000, nudgeMs: 10_000, now: Date.now, ...options };
  if (!(o.concurrency >= 1)) throw new Error("concurrency must be at least 1");
  if (!(o.timeoutMs < o.leaseMs)) throw new Error("timeoutMs must be shorter than leaseMs, or a slow job's lease can expire while it runs");
  const kinds = Object.keys(o.handlers);

  const running = new Set<Promise<void>>();
  let ticking: Promise<void> | null = null;
  let again = false;
  let wantReap = false;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastNudge = Number.NEGATIVE_INFINITY;
  let lastPrune = 0;

  async function claimOnce(): Promise<void> {
    if (wantReap) {
      wantReap = false;
      const n = await failExhausted(db(), kinds);
      if (n > 0) log.warn("jobs.lease_exhausted", { count: n });
      if (o.now() - lastPrune > 3_600_000) {
        lastPrune = o.now();
        const pruned = await pruneJobs(db());
        if (pruned > 0) log.info("jobs.pruned", { count: pruned });
      }
    }
    const free = o.concurrency - running.size;
    if (stopped || free < 1) return;
    const claimed = await claim(db(), { kinds, limit: free, leaseMs: o.leaseMs });
    for (const j of claimed) {
      const p: Promise<void> = run(j).finally(() => {
        running.delete(p);
        void pump(); // a slot is free: take the next due job
      });
      running.add(p);
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

  async function run(j: ClaimedJob): Promise<void> {
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
        }, o.timeoutMs);
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
        const next = await fail(db(), j, failure);
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
      if (timer || stopped || kinds.length === 0) return;
      timer = setInterval(() => {
        wantReap = true;
        void pump();
      }, o.intervalMs);
      timer.unref?.();
      wantReap = true;
      void pump(); // leftovers from before the app went to sleep run now
    },
    async kick() {
      if (kinds.length === 0 || stopped) return;
      await pump();
      await waitIdle();
    },
    nudge() {
      if (kinds.length === 0 || stopped) return false;
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
type Holder = { [KEY]?: Worker | "off" };
const holder = globalThis as Holder;

/**
 * Start this process's worker (call from `instrumentation.ts` after `whenMigrated()`). One per process; a second call
 * returns the first. `JOBS_WORKER=off` starts nothing and makes `kick()` and `nudge()` no-ops (tests, one-off scripts).
 * On SIGTERM it stops claiming and lets running jobs finish. A job cut off anyway is reclaimed when its lease expires.
 */
export function startWorker(options: WorkerOptions): { stop: () => Promise<void> } {
  if (process.env.JOBS_WORKER === "off") {
    log.info("jobs.worker_off");
    return { stop: async () => {} };
  }
  const existing = holder[KEY];
  if (existing && existing !== "off") return { stop: () => stopWorker() };
  const worker = createWorker(options);
  holder[KEY] = worker;
  worker.start();
  process.once("SIGTERM", () => void stopWorker());
  log.info("jobs.worker_started", { kinds: Object.keys(options.handlers), concurrency: options.concurrency ?? 2 });
  return { stop: () => stopWorker() };
}

export async function stopWorker(): Promise<void> {
  const w = holder[KEY];
  holder[KEY] = undefined;
  if (w && w !== "off") await w.stop();
}

/** Run due jobs now. Use `after(() => kick())` right after the transaction that enqueued a job commits. */
export async function kick(): Promise<void> {
  const w = holder[KEY];
  if (w && w !== "off") await w.kick();
}

/** Call on every signed-in request, ignoring the result: at most one claim per `nudgeMs` per process. */
export function nudge(): boolean {
  const w = holder[KEY];
  return w && w !== "off" ? w.nudge() : false;
}
