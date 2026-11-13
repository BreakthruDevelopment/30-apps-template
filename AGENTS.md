<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Rules for every agent (Claude Code, Grok Build, Codex, Jules)

This repo is part of the **30 apps in 30 days** portfolio. The full playbook lives in
[BreakthruDevelopment/ai-dev-os](https://github.com/BreakthruDevelopment/ai-dev-os); these are the rules
that apply inside any app repo.

## Repo safety (non-negotiable)

The BreakthruDevelopment org holds other, unrelated applications.

- Touch only repos with the GitHub topic `30-apps-30-days`. Everything else is read-only.
- Never force-push, delete, rename, transfer or archive any repo or branch you didn't create for the current task.
- Never push to `main`. Open a PR from a branch named `<harness>/<short-task>` (e.g. `claude/items-api`, `grok/dashboard-ui`, `codex/fix-flaky-test`, `jules/gcp-terraform`).
- Pick up only issues labeled for your harness, and follow the role file named in the issue title (`ai-dev-os/roles/`).
- Never commit secrets. `.env.local` is ignored; real values live in each cloud's secret manager.

## Stack

- Next.js (App Router, `src/app`), TypeScript strict, Tailwind with the tokens in `globals.css`.
- Postgres via Drizzle (`src/lib/db/schema.ts`). Change the schema, then `pnpm db:generate --name <change>`; commit the SQL in `drizzle/`.
- Auth via Better Auth (`src/lib/auth`). Roles: `user`, `admin`.
- All model calls go through `generate()` in `src/lib/ai`. Never call a model API directly.

## How code must be written

- **Authorize on the server, every time.** Pages call `requireUserOrRedirect()` / `requireRoleOrRedirect()`; route handlers and server actions call `requireUser()` / `requireRole()`. Data functions take the acting user and call `assertCan()`.
- **Validate all input with zod** at the boundary (route handler, server action, data function). Free text goes through `text()` in `src/lib/text.ts`, which trims, caps the length and rejects NUL bytes (`\0`): Postgres can't store them, so they would otherwise be a 500.
- **AI features:** define a zod output schema, add a demo fixture in `src/lib/ai/demo.ts` for the task, treat user content in prompts as data (say so in the system prompt), and cap input size.
- **Errors:** route handlers return `errorResponse(err)`; never send stack traces to clients.
- **Logs:** use `log` from `src/lib/log.ts` (JSON lines). Never log secrets, tokens, passwords or full prompts with personal data.
- **Responsive:** every page must work at 375px wide.

## Builder checklist (what reviews of apps 5-12 kept finding)

- [ ] **Retries are idempotent.** A mutation a user can double-tap or retry carries a client op id (`opFor` in `src/lib/client-op.ts`, kept in a ref until the server answers ok or conflict) and the server enforces it with a unique index, as `createItem` does.
- [ ] **Async buttons reset in `finally`** and show an error: use `useAsyncAction` / `runAsyncAction`. A thrown action must never leave a button disabled or silent.
- [ ] **375px check with a long unbroken string** (60+ characters, no spaces) in every user-text field; `break-words` and `min-w-0` where it overflows.
- [ ] **NUL bytes are rejected** at the boundary (`text()`; `jsonHasNul` for JSON payloads), with a 400 and a test.
- [ ] **Public routes have a per-IP limit** (`allowPublicRequest(clientIp(request))` in `src/lib/ip-limit.ts`); signed-in routes use the per-user limits in `usage.ts`. Read the `X-Forwarded-For` note in `ip-limit.ts` for your cloud.
- [ ] **Structured AI output is checked on the server**: the zod schema parses the model's answer, and any ids or references in it are verified against the database before use.
- [ ] **Smoke runs back-to-back after seeding.** Sign-ups in `scripts/smoke.sh` go through `post_auth`, which waits out Better Auth's 429 and retries once.
- [ ] **Jobs:** register handlers (and `onGiveUp` for anything the user must see fail) in `src/lib/jobs/handlers.ts`; on Cloud Run (`K_SERVICE`) and Lambda jobs run inline inside `kick()`. Fetch user URLs only with `safeFetch`.

## Definition of done (CI enforces most of it)

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build` and `pnpm smoke` all pass; new data rules have a test in
`test/*.integration.test.ts`; the README's "What this app does" section is filled in.
