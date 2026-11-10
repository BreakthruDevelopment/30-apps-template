# 30 Apps Template

The starting point for every app in Breakthru Ventures' **30 apps in 30 days** portfolio. Each app is a
responsive web app with a Postgres database, sign-in with roles, one AI feature, and a single container
image that deploys to AWS, Azure, Google Cloud or Oracle Cloud.

## What this app does

_Each app replaces this section: the customer problem, who uses it, and what the AI feature does._

The template ships an example "items" feature: users manage their own items, admins see everyone's, and
an AI summary describes the list.

## Architecture

```
Browser (desktop and phone)
   │ HTTPS + session cookie
   ▼
Next.js container ── pages, server actions, route handlers (/api/*)
   │                  auth + RBAC, zod validation, AI gateway, JSON logs, /api/health
   ├──► Postgres (Drizzle; pgvector available for RAG)
   └──► Model API (Gemini free tier, Claude optional, or recorded demo answers)
```

| Concern | Where |
| --- | --- |
| Config, validated at startup | `src/lib/env.ts` |
| Schema and migrations | `src/lib/db/schema.ts`, `drizzle/` |
| Sign-in, sessions, roles | `src/lib/auth/` (Better Auth + admin plugin) |
| Access rules | `src/lib/auth/rbac.ts`, enforced in every data function |
| AI gateway | `src/lib/ai/` — input cap, JSON schema validation, demo fallback |
| Health check | `GET /api/health` (503 if the database is down) |

## Auth and roles

Two roles, `user` and `admin`, via Better Auth's admin plugin. **Admins manage accounts but never act as users:**
`src/lib/auth/permissions.ts` gives `admin` create, list, get, update, set-role, ban and delete on users plus
session revoke/delete. It withholds `impersonate`, `impersonate-admins`, `set-password` and `set-email`
(Better Auth's default admin role includes them) and session `list`, which would expose other users' raw
session tokens, IP addresses and user agents. `/admin/impersonate-user`, `/admin/stop-impersonating`,
`/admin/set-user-password` and `/admin/list-user-sessions` are also in `disabledPaths`, so they return 404 even
if a role is widened later. `update` lets an admin change another user's name and image (intended).
Tests: `test/admin-permissions.integration.test.ts`. Don't add these permissions back; apps promise that admins
see counts only.

## Run locally

```bash
cp .env.example .env.local          # then set BETTER_AUTH_SECRET (openssl rand -base64 32)
docker compose up -d db
pnpm install
pnpm db:migrate
pnpm dev                             # http://localhost:3000
```

To make yourself an admin: sign up, then `SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD=... pnpm db:seed`
while the app is running.

## Design system

Every app shares the Breakthru look (guide and concept: `ai-dev-os/design/`). Tokens live in `src/app/globals.css`
(light and dark; use `bg-surface`, `text-muted`, `border-border`, `bg-accent` and the status tokens, never raw colors).
Fonts are self-hosted with `next/font/local` in `src/app/layout.tsx` (files and licenses in `src/app/fonts/`, so builds need no network): Newsreader (`font-display`), Public Sans (`font-sans`),
IBM Plex Mono (`font-mono`). Set the app's name once in `src/lib/app-config.ts` (`APP_TITLE`, or the `APP_NAME` variable).

| Component | Location | Use |
| --- | --- | --- |
| `AppShell` | `src/components/app-shell.tsx` | Header (logo, app name, nav, sign in or user and sign out) and footer; wraps every page in the root layout |
| `PageIntro` | `src/components/ui/` | Eyebrow, Newsreader headline, one-line description, actions |
| `StatTile`, `StatGrid` | `src/components/ui/` | A number and a label; tiles stack at 375px |
| `FilterBar` | `src/components/ui/` | Search, select filters, sort and table/cards toggle as a GET form (state in the URL) |
| `StatusBadge` | `src/components/ui/` | Live, building, blocked, not started (neutral), healthy, degraded, down |
| `DataList` | `src/components/ui/` | Table from 640px, cards below |
| `Panel` | `src/components/ui/` | Titled panel; `collapsible` adds a "Show all" toggle (small client component) |
| `DemoBadge` | `src/components/ui/` | "Demo data" label for seeded or demo content |

The header links come from `NAV_LINKS` in `src/lib/app-config.ts`; each app must edit that list (the template's
`/dashboard` and `/admin` links break if the app deletes those pages).

Shared button and field classes are in `src/components/ui/styles.ts` (44px minimum height). Don't add `loading.tsx` or
`<Suspense>` above a page that calls `requireRoleOrRedirect()` or `notFound()`.

## Shared helpers

Small, self-contained files every app has needed. Copy the ones you use (with their tests); each imports only from
the paths named here. Porting migration `0001_shared-helpers.sql` into an app that already has migrations: copy the SQL under the app's own
next number, and also add its entry to `drizzle/meta/_journal.json` and its snapshot (or run `pnpm db:generate` after copying
`schema.ts`, which writes all three); a SQL file without a journal entry is silently never applied.

Authorization still lives in `src/lib/auth/rbac.ts` and your data functions.

| File | Use it when |
| --- | --- |
| `src/lib/errors.ts` | You throw a domain error from a data function: `NotFoundError` (404), `ConflictError` (409), `BadRequestError` (400), `TooManyRequestsError` (429), `PayloadTooLargeError` (413), `UnprocessableError` (422). `errorResponse` maps them. |
| `src/lib/http.ts` | Every route handler: `errorResponse(err)` and `readJson(request, maxBytes)` (capped read, 413 or 400 on bad bodies). `readBodyCapped` for uploads. |
| `src/lib/safe-error.ts` | You log an error. `safeErrorFields(err)` drops database query parameters (emails, note text); never log `err.message` of a database error yourself. |
| `src/lib/csrf.ts` | A cookie-authenticated POST, PATCH or DELETE route handler: call `requireSameOrigin(request)` first. The Origin must equal the origin of `APP_URL` exactly, so a request from any other hostname for the same app (`www.`, an alias, a bare IP) gets 403; set `APP_URL` to the one public URL. |
| `src/lib/owned.ts` | A table is private to its owner, admin included: `ownedBy(table, actor, ...conditions)` in every select, update and delete; zero rows means 404. |
| `src/lib/usage.ts` + `rate_event`, `daily_usage` tables | You cap a user's attempts (`consumeRate`, sliding window, inside `db().transaction`) or an app-wide daily budget (`reserveDaily`). List your kinds in `schema.ts` (`RATE_KINDS`, `DAILY_USAGE_KINDS`) and add a migration. Keep the transaction short and at READ COMMITTED; never hold it across an AI call (see the comments in the file). |
| `src/lib/magic.ts` | You accept an upload: `matchesMagic(type, bytes)` for PDF, PNG, JPEG, WebP. Never trust the Content-Type header. |
| `src/lib/safe-fetch.ts` + `src/lib/ip-guard.ts` | Your server fetches a user-supplied URL (needs `ip-guard.ts`): `safeFetch(url, { maxBytes, timeoutMs })`. Checking a hostname and then fetching it is not safe (DNS rebinding), so it vets the address the connection actually uses: `isPublicIp` runs inside the socket's `lookup` on every resolved address, IP literals are checked up front, redirects are followed by hand and re-checked at each hop, and the body size and total time are capped. Don't write your own fetch for user URLs; if you must, keep all of that. |
| `src/lib/crypto/envelope.ts` | You store a secret you must read back (OAuth tokens, API keys): see [Encrypting stored secrets](#encrypting-stored-secrets). |
| `src/lib/jobs/*` + `job` table | Work must outlive the request (fetch a page, call a model, send mail): see [Background jobs](#background-jobs). |
| `src/lib/db/migrate-on-start.ts` | Already wired by `instrumentation.ts`. Background work that needs the schema awaits `whenMigrated()` first. |
| `src/lib/demo-identity.ts`, `src/lib/demo-seed-config.ts` | The app has a demo workspace: `demoSeedConfig()` runs first in `scripts/seed-demo.mts` and refuses production hosts and databases; `isDemoEmail` and `MARKER` stop public sign-ups faking a demo user. Set `MARKER` per app. |

## Encrypting stored secrets

`src/lib/crypto/envelope.ts` (one file plus its test, `node:crypto` only) encrypts a value with AES-256-GCM under a random
per-value data key, which is wrapped by a key-encryption key (KEK) from the environment. There is no KMS (it costs money).
The ciphertext is bound to its row through the AAD, so a blob copied to another row or user won't decrypt.

```ts
import { decrypt, encrypt, rowAad } from "@/lib/crypto/envelope";

const aad = rowAad("bank_item", row.id, row.userId); // table, row id, owner: same call on write and read
await db().update(bankItem).set({ accessToken: encrypt(token, aad) }).where(...);
const token = decrypt(row.accessToken, rowAad("bank_item", row.id, row.userId)); // the only place that decrypts
```

- Generate a key: `openssl rand -base64 32`. Set it as `TOKEN_ENC_KEY` (cloud secret manager in production, `.env.local` locally).
  It must decode to exactly 32 bytes. Call `validateEncryptionEnv()` at startup (for example from `instrumentation.ts`) so a
  bad key stops the server with a clear message; it returns key ids (a hash prefix), never the key.
- Store the blob in a `text` column. Format: `v1.<keyId>.<wrapIv>.<wrappedDek>.<wrapTag>.<iv>.<ciphertext>.<tag>`.
- Decrypt in one function, never log what it returns, and never include the AAD or plaintext in errors. Every decrypt
  failure throws the same `EnvelopeError`, whatever the cause.
- Values over 64 KiB are refused (this is for small secrets such as tokens); the empty string is fine.
- **Rotate the key:** generate a new key; set `TOKEN_ENC_KEY_PREVIOUS` to the old value and `TOKEN_ENC_KEY` to the new one;
  deploy. New writes use the new key and old rows still decrypt. Then for each row where `needsRewrap(blob)` is true, save
  `rewrap(blob)` (it re-wraps the data key without decrypting the value or needing the AAD). When none are left, remove
  `TOKEN_ENC_KEY_PREVIOUS`. Losing the key loses the data: back it up in the secret manager.

## Background jobs

`src/lib/jobs/` (three files plus `handlers.ts`, and the `job` table in migration `0002_background-jobs.sql`) is a small Postgres
queue with an in-process worker. No Redis, no scheduler, no extra service. Test: `test/jobs.integration.test.ts`.

```ts
// 1. Write a handler and register it (src/lib/jobs/handlers.ts). It must be idempotent: a job can run twice.
export const handlers: JobHandlers = {
  "fetch-link": async (job, { signal }) => {
    const link = await getLinkForJob(job.payload.linkId as string);   // re-read the row; skip if already done
    if (link.status === "ready") return;
    const page = await safeFetch(link.url, { maxBytes: 2_000_000, timeoutMs: 8_000 }); // pass `signal` to anything cancellable
    ...
    // throw new JobError("too_large", { permanent: true })  -> failed at once, no retries
    // throw new JobError("host_busy", { deferMs: 5_000 })   -> try again in 5 s without using an attempt
    // any other throw                                        -> retry with backoff
  },
};

// 2. Enqueue inside the transaction that saves the thing (after assertCan), then start it once that commits.
const { id, created } = await db().transaction(async (tx) => {
  // ...insert the link...
  return enqueue(tx, { kind: "fetch-link", key: link.id, ownerId: actor.id, payload: { linkId: link.id } });
});
after(() => kick()); // timer mode (Azure, Oracle): route handlers and server actions; runs the due jobs now
// Inline mode (Lambda, Cloud Run): there is no CPU after the response, so do it before responding:
// await kick({ budgetMs: 15_000, ids: [id] });

// 3. On every signed-in request (requireUser / requireUserOrRedirect, or middleware): at most one claim per 10 s per process.
nudge(); // returns false when throttled (and always in inline mode); never waits, never throws
// Inline mode drains old jobs the same way, inside the request and within its budget: await kick({ budgetMs: 5_000 });

// 4. Status for a chip or poll endpoint (the payload is never returned), and manual Retry for a failed job.
const status = await jobStatus(db(), { kind: "fetch-link", key: link.id, ownerId: actor.id });
// status.state: queued | retrying | running | done | failed; retryInSeconds, attempts, maxAttempts, lastError (a code)
await retryJob(db(), { kind: "fetch-link", key: link.id }, { ownerId: actor.id }); // "retried" | "not_found" | "already_active"
after(() => kick()); // or await kick({ budgetMs }) in inline mode
```

`instrumentation.ts` starts the worker (`startJobs()` in `src/lib/jobs/start.ts`) after `whenMigrated()` once `handlers` has an
entry, so a template with no handlers runs no timer. `JOBS_WORKER` picks the mode: `timer` (default), `inline` (also chosen
automatically when `AWS_LAMBDA_FUNCTION_NAME` is set), or `off` for tests and scripts, which turns the worker, `kick` and `nudge` off.

**Keys.** (`kind`, `key`) is unique across all users, so make `key` a globally unique value such as a row id (uuid). Never use
something two users can share, like a URL: the second user's `enqueue` would return the first user's job (`created: false`) and
the job would run once, for the first. If the same input must run per user, put the owner in the key.

**How it behaves**

- **Claiming.** One statement picks due rows with `for update skip locked`, marks them `running` and leases them for 60 s,
  so any number of instances can share the table and a job goes to exactly one of them; no transaction stays open while
  the handler runs. Each claim gets a fresh `lock_token`; `complete` and `fail` only apply to the current token, so a worker
  that was too slow (its lease was reclaimed) can't overwrite the new run.
- **Limits per process.** `concurrency` 2 jobs at once, each time-boxed to `timeoutMs` 25 s (its `signal` aborts; the timeout
  must stay shorter than the 60 s lease, which `createWorker` enforces, so no heartbeat is needed). The worker ticks every 10 s.
- **Retries.** A handler can `throw new JobError(code, { permanent?, deferMs? })`. Codes must match `[a-z0-9_]{1,40}` (anything else
  becomes `error`), so only safe strings reach the log and `last_error`. `deferMs` (clamped to 1 s to 1 h, at most 20 times per job,
  then an ordinary failure) retries without using an attempt. A failed attempt backs off 15 s, 1 min, 4 min; the 4th failure sets `failed` (`maxAttempts` per job, default 4),
  and the UI offers Retry. `run_after` is a floor, not a deadline: a retry that comes due while the app sleeps runs on the next wake.
- **Crashes.** A job whose process died stays `running` until its lease expires, then the next worker claims it again (an
  attempt is used). A job that expires on its last attempt becomes `failed` with `last_error = 'lease_expired'`, so a job
  that keeps killing the process can't loop forever or hold its key.
- **Idempotent enqueue.** One queued or running job per (`kind`, `key`); a second `enqueue` returns the first (`created: false`).
  A finished job doesn't block a new one. Without a `key` nothing is deduplicated.
- **Data.** `payload` is for ids and small parameters (4 KB cap, never personal data or secrets); `last_error` is a short
  code. The worker logs job id, kind, attempt, code and duration, never the payload, and handler errors are logged by name only
  (`JobError` codes are logged as codes). Finished rows are pruned hourly: `done` after 7 days, `failed` after 30.
- **Shutdown.** On SIGTERM a timer worker stops claiming; Next's standalone server exits without waiting, so in-flight jobs are
  reclaimed after the lease. Handlers must be idempotent for that reason.
- **Manual retry.** `retryJob` only retries the newest job for a key (`already_active` if a newer one is queued or running,
  `not_found` for a stale one, a foreign owner, or a malformed id). Call it with `db()` rather than inside a transaction you still need:
  in a true race it catches Postgres's unique violation and answers `already_active`, but that aborts the surrounding transaction.

### Background work per cloud

The worker is a timer inside the server process, so what it can do depends on whether the platform gives that process
CPU between requests.

| Cloud | Mode | What to do |
| --- | --- | --- |
| **Oracle** (long-lived container) | `timer`: the process is always up, so the worker is always on. | Enqueue, then `after(() => kick())`; `nudge()` on signed-in requests. |
| **Azure** Container Apps (scale to zero) | `timer`: the replica runs only while visitors use it and for its scale-in cooldown (about 5 min) after the last request. Nothing wakes it on a schedule, and the Build Tracker parks Azure apps and doesn't ping them. | Same as Oracle: `after(() => kick())` starts the job at once, `nudge()` drains the rest, and retries are sized for one visit plus the cooldown. A job saved just before the app sleeps finishes on the next visit; say so in the UI ("Finishes next time you open the app"). |
| **AWS Lambda** | `inline` (automatic): no timer, `nudge()` does nothing. Instances freeze after the response, so a timer would stall. | In the request that enqueued: `await kick({ budgetMs, ids: [id] })` before responding (default budget 15 s, under API Gateway's 29 s; each job's timeout is cut to what is left). Drain older jobs on later requests with `await kick({ budgetMs })`, again within budget. Anything left runs on a later request, or from an outside trigger (a queue or EventBridge) that calls `kick`. |
| **Google Cloud Run** | `inline` (`JOBS_WORKER=inline`), unless CPU is always allocated (`cpu_idle` off), which costs money. With request-based CPU, a background timer barely runs. | Same as Lambda. |

`kick({ budgetMs })` works in every mode. Inline mode claims nothing once the budget is spent, so the call returns within about
the budget; timer mode stops claiming and waiting at the budget while running jobs carry on.

## Checks

```bash
pnpm lint && pnpm typecheck && pnpm test   # unit tests
TEST_DATABASE_URL=postgres://... pnpm test # plus data-layer tests against real Postgres
pnpm build && pnpm smoke                   # end-to-end smoke test against a running app
```

CI runs all of these plus both container builds on every pull request.

## Deploy

Every push to `main` publishes a multi-arch image (x86 and ARM) to GitHub Container Registry as
`ghcr.io/breakthrudevelopment/<repo>:sha-<commit>`. [30-apps-infra](https://github.com/BreakthruDevelopment/30-apps-infra)
deploys those tags to AWS, Azure, Google Cloud and Oracle Cloud with Terraform; this repo holds no cloud credentials.

With `MIGRATE_ON_START=true` the server applies pending migrations before taking traffic, holding a Postgres
advisory lock so instances starting together can't race. `pnpm db:migrate` does the same by hand.

## Using the AI feature

| `AI_PROVIDER` | Behavior |
| --- | --- |
| `demo` (default) | Recorded answers from `src/lib/ai/demo.ts`; no key, no network |
| `gemini` | Google Gemini API (`GEMINI_API_KEY`, free tier) |
| `anthropic` | Claude (`ANTHROPIC_API_KEY`) |

With `AI_FALLBACK_TO_DEMO=true`, a quota error or outage serves the recorded answer and the UI says so.

### Images: `generate({ images })`

`generate()` takes an optional `images: { mimeType, data }[]` (base64 of the raw bytes, no `data:` prefix). Limits
(`input_rejected`, checked before any network call, in every mode): at most 4 images, 5 MB each decoded
(`MAX_IMAGE_BYTES`), 10 MB in total, MIME `image/jpeg`, `image/png`, `image/webp`, `image/heic` or `image/heif`, valid
base64. Gemini gets one `inlineData` part per image before the text part; Anthropic gets `image` blocks and rejects
HEIC/HEIF. `demo` answers from the task's fixture and ignores the images. Logs carry the image count and total bytes,
never the data. Treat text inside an image as data in your system prompt, exactly like user text.

### Embeddings: `embed()`

`embed({ task, texts, kind: "document" | "query" })` from `src/lib/ai` returns
`{ vectors, provider, model, dims, demo, latencyMs }`: 768-dim, L2-normalized vectors (fits pgvector's 2,000-dim
HNSW limit). Limits: 32 texts per call, 8,000 characters each, 64,000 in total (`input_rejected`).

- `gemini` calls `batchEmbedContents` with `AI_EMBED_MODEL` (default `gemini-embedding-2`, which takes the task in
  the text: `task: search result | query: …` / `title: none | text: …`; set `gemini-embedding-001` to use `taskType`).
  Changing the model changes the vector space: stored vectors must be re-embedded.
- `demo` (and a missing key, or a provider failure while `AI_FALLBACK_TO_DEMO=true`) uses deterministic hashed
  bag-of-words vectors, model `demo-hash-768`: lexical but meaningful, offline.
- `AI_PROVIDER=anthropic` has no embeddings API, so it embeds with Gemini if `GEMINI_API_KEY` is set, else demo.
- Always store `model` with each vector and only compare vectors with the same model; a demo fallback reports
  `demo: true` and the demo model name so vector spaces are never mixed.
- `AI_TIMEOUT_MS` (default 20000, max 22000) bounds every provider call, `generate()` and `embed()` alike.
- Logs carry task, provider, model, count and latency, never the text.
