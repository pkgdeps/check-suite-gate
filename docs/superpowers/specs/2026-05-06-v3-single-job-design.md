# v3 設計: 単一 job pattern による race 撤廃と private/public 用途分離

著者: azu
日付: 2026-05-06
ステータス: 確定 (brainstorming 完了、 implementation 待ち)

## 動機

v2.0.0 の README 推奨構成 (`main-gate` / `fork-gate` の 2-job mutex pattern) には issue #17 の race condition があった。 v2.1.0 では polling 開始前の queued check_run pre-write による hotfix を入れたが、 **構造的な複雑さは残ったまま**。

v3 では race の根本原因 (= main-gate と fork-gate が同じ check_run 名を共有しつつ片方が skipped になる) を撤廃する。

## 設計目標

1. **race condition が起きない**: main/fork mutex を撤廃、 単一 job 構成に
2. **GHA 経由の PR でも kick できる**: `auto_merge_enabled` event を trigger に含める (Renovate / dependabot / custom bot 用)
3. **private と public で適切な構成を選べる**: コスト最適化 (private) と fork PR 対応 (public) のトレードオフを README に明示
4. **Approve sticky を維持 (private mode のみ)**: 過去の write-permission Approve は private mode の synchronize での polling 起動根拠として継続有効。 public mode は常に polling なので sticky の概念自体が不要

## 決定事項サマリ

ブレインストーミングで決まった選択:

| 論点 | 決定 |
|---|---|
| README 構成 | 2 example (private / public) |
| pending state UI | Option B (何も write しない、 GitHub default "Expected") |
| Approve sticky | 維持 (hasActiveApproval、 write-permission reviewer) |
| input 名 / 値 | `gate-mode: 'private' \| 'public'`、 hard break (旧 `gate` は error) |
| gate-mode 別挙動 | private: skip可、 public: 常に polling |
| 内部 ActionMode | polling / skip のみ (pending mode 廃止) |
| code 構成 | `src/gate-private.ts` と `src/gate-public.ts` に分割 |

## アーキテクチャ概要

### 単一 job pattern

v2 の 2-job mutex は **「同じ check_run 名 (`automerge-gate/all-passed`) を両 job が触りに行く」** のが race の構造的原因だった。 v3 では gate job を **常に1つ** にすることで「誰が check_run を確定するか」 を一意化する。

### 2 つの README example

private と public で workflow YAML を分ける。 user は repo の性質 (外部 fork PR を受けるか) で構成を選ぶ。

```
構成 A: private (cost-optimized)
  - 内部のみ contributor / fork PR 受けない
  - action が Checks API で check_run を write
  - pending event は skip して runner cost を節約

構成 B: public (fork-aware)
  - 外部 contributor / fork PR を受ける
  - JOB の exit code が gate signal
  - 起動されたら必ず polling (cost > correctness)
```

## 構成 A: private (cost-optimized)

### workflow YAML

```yaml
name: automerge-gate

on:
  pull_request:
    types: [opened, synchronize, reopened, auto_merge_enabled]
  pull_request_review:
    types: [submitted]

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
    permissions:
      checks: write
      pull-requests: read
      actions: read
    steps:
      - uses: pkgdeps/automerge-gate@v3.0.0
        with:
          gate-mode: 'private'
          context: 'automerge-gate/all-passed'
```

### 動作マトリクス (gate-mode: 'private')

| event | 条件 | mode | 動作 |
|---|---|---|---|
| `pull_request.auto_merge_enabled` | — | polling | API write (success/failure) |
| `pull_request.synchronize` (or opened/reopened) | `auto_merge` already enabled | polling | 同上 (sticky auto-merge) |
| `pull_request.synchronize` (or opened/reopened) | `hasActiveApproval` = true | polling | 同上 (sticky Approve) |
| `pull_request.synchronize` (or opened/reopened) | merge意図なし | **skip** | 何もせず exit 0 → 「Expected」 → block |
| `pull_request_review.submitted approved` | `hasActiveApproval` = true | polling | API write |
| `pull_request_review.submitted approved` | drive-by Approve (write 権限なし) | skip | 何もしない |

### 補助 logic

- **markCheckRunStale**: synchronize 時に `payload.before` SHA の自分 (external_id=automerge-gate) check_run を `cancelled` で PATCH。 PR の Commits タブの古いSHA表示をクリーンに保つ
- **hasActiveApproval**: 過去 review を listし、 user 毎の最新 non-COMMENTED review が APPROVED かつ write 権限ありを判定

## 構成 B: public (fork-aware)

### workflow YAML

```yaml
name: automerge-gate

on:
  pull_request:
    types: [opened, synchronize, reopened, auto_merge_enabled]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  gate:
    name: automerge-gate/all-passed   # ← required check 名と一致 (= JOB exit code が gate signal)
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      checks: read
      pull-requests: read
      actions: read
    steps:
      - uses: pkgdeps/automerge-gate@v3.0.0
        with:
          gate-mode: 'public'
```

### 動作マトリクス (gate-mode: 'public')

| event | mode | 動作 |
|---|---|---|
| **どの event でも** (`if:` で job が起動した時点で) | **常に polling** | 全check 集約、 結果が action exit code → JOB の check_run conclusion |

公開リポでは「polling 起動 = JOB起動」 の 1 path のみ。 skip mode は存在しない。

### 補助 logic

- **markCheckRunStale**: 呼ばない (token read-only で API write できないため)
- **hasActiveApproval**: 呼ばない (skip 判定不要 = always polling)

## 構成差まとめ

| 項目 | private | public |
|---|---|---|
| `pull_request_review` trigger | あり | **なし** |
| `if:` filter (review state) | あり | **なし** |
| job `name:` | (default = `gate`) | **`automerge-gate/all-passed`** |
| permissions | `checks: write` | `checks: read` |
| `gate-mode` | `'private'` | `'public'` |
| `context:` input | あり (check_run 名) | 不要 |
| skip 動作 | exit 0 → 「Expected」 → block | (skip しない、 常に polling) |
| API call | listForRef、 createCheckRun、 update etc + listReviews + perm | fetchAllCheckRuns 系のみ (read系) |

## action 内部構造

### 新規ファイル

- **`src/gate-private.ts`**: gate-mode='private' の全 logic (旧 `index.ts` の run() を抽出)
- **`src/gate-public.ts`**: gate-mode='public' の always-poll logic
- **`src/index.ts`**: 入力 parse → dispatch のみ (薄い)

```typescript
// src/index.ts (新)
const inputs = parseInputs({...})
if (inputs.gateMode === 'private') {
  await runPrivate(octokit, inputs)
} else {
  await runPublic(octokit, inputs)
}
```

```typescript
// src/gate-public.ts (新、 概略)
export const runPublic = async (octokit, inputs) => {
  // event payload extraction (PR取得、 SHA取得)
  // ... fetchAllCheckRuns でpolling
  const pollResult = await pollUntilComplete(...)
  if (pollResult.state === 'failure') {
    core.setFailed('aggregated state is failure')
  }
  // success の場合は普通に exit 0 → JOB success → required check 通過
}
```

```typescript
// src/gate-private.ts (新、 概略)
export const runPrivate = async (octokit, inputs) => {
  // event/payload 確認
  const isApproved = await hasActiveApproval(...)
  const { mode, reason } = determineMode({...})
  if (mode === 'skip') {
    core.info(`skipping: ${reason}`)
    return
  }
  // markCheckRunStale on synchronize
  // polling
  const pollResult = await pollUntilComplete(...)
  // writeCheckRun (success/failure)
}
```

### 変更されない既存ファイル

- `src/api.ts`、 `src/polling.ts`、 `src/aggregator.ts`、 `src/conclusion.ts`、 `src/filter.ts`、 `src/self-exclusion.ts` — 共通 utility、 そのまま使用

### private 専用化される既存ファイル

- `src/mode.ts`、 `src/check-run.ts`、 `src/review-status.ts` — gate-private.ts からのみ呼ばれる

### inputs.ts の変更

```typescript
export type GateMode = 'private' | 'public'

export type ParsedInputs = {
  context: string
  gateMode: GateMode      // ← 旧 gate を rename
  ignoreApps: string[]
  ignoreChecks: string[]
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
```

### action.yml の変更

```yaml
inputs:
  gate-mode:
    description: 'Gate variant. "private" = cost-optimized for repos with no external fork PRs (action writes the aggregated check_run via the Checks API). "public" = simpler model for fork-accepting repos (the gate signal is the JOB exit code; the job name must match the required-check context).'
    required: true
  context:
    description: 'Aggregated check_run name (gate-mode: private only). Must match the required check in your ruleset. Ignored when gate-mode: public — the job name is the signal.'
    required: false
    default: 'automerge-gate/all-passed'
  # 旧 `gate` input は削除 (hard break)
  # 残り: poll-interval-seconds, ignore-apps, ignore-checks, token (v2 から変更なし)
```

### test の変更

- `__tests__/mode.test.ts`: `'pending'` mode のテスト削除、 公開 (always polling) は別 test
- `__tests__/inputs.test.ts`: `gate` → `gateMode` rename、 値 'private'/'public' validation
- `__tests__/gate-private.test.ts` (新): private 向けの結合テスト (mock 注入で event 種別ごと)
- `__tests__/gate-public.test.ts` (新): public 向けの結合テスト
- 既存 99 tests のうち pending 関連は廃棄、 数件減

## 移行ガイド (v2 → v3)

### user 視点の変更点

1. **workflow YAML 全面書き換え**: 2-job mutex → 単一 job
2. **input 名 rename (hard break)**: `gate: main | fork` → `gate-mode: 'private' | 'public'`
3. **branch protection の required check 名は変えない**: `automerge-gate/all-passed` のまま
4. **`auto_merge_enabled` event は引き続き trigger に含める**: GHA-PR 用

### 移行 step

1. リポが **外部 fork PR を受けるか** を確認
2. **受けない**: 構成 A (private)
   - fork-gate job を削除
   - main-gate job を 単一 gate job にrename
   - `gate: main` → `gate-mode: 'private'`
3. **受ける**: 構成 B (public)
   - main-gate job を削除
   - fork-gate job を 単一 gate job に (`name: automerge-gate/all-passed` 維持)
   - `gate: fork` → `gate-mode: 'public'`
   - permissions: `checks: write` → `checks: read`
4. branch protection rule はそのまま

### docs/MIGRATION.md (新規)

before/after の YAML diff、 input rename 表、 「fork PR を将来受けるかもしれない」 場合の助言 (= public 推奨)。

### v2 ユーザー アナウンス (GitHub Releases v3.0.0)

- breaking changes 一覧 (workflow YAML 構造、 input 名)
- 移行 docs link
- v2.x maintenance: security fix のみ継続を表明 (期間は別途)

## 残課題 / 後回し事項

### concurrency.cancel-in-progress

v3 でも `cancel-in-progress: true` を採用 (merge-gatekeeper と同じ)。 v2 で観測された suite-mismatch race は **2-job mutex 起因** だったため、 単一 job 構成では再現しない見込み。 もし v3 でも observed したら再評価。

### auto_merge_enabled の trigger 必須性

GHA-PR (Renovate 等) では `pull_request.opened` が発火しないため、 `auto_merge_enabled` を含めないと bot が作った PR は永遠に gate が走らない。 README 例で必ず types に含める。

### 将来の拡張余地

- `mode: 'private' | 'public'` の use-case 命名を採用したことで、 将来別 mechanism (例: GitHub App ベース) を追加する場合に internal mapping だけ変えればよい
- 例: `mode: 'enterprise'` を追加し、 internal で別 path を呼ぶ等

## 関連

- [Issue #17](https://github.com/pkgdeps/automerge-gate/issues/17) — race condition の発見
- [PR #18](https://github.com/pkgdeps/automerge-gate/pull/18) — v2.1.0 hotfix (queued pre-write)
- [docs/lessons/2026-05-06-check-run-pending-state-mapping.md](../../lessons/2026-05-06-check-run-pending-state-mapping.md) — check_run state の選定経緯 (§4 が issue #17 の記録)
- [docs/lessons/2026-05-05-check-suite-recursion-finding.md](../../lessons/2026-05-05-check-suite-recursion-finding.md) — v1 の前提崩れ
