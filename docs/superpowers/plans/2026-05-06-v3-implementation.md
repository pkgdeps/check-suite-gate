# automerge-gate v3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace v2's main-gate / fork-gate 2-job mutex with a single-job pattern by splitting the action into `gate-private.ts` and `gate-public.ts`, fed by a thin `index.ts` dispatcher and dependency-injected runtime context. Integration tests use **msw** to fake the GitHub HTTP API (avoids the v2-style "mock-soup" of `vi.fn()` over individual octokit methods).

**Architecture:** `index.ts` parses inputs, builds a `RunDeps` object (octokit + ctx + env) from `@actions/github` and `process.env`, then dispatches to either `runPrivate` (Checks API write, skip when no merge intent) or `runPublic` (always poll, JOB exit code is the gate). Both `run*` functions take `RunDeps` as a parameter so tests can pass a real octokit pointed at an msw-faked server.

**Tech Stack:** TypeScript (Node 24), `@actions/core`, `@actions/github`, vitest, **msw v2** (new dep), esbuild.

**Reference spec:** [`docs/superpowers/specs/2026-05-06-v3-single-job-design.md`](../specs/2026-05-06-v3-single-job-design.md) (commit `9fc66a7`)

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `src/run-deps.ts` | create | `RunDeps`, `RunContext`, `RunEnv` types |
| `src/index.ts` | rewrite | Thin dispatcher: parseInputs → build RunDeps → call runPrivate or runPublic |
| `src/gate-private.ts` | create | `runPrivate(deps, inputs)` — Checks API write, skip path |
| `src/gate-public.ts` | create | `runPublic(deps, inputs)` — always-poll, exit-code gate |
| `src/inputs.ts` | modify | Rename `gate` → `gateMode`, hard break |
| `src/mode.ts` | modify | Drop `'pending'` from `ActionMode` |
| `src/check-run.ts`, `review-status.ts` | unchanged | Used only by `gate-private.ts` |
| `src/api.ts`, `polling.ts`, `aggregator.ts`, `conclusion.ts`, `filter.ts`, `self-exclusion.ts` | unchanged | Shared utilities |
| `__tests__/_msw/server.ts` | create | msw setup + reusable handler factories |
| `__tests__/inputs.test.ts` | modify | Update for `gateMode` rename |
| `__tests__/mode.test.ts` | modify | Drop pending tests |
| `__tests__/gate-private.test.ts` | create | Integration tests over msw fakes |
| `__tests__/gate-public.test.ts` | create | Integration tests over msw fakes |
| `.github/workflows/test-self.yml` | modify | Single-job pattern (private mode) |
| `action.yml` | modify | Drop `gate`, add `gate-mode` |
| `README.md` | rewrite | Two example workflows + diff table |
| `docs/MIGRATION.md` | create | v2 → v3 step-by-step |
| `docs/lessons/2026-05-06-check-run-pending-state-mapping.md` | modify | Append §5 noting v3 supersedes the v2.1.0 hotfix |
| `dist/index.js` | rebuild | esbuild output |

---

## Task 1: Setup — msw, RunDeps, branch

- [ ] **Install msw and create branch**

```bash
git checkout -b feature/v3-single-job
ni add -D msw
```

- [ ] **Create `src/run-deps.ts`**

```typescript
import type { OctokitLike } from './api.js'
import type { ReviewState } from './mode.js'

export type RunContext = {
  eventName: string
  action: string
  pr: {
    number: number
    head: { sha: string }
    auto_merge: { enabled_by: { login: string } } | null
  }
  reviewState: ReviewState | null
  before: string | undefined
  owner: string
  repo: string
}

export type RunEnv = {
  runId: number
  runAttempt: number
  serverUrl: string
  repository: string
  workflowRef: string | undefined
}

export type RunDeps = {
  octokit: OctokitLike
  context: RunContext
  env: RunEnv
}
```

- [ ] **Create `__tests__/_msw/server.ts` with msw setup + handler factories**

```typescript
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

const BASE = 'https://api.github.com'

// Default handlers: empty results everywhere — tests override per-case.
export const defaultHandlers = [
  http.get(`${BASE}/repos/:owner/:repo/commits/:sha/check-suites`, () =>
    HttpResponse.json({ check_suites: [] })
  ),
  http.get(`${BASE}/repos/:owner/:repo/check-suites/:id/check-runs`, () =>
    HttpResponse.json({ check_runs: [] })
  ),
  http.get(`${BASE}/repos/:owner/:repo/commits/:sha/check-runs`, () =>
    HttpResponse.json({ check_runs: [] })
  ),
  http.post(`${BASE}/repos/:owner/:repo/check-runs`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    return HttpResponse.json({
      ...body,
      id: 999,
      check_suite: { id: 1 },
      html_url: 'https://example.com'
    })
  }),
  http.patch(`${BASE}/repos/:owner/:repo/check-runs/:id`, ({ params }) =>
    HttpResponse.json({ id: Number(params.id) })
  ),
  http.get(`${BASE}/repos/:owner/:repo/pulls/:n/reviews`, () =>
    HttpResponse.json([])
  ),
  http.get(
    `${BASE}/repos/:owner/:repo/collaborators/:u/permission`,
    ({ params }) =>
      HttpResponse.json({
        permission: 'read',
        role_name: 'read',
        user: { login: params.u as string }
      })
  ),
  http.get(`${BASE}/repos/:owner/:repo/actions/runs/:id`, () =>
    HttpResponse.json({ path: '.github/workflows/other.yml' })
  )
]

export const server = setupServer(...defaultHandlers)
```

- [ ] **Add `vitest.config.ts` setup file pointing to a global before/after**

If a `setupFiles` entry is needed, add `__tests__/_msw/setup.ts`:

```typescript
import { afterAll, afterEach, beforeAll } from 'vitest'
import { server } from './server.js'

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

…and reference it from `vitest.config.ts`:

```typescript
test: { setupFiles: ['__tests__/_msw/setup.ts'] }
```

- [ ] **Verify install + typecheck + commit**

```bash
npm run typecheck
git add package.json package-lock.json src/run-deps.ts __tests__/_msw vitest.config.ts
git commit -m "chore: setup msw + RunDeps types for v3 implementation"
```

---

## Task 2: Rename `inputs.gate` → `inputs.gateMode`

**Files:** `src/inputs.ts`, `__tests__/inputs.test.ts`

- [ ] **Update `src/inputs.ts`**

```typescript
export type RawInputs = {
  context: string
  ignoreApps: string
  ignoreChecks: string
  gateMode: string
  token: string
  pollIntervalSeconds: string
}

export type GateMode = 'private' | 'public'

export type ParsedInputs = {
  context: string
  ignoreApps: string[]
  ignoreChecks: string[]
  gateMode: GateMode
  token: string
  pollIntervalSeconds: number
}

const parseGateMode = (raw: string): GateMode => {
  if (raw === 'private' || raw === 'public') return raw
  throw new Error(
    `input \`gate-mode\` must be "private" or "public" (got: "${raw}"). ` +
      `If migrating from v2: gate: main → gate-mode: private, gate: fork → gate-mode: public.`
  )
}
// parseInputs body: replace `mode: parseMode(raw.mode)` with `gateMode: parseGateMode(raw.gateMode)`
```

- [ ] **Update `__tests__/inputs.test.ts`**

Change the `raw()` helper key `gate` → `gateMode`, replace the gate tests with private/public assertions and rejection of legacy `'main'` / `'fork'`.

- [ ] **Run, fix, commit**

```bash
npm test __tests__/inputs.test.ts
git add src/inputs.ts __tests__/inputs.test.ts
git commit -m "feat!: rename inputs.gate → inputs.gateMode (private/public, hard break)"
```

---

## Task 3: Drop `'pending'` from ActionMode

**Files:** `src/mode.ts`, `__tests__/mode.test.ts`

- [ ] **Update `src/mode.ts`**

```typescript
export type ActionMode = 'polling' | 'skip'   // ← 'pending' removed
```

In `determineMode`'s `isHeadShaEvent` branch, replace the trailing `pending` return with `skip`:

```typescript
return {
  mode: 'skip',
  reason: `new HEAD landed (action=${action}); no merge intent (auto-merge off, no active Approve)`
}
```

- [ ] **Update `__tests__/mode.test.ts`**

Replace tests that asserted `mode: 'pending'` with `mode: 'skip'` and updated reasons. Remove the input helper's notion of pending.

- [ ] **Run, commit**

```bash
npm test __tests__/mode.test.ts
git add src/mode.ts __tests__/mode.test.ts
git commit -m "feat!: ActionMode is polling|skip only (drop pending)"
```

---

## Task 4: Extract `runPrivate` into `src/gate-private.ts`

**Files:** create `src/gate-private.ts`

- [ ] **Move the current `run()` body (private-only logic) from `src/index.ts` to a new exported `runPrivate(deps, inputs)`** in `src/gate-private.ts`. Use `deps.octokit`, `deps.context`, `deps.env` instead of `github.context` + `process.env` directly.

Key adjustments versus the v2.1.0 `index.ts`:

- Read `pr`, `eventName`, `action`, `reviewState`, `before`, `owner`, `repo` from `deps.context`.
- Read `runId`, `runAttempt`, `serverUrl`, `repository`, `workflowRef` from `deps.env`.
- `inputs.gate === 'main'` checks become unconditional in private (this file *is* the private path).
- `mode === 'pending'` block: gone (Task 3).
- `mode === 'skip'`: log and return early without writing any check_run.
- After `pollUntilComplete`, write the verdict via `writeCheckRun` using `inputs.context` as the name.

`buildPollingOutput` (the markdown table builder) moves into this file.

- [ ] **Update `src/index.ts` temporarily to call `runPrivate`** so the package still typechecks after the extraction. The full dispatcher rewrite happens in Task 7.

```typescript
// Provisional — Task 7 will replace this body entirely.
// const deps: RunDeps = { ... build from github.context + process.env ... }
// await runPrivate(deps, inputs)
```

- [ ] **Run typecheck + lint + tests, commit**

```bash
npm run typecheck && npm run lint && npm test
git add src/gate-private.ts src/index.ts
git commit -m "feat: extract runPrivate into src/gate-private.ts (DI via RunDeps)"
```

---

## Task 5: Create `runPublic` in `src/gate-public.ts`

**Files:** create `src/gate-public.ts`

- [ ] **Implement `runPublic(deps, inputs)`** — always polls, no skip path, no API write of the aggregate, no markCheckRunStale, no hasActiveApproval. The function signature mirrors `runPrivate`. The gate signal is the action's exit code:

```typescript
import * as core from '@actions/core'
import { applyFilters } from './filter.js'
import { fetchAllCheckRuns, createWorkflowPathLookup } from './api.js'
import {
  excludeOwnWorkflowRuns,
  parseCurrentWorkflowPath
} from './self-exclusion.js'
import { pollUntilComplete } from './polling.js'
import type { RunDeps } from './run-deps.js'
import type { ParsedInputs } from './inputs.js'

export const runPublic = async (
  deps: RunDeps,
  inputs: ParsedInputs
): Promise<void> => {
  const { octokit, context, env } = deps
  const sha = context.pr.head.sha

  let lastTotal = 0
  let lastEvaluated = 0
  let lastCompleted = 0

  const currentWorkflowPath = parseCurrentWorkflowPath(env.workflowRef)
  const lookupWorkflowPath = createWorkflowPathLookup(
    octokit,
    context.owner,
    context.repo
  )
  const fetchRuns = async () => {
    const all = await fetchAllCheckRuns(
      octokit,
      context.owner,
      context.repo,
      sha
    )
    lastTotal = all.length
    const filtered = applyFilters(
      all,
      inputs.ignoreApps,
      inputs.ignoreChecks
    )
    const afterSelf = await excludeOwnWorkflowRuns(
      filtered,
      currentWorkflowPath,
      lookupWorkflowPath
    )
    lastEvaluated = afterSelf.length
    lastCompleted = afterSelf.filter((r) => r.status === 'completed').length
    return afterSelf
  }

  core.startGroup('Polling')
  const result = await pollUntilComplete(fetchRuns, {
    intervalSeconds: inputs.pollIntervalSeconds,
    onIteration: (s) =>
      core.info(
        `Poll #${s.iteration}: state=${s.state}, ${s.completed}/${s.total} completed`
      )
  })
  core.endGroup()

  core.setOutput('state', result.state)
  core.setOutput('total-checks', String(lastTotal))
  core.setOutput('evaluated-checks', String(lastEvaluated))
  core.setOutput('completed-checks', String(lastCompleted))
  core.setOutput('polled-iterations', String(result.iterations))

  if (result.state === 'failure') {
    core.setFailed(
      `aggregated state is failure (${lastEvaluated} checks evaluated)`
    )
  } else if (result.state === 'pending') {
    core.setFailed('polling exited with pending state — unexpected')
  }
}
```

- [ ] **Commit**

```bash
git add src/gate-public.ts
git commit -m "feat: add runPublic (gate-mode: public, always poll, exit-code gate)"
```

---

## Task 6: Integration tests with msw

**Files:** create `__tests__/gate-private.test.ts`, `__tests__/gate-public.test.ts`

- [ ] **Write `gate-private.test.ts`**: build a real `octokit = github.getOctokit('tok')` instance, build a `RunDeps` literal, call `runPrivate`, verify outcomes by inspecting which msw handlers fired and via spies on a few well-chosen handlers (e.g. capturing the body of POST `/check-runs` to assert the conclusion).

Test cases (one `it` per case):
1. `synchronize` without merge intent → no POST to `/check-runs`, no PATCH.
2. `auto_merge_enabled` with empty check list → POST to `/check-runs` with `conclusion: success`.
3. `synchronize` with `before` SHA + auto-merge already on + a matching pre-existing check_run on the before SHA → PATCH to `/check-runs/:id` with `conclusion: cancelled` AND a fresh POST for the new SHA.
4. `pull_request_review.submitted approved` from a write-permission user → POST to `/check-runs` (with msw configured to return a write permission for the user).
5. drive-by Approve (`permission: read`) → no POST.

Use msw's `server.use(...)` per test to override the default handlers.

- [ ] **Write `gate-public.test.ts`**: similar, but with simpler assertions:
1. Any event → polling runs (verified via `setupServer` request log on the suites endpoint), no POST/PATCH to `/check-runs`.
2. Empty check list → polling exits success (action exits 0; verify `core.setFailed` was not called via `vi.spyOn`).
3. Failing aggregate (msw returns a check_run with `conclusion: failure`) → `core.setFailed` is called.

- [ ] **Run, commit**

```bash
npm test __tests__/gate-private.test.ts __tests__/gate-public.test.ts
git add __tests__/gate-private.test.ts __tests__/gate-public.test.ts
git commit -m "test: integration tests for runPrivate/runPublic via msw fakes"
```

---

## Task 7: Rewrite `src/index.ts` as a dispatcher

**Files:** `src/index.ts`

- [ ] **Replace the file's body** with input parsing, building `RunDeps` from `@actions/github` + `process.env`, and dispatching by `inputs.gateMode`:

```typescript
import * as core from '@actions/core'
import * as github from '@actions/github'
import { parseInputs } from './inputs.js'
import type { OctokitLike } from './api.js'
import { runPrivate } from './gate-private.js'
import { runPublic } from './gate-public.js'
import { parseReviewState } from './mode.js'
import type { RunContext, RunDeps, RunEnv } from './run-deps.js'

const SUPPORTED_EVENTS = ['pull_request', 'pull_request_review'] as const

const buildContext = (): RunContext | null => {
  const ctx = github.context
  if (!(SUPPORTED_EVENTS as readonly string[]).includes(ctx.eventName)) {
    core.warning(
      `automerge-gate only handles pull_request / pull_request_review events; got "${ctx.eventName}". Skipping.`
    )
    return null
  }
  const action = (ctx.payload as { action?: string }).action ?? ''
  const pr = ctx.payload.pull_request as RunContext['pr'] | undefined
  if (pr === undefined) {
    core.setFailed('pull_request payload is missing')
    return null
  }
  const reviewState =
    ctx.eventName === 'pull_request_review'
      ? parseReviewState(
          (ctx.payload as { review?: { state?: string } }).review?.state
        )
      : null
  const before = (ctx.payload as { before?: string }).before
  return {
    eventName: ctx.eventName,
    action,
    pr,
    reviewState,
    before,
    owner: ctx.repo.owner,
    repo: ctx.repo.repo
  }
}

const buildEnv = (): RunEnv => ({
  runId: Number.parseInt(process.env.GITHUB_RUN_ID ?? '0', 10),
  runAttempt: Number.parseInt(process.env.GITHUB_RUN_ATTEMPT ?? '1', 10),
  serverUrl: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
  repository:
    process.env.GITHUB_REPOSITORY ??
    `${github.context.repo.owner}/${github.context.repo.repo}`,
  workflowRef: process.env.GITHUB_WORKFLOW_REF
})

const run = async (): Promise<void> => {
  const inputs = parseInputs({
    context: core.getInput('context'),
    ignoreApps: core.getInput('ignore-apps'),
    ignoreChecks: core.getInput('ignore-checks'),
    gateMode: core.getInput('gate-mode'),
    token: core.getInput('token'),
    pollIntervalSeconds: core.getInput('poll-interval-seconds')
  })

  const context = buildContext()
  if (context === null) return
  const env = buildEnv()

  const octokit = github.getOctokit(inputs.token) as unknown as OctokitLike
  const deps: RunDeps = { octokit, context, env }

  if (inputs.gateMode === 'private') {
    await runPrivate(deps, inputs)
  } else {
    await runPublic(deps, inputs)
  }
}

run().catch((err: unknown) => {
  if (err instanceof Error) {
    core.setFailed(err.message)
  } else {
    core.setFailed(String(err))
  }
})
```

- [ ] **Run all tests + lint + typecheck + build**

```bash
npm run all
```

- [ ] **Commit**

```bash
git add src/index.ts
git commit -m "refactor!: src/index.ts is a thin dispatcher to runPrivate/runPublic"
```

---

## Task 8: Update workflow + `action.yml`

**Files:** `.github/workflows/test-self.yml`, `action.yml`

- [ ] **Replace `.github/workflows/test-self.yml`** with the v3 single-job pattern (private mode), per the spec's Configuration A:

```yaml
name: test-self

on:
  pull_request:
    types: [opened, synchronize, reopened, auto_merge_enabled]
  pull_request_review:
    types: [submitted]

permissions:
  checks: write
  pull-requests: read
  actions: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  gate:
    if: >-
      github.event_name != 'pull_request_review'
      || github.event.review.state == 'approved'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
        with:
          persist-credentials: false
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version-file: .node-version
      - run: npm ci
      - run: npm run build
      - name: Self-host gate
        uses: ./
        with:
          gate-mode: 'private'
          context: 'automerge-gate/self-test'
          ignore-checks: 'automerge-gate/self-test'
```

- [ ] **Replace `action.yml`** to drop the `gate` input and add `gate-mode`:

```yaml
name: automerge-gate
description: |
  Polls check_run results for a PR and reports the aggregate as either an
  action-written check_run (gate-mode: private) or the gate job's own
  check_run conclusion (gate-mode: public). Single-job pattern; no race.
author: azu

branding:
  icon: check-circle
  color: green

inputs:
  gate-mode:
    description: 'Gate variant. "private" = cost-optimized for repos with no external fork PRs (action writes the aggregated check_run via the Checks API). "public" = simpler model for fork-accepting repos (the gate signal is the JOB exit code; the job name must match the required-check context).'
    required: true
  context:
    description: 'Aggregated check_run name (gate-mode: private only). Must match the required check in your ruleset. Ignored when gate-mode: public — the job name is the signal.'
    required: false
    default: 'automerge-gate/all-passed'
  poll-interval-seconds:
    description: 'How often (seconds) to re-fetch check status during the polling loop'
    required: false
    default: '30'
  ignore-apps:
    description: 'GitHub App slugs whose check_runs are excluded. Comma-separated or newline-separated.'
    required: false
    default: ''
  ignore-checks:
    description: 'check_run name patterns to exclude. Glob (* / ?) supported. Comma-separated or newline-separated.'
    required: false
    default: ''
  token:
    description: 'GitHub token used to read checks and (when permitted) write the aggregated check_run'
    required: false
    default: ${{ github.token }}

outputs:
  state:
    description: 'Final state: success, failure, or skipped'
  total-checks:
    description: 'Number of check_runs observed before filtering'
  evaluated-checks:
    description: 'Number of check_runs after filtering'
  completed-checks:
    description: 'Number of completed check_runs after filtering'
  polled-iterations:
    description: 'Number of polling iterations performed'

runs:
  using: 'node24'
  main: 'dist/index.js'
```

- [ ] **Commit**

```bash
git add .github/workflows/test-self.yml action.yml
git commit -m "feat!: workflow + action.yml on v3 single-job pattern"
```

---

## Task 9: Docs

**Files:** `README.md`, `docs/MIGRATION.md`, `docs/lessons/2026-05-06-check-run-pending-state-mapping.md`

- [ ] **Rewrite the Usage section of `README.md`** with the two-example structure from the spec (Configuration A: private, Configuration B: public). Include the diff-table summarising the two configs. Drop the v2 mutex example and the "Why two jobs" explanation. Add a link to MIGRATION.md.

- [ ] **Update the Inputs table** in `README.md`: drop `mode`, add `gate-mode` row. Note that `context` is private-only.

- [ ] **Create `docs/MIGRATION.md`** with the v2 → v3 step-by-step (separate "if you used main-gate" / "if you used fork-gate" branches), input mapping table, and a section on the behaviour differences (no more pending check_run write, no more main/fork race, Approve sticky private-only).

- [ ] **Append §5 to `docs/lessons/2026-05-06-check-run-pending-state-mapping.md`** noting that the v2.1.0 hotfix in §4 is superseded by v3's structural fix; link to the spec.

- [ ] **Commit**

```bash
git add README.md docs/MIGRATION.md docs/lessons/2026-05-06-check-run-pending-state-mapping.md
git commit -m "docs!: README v3 examples + MIGRATION.md + lessons §5"
```

---

## Task 10: Build + push + draft PR

**Files:** `dist/index.js`

- [ ] **Run the full pipeline**

```bash
npm run all
```

Expected: lint, typecheck, all tests pass, dist rebuilt.

- [ ] **Commit dist**

```bash
git add dist/index.js
git commit -m "chore(dist): rebuild for v3"
```

- [ ] **Push and open draft PR**

```bash
git push -u origin feature/v3-single-job
gh pr create --draft --title "feat!: v3 single-job pattern (private/public configs)" --body "$(cat <<'EOF'
## Summary

Implements [`docs/superpowers/specs/2026-05-06-v3-single-job-design.md`](docs/superpowers/specs/2026-05-06-v3-single-job-design.md).

- Drop v2 main-gate / fork-gate 2-job mutex → single-job pattern (race-free)
- Two README example configs: private (cost-optimized) + public (fork-aware)
- input rename: \`gate: main | fork\` → \`gate-mode: 'private' | 'public'\` (hard break)
- pending mode廃止 (Option B: don't write check_run when no merge intent)
- Code split: \`src/gate-private.ts\` + \`src/gate-public.ts\` + thin \`src/index.ts\` dispatcher
- Black-box-testable via injected \`RunDeps\` over msw HTTP fakes (no octokit method mocks)

## Migration

See [\`docs/MIGRATION.md\`](docs/MIGRATION.md).

## Test plan

- [ ] \`npm run all\` passes (lint / typecheck / tests / build)
- [ ] self-test workflow runs successfully on this PR (smoke test for private mode)
- [ ] Manual smoke test in a separate test repo for public mode after merge
EOF
)"
```

---

## Self-Review Notes

**Spec coverage:** every spec section maps to at least one task — single-job pattern (Tasks 4, 5), two README examples (Task 9), input rename (Task 2), pending廃止 (Task 3), Approve sticky private-only (Task 4 inherits v2.1.0 behaviour, public skips it per Task 5), file split (Tasks 4, 5, 7), DI via RunDeps (Task 1, used everywhere downstream), migration guide (Task 9).

**Placeholder scan:** none.

**Type consistency:** `RunDeps`, `RunContext`, `RunEnv`, `GateMode`, `ParsedInputs` referenced consistently across Tasks 1, 2, 4, 5, 7. `OctokitLike` unchanged.

**Ordering:** inputs renamed (Task 2) and mode simplified (Task 3) BEFORE extracting (Tasks 4, 5) so the extracted code uses the new types immediately. Dispatcher rewrite (Task 7) AFTER both halves exist. Tests (Task 6) AFTER both halves implemented but BEFORE the final dispatch wiring is shipped.
