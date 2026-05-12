# Per-check pass/fail result log (merge-gatekeeper-style)

## Goal

Polling 中と終了後の両方で、どの check_run が何の状態かを名前付きでログに出す。merge-gatekeeper のように job 単位の結果を1か所で見られるようにする。現在は aggregate された数値 (`3/5 completed`) しか出ないので、失敗時に「何が失敗したのか」を別タブで調べる必要がある。

設計の柱:
- **live 監視で "動いてる感"** が分かるように、ログをすべて top-level (group なし) に出す
- **timeout 時のフォレンジック** に耐えられるように、各 poll で pending 中の check 名を残す
- **最終結果** で全 check の verdict を一覧表示する

## Non-goals

- Skip 経路でのログ (check_run を取得していないので対象外)
- 失敗詳細 (annotations / error message) の表示 — `details_url` で GitHub UI へ飛べば見られる
- 中間時点での per-check verdict (各 poll で完了済みの個別状態は出さない。最終結果でまとめて出す)

## Output format

既存の outer group (`core.startGroup('Polling')` (`gate-private.ts:153`, `gate-public.ts:55`) および `core.startGroup('Result')` (`gate-private.ts:164`)) は撤去する。GitHub Actions の group はネスト不可なので、poll ごとに個別 group を作るには外側 group を外す必要があるため。

ログ構造:
- **Per-poll**: 毎回 `core.group(title, fn)` で個別グループにする (collapsible)。中身は **その時点での全 check と status を1行ずつ**
- **Final result**: 素の top-level (group なし) で `core.info` 出力

### 例

```
::group::[00:05] Poll #1 — pending, 8/11 completed
  ❌ ci/build      (failure)
  ✅ ci/codeql     (success)
  ✅ ci/format     (skipped)
  ✅ ci/lint       (success)
  ✅ ci/snapshot   (success)
  🟡 ci/test       (in_progress)
  ✅ ci/typecheck  (success)
  ✅ ci/security   (neutral)
  🟡 external/scan (queued)
  ✅ ci/package    (success)
  🟡 ci/integration (in_progress)
::endgroup::
::group::[00:15] Poll #2 — pending, 9/11 completed
  ❌ ci/build      (failure)
  ✅ ci/codeql     (success)
  ...
  🟡 ci/test       (in_progress)
  🟡 external/scan (queued)
::endgroup::
::group::[00:25] Poll #3 — failure, 11/11 completed
  ❌ ci/build      (failure)
  ❌ ci/lint       (cancelled)
  ✅ ci/test       (success)
  ✅ ci/codeql     (success)
  ...
::endgroup::

❌ Failed (2):
  - ci/build (failure)
  - ci/lint (cancelled)
✅ Passed (9):
  - ci/codeql (success)
  - ci/format (skipped)
  - ci/lint (success)
  ...
```

### Per-poll formatting

Group title (= 折りたたみ時に表示される):
```
[mm:ss] Poll #N — STATE, COMPLETED/TOTAL completed
```

- `mm:ss`: polling 開始からの経過時間 (0 詰めの分:秒)。"時計が動いている" 視認性のため
- `STATE`: `pending` / `success` / `failure` (`pollUntilComplete` の `state`)
- waiting 件数は `TOTAL - COMPLETED` で自明なので表示しない

Group 内容 (展開時に表示される):
```
  <icon> <check name> (<status-or-conclusion>)
```

- **全 check** を1行ずつ (pending も完了済みも)
- アイコン:
  - `✅` → verdict `green` (`success` / `skipped` / `neutral`)
  - `❌` → verdict `red` (`failure` / `cancelled` / `timed_out` / `action_required` など)
  - `🟡` → verdict `pending` (`status !== 'completed'` または `conclusion === null`)
- カッコ内:
  - completed なら `conclusion` の値 (`success` / `failure` / ...)
  - そうでなければ `status` の値 (`in_progress` / `queued` など)
- ソートは **check name の昇順** (poll 間で順序が安定するので diff っぽく見比べられる)
- アイコン + 名前で視覚的に red/pending がスキャンしやすい

全 poll を group 化する (terminal poll も含む)。terminal poll の group は内容が Final result block と重複するが、historical snapshot として残す価値がある (過去の poll で何が起きていたか追えるため)。Final result block はあくまで最終 verdict として top-level に出す。

### Live UI 挙動

- 実行中: 現在 open な group の中身はストリームで見える。`endgroup` で折りたたまれる
- → poll ごとに「ヘッダー出現 → 名前が並ぶ → 畳まれる」が interval ごとに繰り返される
- → 新しい group header が top-level に定期的に積まれるので "動いてる感" が出る

### Post-run UI

全 group 畳まれて1行ずつ並ぶ。気になる poll だけクリックで展開。

### Final result block

Polling 終了後、commit-status 書き込み (private) / setFailed (両モード) より **前** に出力する。

```
❌ Failed (N):
  - <name> (<conclusion>)
  ...
✅ Passed (M):
  - <name> (<conclusion>)
  ...
```

- Failed セクションを先、Passed を後 (重要なものを上に)
- 各セクション内は check name で昇順ソート
- カッコ内は元の `conclusion` 値 (`failure` / `cancelled` / `timed_out` / `success` / `skipped` / `neutral` など) をそのまま出す
- Failed が 0 件のときは `❌ Failed` セクション自体を省略
- Passed が 0 件のときは `✅ Passed` セクション自体を省略
- Polling 終了時点で pending が残るのは想定外。残っていた場合は集計から除外し、`core.warning` で件数を出す (`pending check(s) at result time: N`)

### Verdict 分類

`src/conclusion.ts` の `classify` をそのまま使う:
- `green` → ✅ Passed
- `red` → ❌ Failed
- `pending` → 出力対象外 (上記 warning へ)

### Step summary

既存の aggregate テーブルの下にリスト形式で全件を追加する (ユーザー合意済み):

```markdown
### Check results

#### ❌ Failed (2)
- `ci / build` — failure
- `lint` — cancelled

#### ✅ Passed (4)
- `ci / test` — success
- `codeql` — neutral
- `format` — skipped
- `typecheck` — success
```

セクションの省略ルールはログと同じ。

## Implementation

### New module: `src/check-results.ts`

Pure formatter. I/O なし。

```ts
import { classify } from './conclusion.js'
import type { AggregatedCheckRun } from './filter.js'

export type CheckResultsFormatted = {
  logLines: string[]      // core.info で1行ずつ出す
  summaryMarkdown: string // core.summary.addRaw で追記する (空文字なら何も追加しない)
  pendingCount: number    // 想定外の pending 件数 (caller が warning を出す)
}

export const formatCheckResults = (
  runs: AggregatedCheckRun[]
): CheckResultsFormatted => { /* ... */ }

// 各 poll のタイトル文字列 ("[mm:ss] Poll #N — ...") を組み立てる
export const formatPollTitle = (input: {
  elapsedMs: number
  iteration: number
  state: 'pending' | 'success' | 'failure'
  completed: number
  total: number
}): string => { /* ... */ }

// poll group 内の per-check 行を組み立てる (全 check, 名前ソート, icon + name + status/conclusion)
export const formatPollBody = (runs: AggregatedCheckRun[]): string[] => { /* ... */ }

// elapsedMs を "mm:ss" にフォーマット (テスト容易性のため公開)
export const formatElapsed = (elapsedMs: number): string => { /* ... */ }
```

### Polling 側の変更

`pollUntilComplete` の `onIteration` callback には現状 `iteration` / `state` / `completed` / `total` が渡っているが、**pending な check 名** が渡らない。コールバックで pending 名を取れるよう拡張するか、または `fetchRuns` のクロージャ側で pending 名を保持しておいて poll 行を作る側で参照する。

選択: **fetchRuns クロージャで `lastPendingNames: string[]` を保持** する方が、`pollUntilComplete` のインターフェース変更を避けられて影響範囲が小さい。

```ts
let lastRuns: AggregatedCheckRun[] = []
const fetchRuns = async () => {
  // 既存処理
  lastRuns = afterSelf
  return afterSelf
}

const pollStartedAt = Date.now()
const pollResult = await pollUntilComplete(fetchRuns, {
  intervalSeconds: inputs.pollIntervalSeconds,
  onIteration: async (s) => {
    const title = formatPollTitle({
      elapsedMs: Date.now() - pollStartedAt,
      iteration: s.iteration,
      state: s.state,
      completed: s.completed,
      total: s.total
    })
    const body = formatPollBody(lastRuns)
    await core.group(title, async () => {
      for (const line of body) core.info(line)
    })
  }
})
```

Note: `core.group(title, fn)` は内部で `startGroup → fn() → endGroup` を呼ぶラッパー (`@actions/core` の API)。例外時も `endGroup` を呼んでくれるので group の取り残しが起きない。

`polling.ts` を確認した結果、`fetchRuns` → `onIteration` の順で呼ばれるので `lastRuns` は最新が保証される。ただし現状の `onIteration` の型は `(snapshot) => void` なので、`core.group` の `Promise<void>` 戻り値を await できるよう型を `void | Promise<void>` に変更する必要がある (`polling.ts` 側で `await options.onIteration?.(...)` にする)。

### Final result 出力

Polling 終了後、両 gate で:

```ts
const formatted = formatCheckResults(lastRuns)
for (const line of formatted.logLines) core.info(line)
if (formatted.pendingCount > 0) {
  core.warning(`pending check(s) at result time: ${formatted.pendingCount}`)
}
```

### Group の撤去

- `gate-private.ts:153` の `core.startGroup('Polling')` / `core.endGroup()` を削除
- `gate-private.ts:164` の `core.startGroup('Result')` / `core.endGroup()` を削除 (中の2行は最終結果ブロックに統合)
- `gate-public.ts:55` の `core.startGroup('Polling')` / `core.endGroup()` を削除
- `core.startGroup('Setup')` (`gate-private.ts:52`) は **残す** (起動時の固定情報なので折りたためたほうが良い)

### Step summary 追記

既存の `writeSummary` (private) / inline summary (public) に section を追加。`addRaw(formatted.summaryMarkdown)` を `.addTable(...)` の後にチェーンする。`summaryMarkdown` が空文字 (= Failed/Passed どちらも 0 件) なら追記しない。

### Skip path (gate-private)

`mode === 'skip'` の経路は変更なし。check_run を取得していないので結果ログも summary section も出さない。

## Tests

新規:
- `__tests__/check-results.test.ts`
  - `formatCheckResults`: 全成功 / 全失敗 / 混在 / 空配列 / pending 混入 / 名前ソート / conclusion 値ごとの分類
  - `formatPollTitle`: state 別、elapsed 表示
  - `formatPollBody`: アイコン分類 (green/red/pending)、completed は conclusion 表示, 未完了は status 表示, 名前ソート, 空配列
  - `formatElapsed`: 0/1/60/600/3600 秒のフォーマット

更新:
- `__tests__/gate-private.test.ts` / `gate-public.test.ts`
  - `core.startGroup('Polling')` / `core.startGroup('Result')` が呼ばれなくなることのアサーション (既存テストに含まれていれば修正)
  - poll タイトルに `[mm:ss]` プレフィックスが付くアサーション
  - 各 poll で `core.group` が呼ばれ、中に全 check の icon + 名前 + status が出ることのアサーション
  - polling 完了後、Failed/Passed セクションが top-level に出ることのアサーション
  - Step summary に check results section が追記されることのアサーション

## Files changed

- `src/check-results.ts` (new)
- `src/gate-private.ts` — group 撤去、lastRuns 保持、最終出力、summary section
- `src/gate-public.ts` — group 撤去、lastRuns 保持、最終出力、summary section
- `src/polling.ts` — `onIteration` の型を `void | Promise<void>` に拡張し、await する
- `__tests__/check-results.test.ts` (new)
- `__tests__/gate-private.test.ts` — 期待値更新
- `__tests__/gate-public.test.ts` — 期待値更新
- `dist/` — ncc rebuild

## Open questions

なし。
