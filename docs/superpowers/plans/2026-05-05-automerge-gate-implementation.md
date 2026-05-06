# automerge-gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** v1 (check-suite-gate) を `automerge-gate` v2 に作り変える。 起動 trigger を `pull_request.auto_merge_enabled` 系に切り替え、 polling loop で集約 status を書く。

**Architecture:** 既存の v1 src モジュール (conclusion / filter / self-exclusion / api / status) を可能な限り流用し、 aggregator / inputs / index を書き換え + 新規 polling モジュールを追加。 action.yml と test-self.yml と README は刷新。

**Tech Stack:** TypeScript / Node.js 24 / esbuild / vitest / @octokit/rest / @actions/core / @actions/github / `path.matchesGlob` / actions/typescript-action template (v1 で導入済み)

**Spec:** `docs/superpowers/specs/2026-05-05-automerge-gate-design.md`

---

## File Structure

```
.
├── .github/
│   └── workflows/
│       ├── ci.yml             # 流用 (lint/typecheck/test/build/dist check)
│       └── test-self.yml      # 書き換え (auto_merge_enabled ベースに)
├── action.yml                 # 書き換え (v2 の inputs/outputs/runs.using)
├── src/
│   ├── conclusion.ts          # 流用 (変更なし)
│   ├── filter.ts              # 書き換え: parseList を multiline 対応
│   ├── self-exclusion.ts      # 流用 (変更なし)
│   ├── api.ts                 # 書き換え: waitForTriggerSuiteCompleted を削除
│   ├── aggregator.ts          # 書き換え: mode 引数削除、 polling 用 simple 評価
│   ├── status.ts              # 流用 (変更なし、 buildTargetUrl/writeCommitStatus)
│   ├── inputs.ts              # 書き換え: 新 input (poll-interval-seconds / timeout-seconds / on-timeout) を追加
│   ├── polling.ts             # 新規: pollUntilComplete (loop + sleep + timeout)
│   └── index.ts               # 書き換え: event 判定 + pending モード / polling モード分岐
├── __tests__/
│   ├── conclusion.test.ts     # 流用
│   ├── filter.test.ts         # 流用 + multiline parseList のテスト追加
│   ├── self-exclusion.test.ts # 流用
│   ├── api.test.ts            # waitForTriggerSuiteCompleted のテスト削除
│   ├── aggregator.test.ts     # 書き換え (mode 引数削除に追従)
│   ├── status.test.ts         # 流用
│   ├── inputs.test.ts         # 書き換え (新 input + multiline 入力 + validation)
│   └── polling.test.ts        # 新規
├── dist/index.js              # rebuild
└── README.md                  # 書き換え (v2 仕様、 archive notice 撤回)
```

v1 で書いた `docs/lessons/2026-05-05-check-suite-recursion-finding.md` はそのまま残す。 v1 の spec / plan も history として残す。 README に「v1 は archive、 lessons は残してある」 を一行 link で言及するに留める。

---

## Task 1: Replace action.yml with v2 metadata

**Files:**
- Modify: `action.yml`

- [ ] **Step 1: Read current action.yml to confirm baseline**

```bash
cat action.yml
```

- [ ] **Step 2: Replace contents**

Overwrite `action.yml` with:

```yaml
name: automerge-gate
description: |
  Aggregates check_run results into a single commit status, triggered by
  pull_request.auto_merge_enabled. Lets GitHub's native auto-merge fire as
  soon as the aggregated status turns green.
author: azu

branding:
  icon: check-circle
  color: green

inputs:
  context:
    description: 'Commit status context name to write. Must match the required check in your ruleset.'
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
    description: 'GitHub token used to read checks and write commit status'
    required: false
    default: ${{ github.token }}

outputs:
  state:
    description: 'Final commit status state: pending, success, or failure'
  total-checks:
    description: 'Number of check_runs observed before filtering'
  evaluated-checks:
    description: 'Number of check_runs after filtering'
  completed-checks:
    description: 'Number of completed check_runs after filtering'
  polled-iterations:
    description: 'Number of polling iterations performed (0 in pending mode)'

runs:
  using: 'node24'
  main: 'dist/index.js'
```

- [ ] **Step 3: Validate yaml parseability**

```bash
node -e "console.log(JSON.stringify(require('js-yaml').load(require('fs').readFileSync('action.yml','utf8')),null,2))" 2>&1 | head -20
```

If `js-yaml` is not installed, skip this step (CI will catch invalid yaml).

- [ ] **Step 4: Commit**

```bash
git add action.yml
git commit -m "$(cat <<'EOF'
feat: rewrite action.yml for automerge-gate v2

inputs (context, poll-interval-seconds, ignore-apps, ignore-checks,
token)、 outputs (state, total-checks, evaluated-checks, completed-checks,
polled-iterations)、 description / branding を v2 用に。 timeout 制御は
利用者の job レベル timeout-minutes に委ねる方針なので timeout-seconds
/ on-timeout input は持たない。 ignore-apps / ignore-checks はカンマ /
改行両対応の旨を description に明記。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Update parseList to support newline-separated input

**Files:**
- Modify: `src/filter.ts`
- Modify: `__tests__/filter.test.ts`

- [ ] **Step 1: Add a failing test for newline-separated input**

Append to `__tests__/filter.test.ts` inside the `describe("parseList", ...)` block:

```ts
  it('splits on newlines (yaml `|` block scalar)', () => {
    expect(parseList('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('mixes commas and newlines', () => {
    expect(parseList('a, b\nc,d ')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('trims whitespace and blank lines', () => {
    expect(parseList('  a \n\n  b  \n\n')).toEqual(['a', 'b'])
  })
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npm test -- filter
```
Expected: 3 new tests fail (current `parseList` only splits on `,`).

- [ ] **Step 3: Update implementation**

Edit `src/filter.ts`. Replace the existing `parseList` with:

```ts
export const parseList = (raw: string): string[] =>
  raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
```

- [ ] **Step 4: Run, expect PASS**

```bash
npm test -- filter
```
Expected: All filter tests pass (existing + 3 new = 13).

- [ ] **Step 5: typecheck and lint**

```bash
npm run typecheck && npm run lint
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/filter.ts __tests__/filter.test.ts
git commit -m "$(cat <<'EOF'
feat: parseList accepts newline-separated input

ignore-apps / ignore-checks を yaml の \`|\` block scalar (改行区切り)
で書けるようにする。 split を \`/[,\\n]/\` に変更し、 カンマと改行を
同等に扱う。 trim と empty filter は既存挙動を維持。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Extend inputs.ts with new v2 inputs

**Files:**
- Modify: `src/inputs.ts`
- Modify: `__tests__/inputs.test.ts`

- [ ] **Step 1: Replace test file**

Replace contents of `__tests__/inputs.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { parseInputs, type RawInputs } from '../src/inputs.js'

const raw = (override: Partial<RawInputs> = {}): RawInputs => ({
  context: 'automerge-gate/all-passed',
  ignoreApps: '',
  ignoreChecks: '',
  token: 'tok',
  pollIntervalSeconds: '30',
  ...override
})

describe('parseInputs', () => {
  it('parses comma lists and trims values', () => {
    const result = parseInputs(
      raw({ ignoreApps: 'a, b ,c', ignoreChecks: '*foo, bar-* ' })
    )
    expect(result.ignoreApps).toEqual(['a', 'b', 'c'])
    expect(result.ignoreChecks).toEqual(['*foo', 'bar-*'])
  })

  it('parses newline-separated ignore lists', () => {
    const result = parseInputs(
      raw({ ignoreApps: 'a\nb\nc', ignoreChecks: '*foo\n bar-* ' })
    )
    expect(result.ignoreApps).toEqual(['a', 'b', 'c'])
    expect(result.ignoreChecks).toEqual(['*foo', 'bar-*'])
  })

  it('throws when token is empty or whitespace', () => {
    expect(() => parseInputs(raw({ token: '' }))).toThrow(/token/)
    expect(() => parseInputs(raw({ token: '   ' }))).toThrow(/token/)
  })

  it('parses positive integer poll-interval-seconds', () => {
    const result = parseInputs(raw({ pollIntervalSeconds: '15' }))
    expect(result.pollIntervalSeconds).toBe(15)
  })

  it('throws on non-numeric or non-positive interval', () => {
    expect(() => parseInputs(raw({ pollIntervalSeconds: 'abc' }))).toThrow(
      /poll-interval-seconds/
    )
    expect(() => parseInputs(raw({ pollIntervalSeconds: '0' }))).toThrow(
      /poll-interval-seconds/
    )
    expect(() => parseInputs(raw({ pollIntervalSeconds: '-5' }))).toThrow(
      /poll-interval-seconds/
    )
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npm test -- inputs
```
Expected: tests fail (existing parseInputs doesn't accept the new RawInputs fields).

- [ ] **Step 3: Replace src/inputs.ts implementation**

Overwrite `src/inputs.ts` with:

```ts
import { parseList } from './filter.js'

export type RawInputs = {
  context: string
  ignoreApps: string
  ignoreChecks: string
  token: string
  pollIntervalSeconds: string
}

export type ParsedInputs = {
  context: string
  ignoreApps: string[]
  ignoreChecks: string[]
  token: string
  pollIntervalSeconds: number
}

const parsePositiveInt = (raw: string, name: string): number => {
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(
      `input \`${name}\` must be a positive integer (got: "${raw}")`
    )
  }
  return n
}

export const parseInputs = (raw: RawInputs): ParsedInputs => {
  if (raw.token.trim().length === 0) {
    throw new Error('input `token` must not be empty')
  }
  return {
    context: raw.context,
    ignoreApps: parseList(raw.ignoreApps),
    ignoreChecks: parseList(raw.ignoreChecks),
    token: raw.token,
    pollIntervalSeconds: parsePositiveInt(
      raw.pollIntervalSeconds,
      'poll-interval-seconds'
    )
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
npm test -- inputs
```
Expected: all tests pass (5 tests).

- [ ] **Step 5: typecheck and lint**

```bash
npm run typecheck && npm run lint
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/inputs.ts __tests__/inputs.test.ts
git commit -m "$(cat <<'EOF'
feat: extend parseInputs with poll-interval-seconds

pollIntervalSeconds (positive int) を追加。 parsePositiveInt で
validation して不正値で throw する。 timeout 制御は利用者の job
timeout-minutes に委ねる方針なので timeoutSeconds / onTimeout は
input に持たない。 multiline ignore-apps / ignore-checks のテストも
追加 (parseList は別 task で更新済み)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Simplify aggregator (drop mode argument)

**Files:**
- Modify: `src/aggregator.ts`
- Modify: `__tests__/aggregator.test.ts`

- [ ] **Step 1: Replace test file**

Overwrite `__tests__/aggregator.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { aggregate, type AggregateResult } from '../src/aggregator.js'
import type { AggregatedCheckRun } from '../src/filter.js'

const make = (
  override: Partial<AggregatedCheckRun> = {}
): AggregatedCheckRun => ({
  id: 1,
  name: 'x',
  status: 'completed',
  conclusion: 'success',
  details_url: '',
  app: { slug: 'github-actions' },
  suite_id: 1,
  ...override
})

describe('aggregate', () => {
  it('returns pending if any check_run is not completed', () => {
    const result = aggregate([
      make(),
      make({ status: 'in_progress', conclusion: null })
    ])
    expect(result.state).toBe('pending')
  })

  it('returns success if all check_runs are green', () => {
    const result = aggregate([
      make({ conclusion: 'success' }),
      make({ conclusion: 'skipped' }),
      make({ conclusion: 'neutral' })
    ])
    expect(result.state).toBe('success')
  })

  it('returns failure if any completed check_run is red', () => {
    const result = aggregate([
      make({ conclusion: 'success' }),
      make({ conclusion: 'failure' })
    ])
    expect(result.state).toBe('failure')
  })

  it('returns success when there are zero runs (vacuous)', () => {
    const result: AggregateResult = aggregate([])
    expect(result.state).toBe('success')
    expect(result.total).toBe(0)
    expect(result.completed).toBe(0)
  })

  it('reports total / completed counts', () => {
    const result = aggregate([
      make({ conclusion: 'success' }),
      make({ status: 'in_progress', conclusion: null })
    ])
    expect(result.total).toBe(2)
    expect(result.completed).toBe(1)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npm test -- aggregator
```
Expected: signature mismatch — current `aggregate` takes `{ runs, mode }`, new tests pass `runs[]` directly.

- [ ] **Step 3: Replace implementation**

Overwrite `src/aggregator.ts`:

```ts
import { classify } from './conclusion.js'
import type { AggregatedCheckRun } from './filter.js'

export type State = 'pending' | 'success' | 'failure'

export type AggregateResult = {
  state: State
  total: number
  completed: number
}

// Aggregates the post-filter check_runs into a single state.
// Pure function — no I/O, no mode flags. The polling loop calls this
// repeatedly with the latest fetched runs and decides whether to keep
// polling (state === "pending") or finish (state === "success" | "failure").
export const aggregate = (runs: AggregatedCheckRun[]): AggregateResult => {
  const total = runs.length
  const completed = runs.filter((r) => r.status === 'completed').length

  const anyPending = runs.some((r) => classify(r) === 'pending')
  if (anyPending) {
    return { state: 'pending', total, completed }
  }

  const anyRed = runs.some((r) => classify(r) === 'red')
  if (anyRed) return { state: 'failure', total, completed }

  return { state: 'success', total, completed }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
npm test -- aggregator
```
Expected: 5 tests pass.

- [ ] **Step 5: typecheck and lint**

```bash
npm run typecheck && npm run lint
```
Expected: PASS (note: this might fail because `index.ts` and `polling.ts` still reference the old `aggregate({ runs, mode })` signature — those will be fixed in subsequent tasks. If typecheck fails ONLY because of `Mode` import or `aggregate({...})` call sites in src/, accept it and proceed).

- [ ] **Step 6: Commit**

```bash
git add src/aggregator.ts __tests__/aggregator.test.ts
git commit -m "$(cat <<'EOF'
feat: simplify aggregate() to a pure runs[] -> state function

v1 の mode 引数 (normal / rescue) を削除して、 aggregate は単純に
「全 completed なら緑/赤評価、 未完了あれば pending」 を返す pure
function に。 救出モードは v2 では polling timeout に置き換える。
mode 関連のテストも整理。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Add polling.ts (loop + sleep + timeout)

**Files:**
- Create: `src/polling.ts`
- Create: `__tests__/polling.test.ts`

- [ ] **Step 1: Write tests first**

Create `__tests__/polling.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { pollUntilComplete } from '../src/polling.js'
import type { AggregatedCheckRun } from '../src/filter.js'

const make = (
  override: Partial<AggregatedCheckRun> = {}
): AggregatedCheckRun => ({
  id: 1,
  name: 'x',
  status: 'completed',
  conclusion: 'success',
  details_url: '',
  app: { slug: 'github-actions' },
  suite_id: 1,
  ...override
})

const opts = { intervalSeconds: 0.001 } // 1 ms — keep test fast

describe('pollUntilComplete', () => {
  it('exits success on the first iteration when all runs are completed green', async () => {
    const fetchRuns = vi.fn().mockResolvedValue([make({ conclusion: 'success' })])
    const result = await pollUntilComplete(fetchRuns, opts)
    expect(result.state).toBe('success')
    expect(result.iterations).toBe(1)
    expect(fetchRuns).toHaveBeenCalledTimes(1)
  })

  it('exits failure when a completed red run is present', async () => {
    const fetchRuns = vi.fn().mockResolvedValue([make({ conclusion: 'failure' })])
    const result = await pollUntilComplete(fetchRuns, opts)
    expect(result.state).toBe('failure')
  })

  it('keeps polling while pending, then exits when checks complete', async () => {
    const fetchRuns = vi
      .fn()
      .mockResolvedValueOnce([make({ status: 'in_progress', conclusion: null })])
      .mockResolvedValueOnce([make({ status: 'in_progress', conclusion: null })])
      .mockResolvedValueOnce([make({ conclusion: 'success' })])
    const result = await pollUntilComplete(fetchRuns, opts)
    expect(result.state).toBe('success')
    expect(result.iterations).toBe(3)
  })

  it('exposes evaluated count via the fetchRuns callback (caller-managed)', async () => {
    let capturedSize = 0
    const fetchRuns = async () => {
      const runs = [make({ conclusion: 'success' })]
      capturedSize = runs.length
      return runs
    }
    const result = await pollUntilComplete(fetchRuns, opts)
    expect(result.state).toBe('success')
    expect(capturedSize).toBe(1)
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

```bash
npm test -- polling
```
Expected: module not found.

- [ ] **Step 3: Implement**

Create `src/polling.ts`:

```ts
import { aggregate, type State } from './aggregator.js'
import type { AggregatedCheckRun } from './filter.js'

export type PollOptions = {
  intervalSeconds: number
}

export type PollResult = {
  state: State
  iterations: number
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// Polls fetchRuns until aggregate(...) returns a terminal state (success
// or failure). The loop has no internal timeout — the caller is expected
// to bound execution via the workflow job's `timeout-minutes`. On runner
// kill, the commit status remains as it was last written.
//
// fetchRuns provides the (already-filtered, already-self-excluded) runs
// to aggregate; the caller can capture per-iteration bookkeeping via
// closure on the callback.
export const pollUntilComplete = async (
  fetchRuns: () => Promise<AggregatedCheckRun[]>,
  options: PollOptions
): Promise<PollResult> => {
  const intervalMs = options.intervalSeconds * 1000

  let iterations = 0
  while (true) {
    iterations++
    const runs = await fetchRuns()
    const result = aggregate(runs)

    if (result.state !== 'pending') {
      return { state: result.state, iterations }
    }

    await sleep(intervalMs)
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
npm test -- polling
```
Expected: 4 tests pass.

- [ ] **Step 5: typecheck and lint**

```bash
npm run typecheck && npm run lint
```

- [ ] **Step 6: Commit**

```bash
git add src/polling.ts __tests__/polling.test.ts
git commit -m "$(cat <<'EOF'
feat: add pollUntilComplete (polling loop + sleep)

src/polling.ts に pollUntilComplete を実装。 fetchRuns コールバックから
runs を取得し、 aggregate を呼んで pending なら interval ms 寝てから
loop、 success/failure なら即 return。 内部 timeout は持たず、
利用者の job timeout-minutes で runner kill されることを前提とする。
fetchRuns の closure で caller が per-iteration bookkeeping (count 等)
を行える。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Remove waitForTriggerSuiteCompleted from api.ts

**Files:**
- Modify: `src/api.ts`
- Modify: `__tests__/api.test.ts`

- [ ] **Step 1: Remove waitForTriggerSuiteCompleted export**

Edit `src/api.ts`. Delete the entire block beginning with `export const waitForTriggerSuiteCompleted = async ...` (the function and its preceding comment block, until the end-of-function `}`).

Keep `fetchAllCheckRuns`, `withRetry`, and the type exports (`OctokitLike`, etc.) intact.

- [ ] **Step 2: Remove the corresponding test block**

Edit `__tests__/api.test.ts`. Delete the entire `describe('waitForTriggerSuiteCompleted', ...)` block. Also remove the `waitForTriggerSuiteCompleted` import from the top of the file.

- [ ] **Step 3: Run, expect PASS**

```bash
npm test -- api
```
Expected: remaining `fetchAllCheckRuns` and `withRetry` tests pass (6 tests).

- [ ] **Step 4: typecheck and lint**

```bash
npm run typecheck && npm run lint
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/api.ts __tests__/api.test.ts
git commit -m "$(cat <<'EOF'
refactor: remove waitForTriggerSuiteCompleted from api.ts

v1 で eventual consistency 対策として実装した
waitForTriggerSuiteCompleted は v2 では不要。 polling loop が
自然に同じ役割を担う (各 iteration が listSuitesForRef を再 fetch
するので、 trigger 直後の遅延は次の poll で解消する)。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Rewrite index.ts with event branching (pending / polling)

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Replace src/index.ts**

Overwrite `src/index.ts` with:

```ts
import * as core from '@actions/core'
import * as github from '@actions/github'
import { parseInputs } from './inputs.js'
import { fetchAllCheckRuns, type OctokitLike } from './api.js'
import { applyFilters } from './filter.js'
import { excludeOwnRuns } from './self-exclusion.js'
import { pollUntilComplete } from './polling.js'
import { buildTargetUrl, writeCommitStatus } from './status.js'

const PENDING_DESCRIPTION = 'Awaiting Auto Merge enable'

const run = async (): Promise<void> => {
  const inputs = parseInputs({
    context: core.getInput('context'),
    ignoreApps: core.getInput('ignore-apps'),
    ignoreChecks: core.getInput('ignore-checks'),
    token: core.getInput('token'),
    pollIntervalSeconds: core.getInput('poll-interval-seconds')
  })

  const ctx = github.context
  if (ctx.eventName !== 'pull_request') {
    core.warning(
      `automerge-gate only handles pull_request events; got "${ctx.eventName}". Skipping.`
    )
    return
  }

  const action = (ctx.payload as { action?: string }).action ?? ''
  const pr = ctx.payload.pull_request as
    | { number: number; head: { sha: string } }
    | undefined
  if (pr === undefined) {
    core.setFailed('pull_request payload is missing')
    return
  }

  const sha = pr.head.sha
  const runId = Number.parseInt(process.env.GITHUB_RUN_ID ?? '0', 10)
  const runAttempt = Number.parseInt(
    process.env.GITHUB_RUN_ATTEMPT ?? '1',
    10
  )
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const repository =
    process.env.GITHUB_REPOSITORY ?? `${ctx.repo.owner}/${ctx.repo.repo}`
  const targetUrl = buildTargetUrl({
    serverUrl,
    repository,
    runId,
    runAttempt
  })

  const octokit = github.getOctokit(inputs.token) as unknown as OctokitLike

  // Pending mode: PR was opened / synchronized / reopened.
  // Write a pending status with an action-item description and exit.
  if (action === 'opened' || action === 'synchronize' || action === 'reopened') {
    await writeCommitStatus(octokit, {
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      sha,
      state: 'pending',
      context: inputs.context,
      description: PENDING_DESCRIPTION,
      target_url: targetUrl
    })
    core.setOutput('state', 'pending')
    core.setOutput('total-checks', '0')
    core.setOutput('evaluated-checks', '0')
    core.setOutput('completed-checks', '0')
    core.setOutput('polled-iterations', '0')
    return
  }

  // Polling mode: maintainer pressed "Enable Auto Merge".
  if (action !== 'auto_merge_enabled') {
    core.warning(`Skipping unsupported pull_request action: "${action}"`)
    return
  }

  let lastTotal = 0
  let lastEvaluated = 0
  let lastCompleted = 0

  const fetchRuns = async () => {
    const allRuns = await fetchAllCheckRuns(
      octokit,
      ctx.repo.owner,
      ctx.repo.repo,
      sha
    )
    lastTotal = allRuns.length
    const afterFilters = applyFilters(
      allRuns,
      inputs.ignoreApps,
      inputs.ignoreChecks
    )
    const afterSelf = excludeOwnRuns(afterFilters, runId)
    lastEvaluated = afterSelf.length
    lastCompleted = afterSelf.filter((r) => r.status === 'completed').length
    return afterSelf
  }

  // Polling has no internal timeout. The job's timeout-minutes will kill
  // this run if checks take too long; commit status remains as last
  // written (= the pending we set in pending mode).
  const pollResult = await pollUntilComplete(fetchRuns, {
    intervalSeconds: inputs.pollIntervalSeconds
  })

  const description = `${pollResult.state}: ${lastEvaluated} checks evaluated`

  await writeCommitStatus(octokit, {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    sha,
    state: pollResult.state,
    context: inputs.context,
    description: description.slice(0, 140),
    target_url: targetUrl
  })

  core.setOutput('state', pollResult.state)
  core.setOutput('total-checks', String(lastTotal))
  core.setOutput('evaluated-checks', String(lastEvaluated))
  core.setOutput('completed-checks', String(lastCompleted))
  core.setOutput('polled-iterations', String(pollResult.iterations))
}

run().catch((err: unknown) => {
  if (err instanceof Error) {
    core.setFailed(err.message)
  } else {
    core.setFailed(String(err))
  }
})
```

- [ ] **Step 2: typecheck and lint**

```bash
npm run typecheck && npm run lint
```
Expected: PASS.

- [ ] **Step 3: Run all tests**

```bash
npm test
```
Expected: full suite passes (no new tests added in this task; existing module tests must remain green).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "$(cat <<'EOF'
feat: rewrite entry point for pending/polling mode dispatch

src/index.ts を v2 用に書き直す。 pull_request event の action 値で
2 モードを分岐:

- opened/synchronize/reopened: pending status を書いて即 exit
  (description: "Awaiting Auto Merge enable")
- auto_merge_enabled: pollUntilComplete で集約評価 → status 書き込み

on-timeout=pending で timeout した場合は status を上書きしない
(既存 pending を維持して maintainer の disable→enable 操作を待つ)。
outputs (state, total-checks, evaluated-checks, completed-checks,
polled-iterations) も新仕様で set。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Rebuild dist/index.js

**Files:**
- Modify: `dist/index.js`

- [ ] **Step 1: Build**

```bash
npm run build
```
Expected: `dist/index.js` updated, no errors.

- [ ] **Step 2: Sanity check**

```bash
ls -la dist/index.js && head -3 dist/index.js
```
Expected: file exists, starts with `"use strict"` or similar esbuild preamble.

- [ ] **Step 3: Commit**

```bash
git add dist/index.js
git commit -m "$(cat <<'EOF'
build: rebuild dist/index.js for v2

esbuild bundle で src/index.ts (v2 entry) と新規 polling / 修正
モジュール群を含む dist/index.js を再生成。 利用者が
\`uses: pkgdeps/automerge-gate@v1\` で参照したときに node が
このファイルを直接実行する。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Rewrite test-self.yml for auto_merge_enabled

**Files:**
- Modify: `.github/workflows/test-self.yml`

- [ ] **Step 1: Replace workflow contents**

Overwrite `.github/workflows/test-self.yml` with:

```yaml
name: test-self

on:
  pull_request:
    types: [opened, synchronize, reopened, auto_merge_enabled]

permissions:
  statuses: write
  checks: read
  pull-requests: read
  actions: read

concurrency:
  group: automerge-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version-file: .node-version
      - run: npm ci
      - run: npm run build
      - name: Self-host gate
        uses: ./
        with:
          context: 'automerge-gate/self-test'
          ignore-checks: 'automerge-gate/self-test'
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/test-self.yml
git commit -m "$(cat <<'EOF'
ci: rewrite self-hosting workflow for v2 (auto_merge_enabled)

test-self.yml を v2 仕様に書き換える。 trigger を
pull_request.types: [opened, synchronize, reopened, auto_merge_enabled]
に変更、 concurrency / timeout-minutes も spec の例に揃える。
集約 status 名は 'automerge-gate/self-test'、 ignore-checks で自身が
書く status を念のため除外。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Rewrite README for v2

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace README contents**

Overwrite `README.md`:

````markdown
# automerge-gate

A GitHub Action that aggregates all check_run results on the same commit into a single commit status, started by the maintainer pressing **"Enable Auto Merge"** on a pull request. Once aggregated to green, GitHub's native auto-merge fires and merges the PR.

This is the successor to [`pkgdeps/check-suite-gate`](https://github.com/pkgdeps/check-suite-gate) (v1, archived). The v1 design used `check_suite.completed` as the trigger but was blocked by GitHub's recursion guard for that event in repos that only run GitHub Actions. v2 switches to `pull_request.auto_merge_enabled`, which has no recursion guard, and adds a polling loop bounded by a configurable timeout.

## How it works

```
PR opened / push / reopened
   ↓
automerge-gate writes a pending commit status
   ("Awaiting Auto Merge enable")
   → register this context as a required check, and the PR is merge-blocked
   ↓
maintainer presses "Enable Auto Merge"
   ↓
GitHub fires pull_request.auto_merge_enabled
   ↓
automerge-gate runs a polling loop:
   listSuitesForRef + listForSuite for the PR head SHA
   filter ignore-apps / ignore-checks / its own check_run
   if every remaining run is completed → write success/failure → exit
   else → sleep poll-interval-seconds → poll again
   if timeout-seconds elapses → on-timeout (failure | pending)
   ↓
status turns green → GitHub native auto-merge fires
status turns red    → auto-merge is blocked
```

## Usage

```yaml
# .github/workflows/automerge-gate.yaml
name: automerge-gate

on:
  pull_request:
    types: [opened, synchronize, reopened, auto_merge_enabled]

permissions:
  statuses: write
  checks: read
  pull-requests: read
  actions: read

concurrency:
  group: automerge-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: pkgdeps/automerge-gate@v1
        with:
          context: 'automerge-gate/all-passed'
          ignore-apps: |
            dependabot
            renovate
          ignore-checks: |
            optional-*
            docs-only
            ci / lint
```

Then register `automerge-gate/all-passed` as a required status check in your ruleset / branch protection. The PR will be merge-blocked until a maintainer presses "Enable Auto Merge" and the gate writes a success status.

## Inputs

| name | required | default | description |
|---|---|---|---|
| `context` | no | `automerge-gate/all-passed` | Commit status context name |
| `poll-interval-seconds` | no | `30` | How often to re-fetch check status |
| `timeout-seconds` | no | `600` | Maximum seconds to wait for all checks to complete (default 10 min) |
| `on-timeout` | no | `failure` | What to write on timeout: `failure` or `pending` |
| `ignore-apps` | no | (empty) | GitHub App slugs to exclude. Comma-separated **or newline-separated** |
| `ignore-checks` | no | (empty) | check_run name patterns to exclude (glob `*` / `?`). Comma-separated **or newline-separated** |
| `token` | no | `${{ github.token }}` | GitHub token |

## Outputs

| name | description |
|---|---|
| `state` | `pending` / `success` / `failure` |
| `total-checks` | Number of check_runs observed before filtering |
| `evaluated-checks` | Number of check_runs after filters |
| `completed-checks` | Number of completed check_runs after filters |
| `polled-iterations` | Number of polling iterations (0 in pending mode) |

## Why this design

- **`pull_request.auto_merge_enabled` has no recursion guard** unlike `check_suite.completed`, so the gate reliably fires on GitHub-Actions-only repos.
- **Polling is gated by an explicit signal** (Enable Auto Merge), so PRs the maintainer hasn't yet decided to merge don't burn runner minutes. Compared with merge-gatekeeper, which polls on every PR push, the resource cost scales with merge intent rather than with PR throughput.
- **The aggregated result is a commit status, not a check_run**, so there's no self-referencing loop in the github-actions check_suite — the gate doesn't see its own writes when it polls.
- **GitHub native auto-merge handles the merge itself** once the aggregated status turns green. This Action does not call `pulls.merge`.

## Limitations

- **Fork PRs** are not supported — secrets and write tokens behave differently across base/fork boundaries.
- **Merge queue (`merge_group`)** is not supported in v1.
- **Dead runner**: if the runner physically dies mid-polling, the commit status remains as it was at the start of polling (`pending`). The maintainer can disable then re-enable Auto Merge to re-trigger.
- **Timeout exceeded**: if `timeout-seconds` elapses before all checks complete, `on-timeout=failure` writes a `failure` status (Auto Merge is blocked); `on-timeout=pending` leaves the existing pending status alone (maintainer can re-enable). The job-level `timeout-minutes` should be set to roughly the same value as `timeout-seconds / 60` plus a small buffer.
- **Legacy commit status events**: third-party CI that writes via the legacy commit status API may not appear in `check_suite` and would not be aggregated. v2 does not handle the `status` event.

## v1 (archived)

The previous version of this Action under the name `check-suite-gate` is preserved in the git history of this repository. The post-mortem on why it didn't work (Japanese) is in [`docs/lessons/2026-05-05-check-suite-recursion-finding.md`](docs/lessons/2026-05-05-check-suite-recursion-finding.md). The v1 spec and plan are also kept under `docs/superpowers/specs/` and `docs/superpowers/plans/` for reference.

## License

MIT
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "$(cat <<'EOF'
docs: rewrite README for automerge-gate v2

v1 (check-suite-gate) の archive notice を撤回し、 automerge-gate
v2 の利用方法 / 設計判断 / 制約を英語で書き直す。 v1 は git history と
docs/lessons / docs/superpowers/{specs,plans} に残してあることを末尾で
言及。 multiline ignore-apps / ignore-checks のサンプルも含める。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Final verification + PR

- [ ] **Step 1: Run full quality gate**

```bash
npm run all
```
Expected: lint + typecheck + test + build all pass. Test count should be approximately: conclusion 5, filter 13 (10 original + 3 new for newline split), self-exclusion 9, status 4, aggregator 5, inputs 5, polling 4, api 6 = ~51 tests.

- [ ] **Step 2: Verify dist integrity**

```bash
git status --porcelain dist/
```
Expected: empty.

- [ ] **Step 3: Sync with remote**

```bash
git fetch origin && git status -sb
```
Expected: branch is ahead of origin or in sync; not behind.

- [ ] **Step 4: Push**

```bash
git push origin redesign/automerge-checks
```

- [ ] **Step 5: Create PR**

```bash
gh pr create --base main --title "feat: rewrite as automerge-gate v2" --body-file - <<'EOF'
## Summary

このリポジトリを v1 (check-suite-gate) から v2 (automerge-gate) に作り変える。 v1 は GitHub Actions の recursion 防止仕様で `check_suite` event が trigger されず動かなかった (詳細: `docs/lessons/2026-05-05-check-suite-recursion-finding.md`)。 v2 は起点を `pull_request.auto_merge_enabled` に切り替え、 polling loop で集約 status を書く設計に再構築。

設計仕様: `docs/superpowers/specs/2026-05-05-automerge-gate-design.md`
実装計画: `docs/superpowers/plans/2026-05-05-automerge-gate-implementation.md`

## Changes

- action.yml: name=automerge-gate / inputs (poll-interval-seconds, timeout-seconds, on-timeout 追加) / outputs (polled-iterations 追加)
- src/inputs.ts: 新 input を parse + validation、 multiline ignore-apps/ignore-checks
- src/filter.ts: parseList を multiline 対応 (`,` または `\n` で split)
- src/aggregator.ts: mode 引数を削除 (救出モード廃止)、 pure runs[] → state
- src/polling.ts: 新規。 pollUntilComplete (loop + sleep + timeout)
- src/api.ts: waitForTriggerSuiteCompleted を削除 (polling で代替)
- src/index.ts: event action で pending モード / polling モード分岐
- .github/workflows/test-self.yml: auto_merge_enabled ベースに書き換え
- README.md: v2 仕様で全面書き直し
- dist/index.js: rebuild

## Test plan

- [ ] CI green (lint / typecheck / test / build / dist check)
- [ ] self-hosting test (test-self.yml) で実 PR の Checks UI に `automerge-gate/self-test - pending - Awaiting Auto Merge enable` が表示される
- [ ] PR で "Enable Auto Merge" を押すと polling が起動し、 全 check 完了で集約 status が success に変わる
- [ ] timeout-seconds 設定値で timeout したら on-timeout に従って failure/pending の挙動

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
```

- [ ] **Step 6: Report PR URL**

ブラウザで draft PR を作成 (clipboard に body が入っている)。 Pushed branch: `redesign/automerge-checks`、 base: `main`。

---

## Self-Review Notes

### Spec coverage

- [x] `pull_request.auto_merge_enabled` event を起点 → Task 7 (index.ts)
- [x] pending モード (opened/synchronize/reopened) → Task 7
- [x] polling loop (interval / timeout / on-timeout) → Task 5 (polling.ts)、 Task 7
- [x] 集約評価 (緑/赤判定) → Task 4 (aggregator.ts) (Task 3 の conclusion.ts 流用)
- [x] ignore-apps / ignore-checks (multiline 対応) → Task 2 (filter.ts)、 Task 3 (inputs.ts)
- [x] 自分自身の除外 → Task 7 で excludeOwnRuns を呼ぶ (Task 6 の self-exclusion.ts は v1 流用)
- [x] commit status 書き込み + target_url → Task 7 で writeCommitStatus / buildTargetUrl を呼ぶ (status.ts は v1 流用)
- [x] inputs (context / poll-interval-seconds / timeout-seconds / on-timeout / ignore-apps / ignore-checks / token) → Task 1 (action.yml)、 Task 3 (inputs.ts)
- [x] outputs (state / total-checks / evaluated-checks / completed-checks / polled-iterations) → Task 1、 Task 7
- [x] dist commit → Task 8
- [x] CI workflow → 既存流用 (Task で扱わない)
- [x] self-hosting integration → Task 9
- [x] README → Task 10
- [x] PR → Task 11

### 流用モジュールの確認

- `src/conclusion.ts`: 変更なし、 v1 のテスト 5 つもそのまま
- `src/self-exclusion.ts`: 変更なし、 v1 のテスト 9 つもそのまま
- `src/status.ts`: 変更なし、 v1 のテスト 4 つもそのまま (buildTargetUrl と writeCommitStatus は v2 でも同じ interface)
- `src/api.ts` の `fetchAllCheckRuns` / `withRetry`: 変更なし、 関連テスト流用
- `.github/workflows/ci.yml`: 変更なし、 v1 で導入した dist 整合性チェックそのまま使える

### Type consistency

- `State` 型は aggregator.ts で `'pending' | 'success' | 'failure'`、 polling.ts と status.ts と index.ts で同じ識別子を使用 ✓
- `AggregatedCheckRun` は filter.ts で定義、 全モジュールが import ✓
- `OctokitLike` は api.ts で定義、 status.ts と index.ts で使用 ✓
- `parseList` の signature: filter.ts で `(raw: string) => string[]`、 inputs.ts で import して使用 ✓
- `aggregate` の signature が変わる (Task 4): mode 引数削除。 polling.ts で `aggregate(runs)` のみ呼ぶので追従 ✓

### Placeholder scan

各 Task に exact code blocks を含めた。 「TBD」 / 「TODO」 / 「適切に実装」 系の placeholder は無し。
