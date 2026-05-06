# 学び: check_run の各種 state を第三者 action でどう表現するか

著者: azu
日付: 2026-05-06
ステータス: v2 で commit status から check_run に移行する際の設計判断記録

## 1分まとめ

GitHub の Checks API は **GitHub Actions サービス自体だけが使える状態値** がいくつかあり、第三者 action は (たとえ `GITHUB_TOKEN` 経由でも) 使えない。 docs の "Only GitHub Actions" は **GitHub の内部 Actions サービス限定** という意味。

| 第三者から使えない | 用途 |
|---|---|
| `status: waiting` / `pending` / `requested` | environment approval 等の内部機構用 |
| `conclusion: stale` | re-run 時に GitHub が古い check_run を退場させるとき自動的に付ける |

第三者 action が「実は使いたい」 と感じる場面でも、 上記は API レベルで 422。 実機で 1 push 試すのが結論を出す最短路。

## 1. pending state ("wating for Enable auto-merge")

automerge-gate の pending state は **`status: queued` (no conclusion)** で表現する。

| 候補 | 結果 |
|---|---|
| `conclusion: action_required` | API は通る、しかし PR Checks UI で **赤いビックリマーク** で表示され failure と区別がつかない |
| `status: waiting` | Checks API が **422 で reject** (`waiting is not a member of [queued, in_progress, completed]`) |
| `status: pending` | 同上 (docs の "Only GitHub Actions can set" 制約) |
| `status: requested` | 同上 |
| **`status: queued`** | **黄色ドットで描画、merge は block、UX 良好 → 採用** |
| `status: in_progress` | queued と同等、好みの問題 |

## 詳細

### 試行1: `conclusion: action_required`

最初に「ボタン押されるの待ち」のセマンティクスに最も近いと判断して採用。実機検証 (PR #15) で:

- API は通る (200)
- merge は branch protection 評価で block される (期待通り)
- **しかし PR Checks UI では赤色のエクスクラメーション** で表示される

`action_required` は GitHub Actions の environment approval flow 用に用意された conclusion で、その文脈では「reviewer 必要」の警告色 (橙〜赤) で描画される。第三者 action が「click button waiting」のヒントとして使うには見た目が強すぎる。

### 試行2: `status: waiting`

[Checks API docs](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#create-a-check-run) には次の記述がある:

> The current status of the check run. Only GitHub Actions can set a status of waiting, pending, or requested. Can be one of: `queued`, `in_progress`, `completed`, `waiting`, `requested`, `pending`

「Only GitHub Actions」 の解釈が曖昧:

- (a) GitHub の **内部 Actions サービス** 限定
- (b) **GITHUB_TOKEN で動く workflow** なら誰でも

実機で試した結果 ([commit d30d33a](https://github.com/pkgdeps/automerge-gate/commit/d30d33a) → revert):

```
No subschema in "anyOf" matched.
waiting is not a member of ["queued", "in_progress", "completed"].
waiting is not a member of ["completed"].
"conclusion" wasn't supplied.
waiting is not a member of ["queued", "in_progress"].
```

→ **(a) で確定**。 `waiting` / `pending` / `requested` は GitHub 内部の deployment approval 等の専用機構が使うもので、第三者 action は (たとえ `GITHUB_TOKEN` 経由でも) 設定できない。

### 採用: `status: queued`

- API: 第三者から自由に setable
- UI: 黄色ドット (commit status の `pending` と同じ視覚的位置付け)
- merge 評価: 非 completed なので「未通過」 = block

`in_progress` も同等に動作するが「実際に何かを処理中」という意味合いが強いので、polling が始まるまでは queued の方が semantically 近い。 (好みの問題なので将来変えてもよい。)

## 2. 古いHEADの check_run を「もう関係ない」と表現する

`pull_request.synchronize` で新しいHEADが landed したとき、 直前のSHAの aggregated check_run を「古くなった」 と分かる状態に PATCH したい。 PR の Commits タブに延々と queued (黄色ドット) が並ぶのを防ぐ。

**結論**: `conclusion: cancelled` を使う。

### 試行: `conclusion: stale`

文字通り「古くなった (stale)」を表す conclusion で、 一見ぴったり。 しかし実機で試すと API が 422:

```
stale is not a member of ["success", "failure", "neutral", "cancelled", "timed_out", "action_required", "skipped"].
```

→ docs の [Update a check run](https://docs.github.com/en/rest/checks/runs?apiVersion=2022-11-28#update-a-check-run) には `stale` も list されているが、 これも GitHub Actions サービス内部用。 GitHub が workflow を re-run したときに古い run の check_run を自動的に stale にするのに使うもので、 第三者は設定できない。

### 採用: `conclusion: cancelled`

許可された 7 値 ( `success`, `failure`, `neutral`, `cancelled`, `timed_out`, `action_required`, `skipped` ) の中で、 「supersededだよ」 を表すのに最も近い。

- 意味: 「この run は (新しい push に) cancel された」 と読める
- UI: グレーの斜線アイコン
- merge 評価: pass しない (= force-push で誤って古い HEAD に戻されても require check は fail)

`skipped` / `neutral` は merge 評価で pass してしまうので、 force-push 時に古い check_run が誤って green と扱われるリスクがある。 `cancelled` は安全側。

## 何を見落としたか

- docs の "Only GitHub Actions can set" を最初から (a) と読み切れず、 (b) の可能性を残した。 一般的に GitHub docs で "GitHub Actions" は **GitHub Actions サービス自体** を指すことが多く、 workflow context のことは通常 "the workflow" / "your workflow" / "the GitHub Actions runner" と書かれる。 紛らわしい場合は実機で試すのが結局速い (1 push で確認できる)。
- `action_required` は API レベルではうまく hit しても UI rendering が intent に合わないことがある (= UX を見て初めて分かる)。 後続の同種の検討では「色味どう描画される?」を最初に確認するルートにすると早い。
- `stale` の制約は docs に明記されていない (許可値 list には載っている) のに API では reject される。 status の `waiting` などと違って事前に予測しにくい。 **API が許可値として list する値でも GitHub 内部用に予約されているケースがある** という前提を持っておく必要があった。

## 3. find-or-create で PATCH してはいけない (suite mismatch)

`writeCheckRun` を find-or-create にしてしまうと、 同一SHA上で複数 workflow run が走ったとき (例: synchronize → auto_merge_enabled) **古い run の suite に PATCH し続ける** ことになる。

GitHub の required check 評価は **最新 suite に該当 check_run があるか** を見るので、 古い suite に閉じ込められた check_run が success でも、 最新 suite には何も無く 「Expected — Waiting for status to be reported」 として block される。

実機検証 (PR #15, SHA `4cd559d` / `2e7cad8`):

```
Suite 1 (synchronize)            : gate + automerge-gate/self-test  ← PATCH 先
Suite 2 (auto_merge_enabled)     : gate のみ
Suite 3 (auto_merge_enabled re-) : gate のみ ← 最新だが required check 不在
```

GraphQL の `statusCheckRollup.state` は SUCCESS と返してくるが、 **`mergeStateStatus: BLOCKED`** が解消されない。

### 修正

`writeCheckRun` から find-or-create を撤去し、 **毎回 create** に変更。 各 workflow run の suite に必ず check_run が入る。 同名 check_run が複数できるが GitHub は最新 (= 一番新しいid) を required check 評価に使うので問題ない。

代わりに `markCheckRunStale` は同一SHA上に複数の自分の check_run があり得る前提で、 全マッチを `cancelled` に PATCH する。

### 何を見落としたか

- 「同名 check_run が複数できると重複表示でうるさい」 という UX 心配が先行して find-or-create にしたが、 そもそも GitHub の required check 評価が **suite 単位で見る** という仕様を知らなかった
- 早く気付くサインはあった: PR の `mergeStateStatus: BLOCKED` と `statusCheckRollup.state: SUCCESS` が **矛盾** していた時点で「GitHub 内部のキャッシュ」と決めつけず、 suite-by-suite で見るべきだった

## 4. polling 開始前に queued check_run を pre-write しないと race する

`auto_merge_enabled` event 起点の workflow run で、 同じ suite に **別 job の skipped check_run が先に landing する** と「polling中の窓」で required check が誤って満たされ、 auto-merge が発火してしまう。

### 観測した事象 (issue #17 / PR #26 of automerge-gate-example)

README の 2-job mutex pattern (`main-gate` / `fork-gate`) で **same-repo PR**:

| 時刻 (UTC) | event |
|---|---|
| 09:51:57 | PR open |
| 09:51:58 | fork-gate skipped → check_run `automerge-gate/all-passed` (skipped) suite 1 |
| 09:52:31 | **Auto Merge enabled** |
| 09:52:34 | suite 2 で fork-gate skipped → 新 check_run `automerge-gate/all-passed` (skipped) |
| 09:52:36 | **PR merged** ← skipped が "latest" 扱いで required check 通過 |
| 09:52:38 | main-gate (action) polling 開始 ← merge後! |

failing check が存在するにもかかわらず、 polling 完了前に merge された。

### 何を見落としたか

- `for duplicate-name evaluation GitHub picks the latest, so the verdict is correct.` という想定があった
- だが「latest」 になるためには **action の writeCheckRun が landing する必要がある**
- polling は数秒かかる ⇒ その間 fork-gate skipped (= passing) が latest を保持 ⇒ 誤って merge

### 修正

`mode === 'polling'` ブロックで、 **`pollUntilComplete` を呼ぶ前に** `state: 'pending'` で writeCheckRun する:

```typescript
if (inputs.gate === 'main') {
  await writeCheckRun(octokit, {
    ...
    state: 'pending',
    output: buildPendingOutput(reason),
    ...
  })
}

core.startGroup('Polling')
// poll...
```

これで suite 内の id 順序は:
1. fork-gate skipped (suite 起動時に landing、 一番早い)
2. main-gate queued (action の polling 開始前 POST、 中間)
3. main-gate completed (polling 完了後 POST、 最大 = latest)

polling中は latest = main-gate queued (非terminal = blocked)。 polling後は latest = main-gate verdict。 race解消。

### fork PR は元々問題なし

fork-gate の場合、 JOB自身が gate (= JOB起動時に check_run が in_progress として作られ、 終了時に conclusion 確定)。 同じ suite 内に同名の他 check_run が無いので race の窓がない。 fix は `inputs.gate === 'main'` 限定なので fork-gate には影響しない。

## 5. v3 単一 job pattern で §4 race は構造的に消え、 polling 前 pre-write も撤去した

§4 の queued pre-write は **v2 の 2-job mutex pattern (`main-gate` / `fork-gate`)** で skipped fork-gate の check_run が "latest" を保持する race を塞ぐための hotfix だった。 v3 では構成を 1 job に整理し直したので、 同名 check_run が複数 job から書かれる前提が成立せず、 race そのものが構造的に消える。 race protection が pre-write の唯一の構造的根拠だったため、 v3 では pre-write 自体を撤去した。

設計の rationale は [docs/architecture.md](../architecture.md) を参照。

### v3 で構造的に消えた点

- **構成を 2 example に分離**: private (cost-optimized) / public (fork-aware)。 同名 check_run を複数 job が触りに行く構造を排除。 race の窓そのものが消滅。
- **input rename を hard break で実施**: `gate: main | fork` → `gate-mode: 'private' | 'public'`。 alias は提供せず、 v2 の値が来たら startup で error。 v2 の race を抱えた構成に逆戻りする path を完全に閉じる。
- **skip path で API write を発行しない**: merge意図がない event (`synchronize` 等) では action が check_run を書かず、 GitHub default の `Expected — Waiting for status to be reported` に任せる。 user 視点の merge block 挙動は変わらず、 API write が 1 回減る。

### polling 前 pre-write は v3 で撤去

v3 では `src/gate-private.ts` の polling path から **polling 開始前の `writeCheckRun({ state: 'pending' })`** を撤去した。 polling 完了後に terminal verdict を 1 回だけ POST する。

撤去理由:

- §4 の race protection は pre-write の唯一の構造的根拠だった。 v3 single-job pattern で race そのものが消えたので、 race 対策としての pre-write は不要になった。
- 一時 v3 では「polling 中の UX 進行表示」 ( `Queued — automerge-gate` 行を見せる) を理由に pre-write を残していたが、 design 簡素化を優先して撤去。
- trade-off: polling 中の数分間は head SHA に対する required-check context が無く、 PR Checks UI には GitHub default の `Expected — Waiting for status to be reported` だけが表示される。 maintainer から見ると「gate が動いているのか triggered されていないのか」 が区別しにくい。 これは workflow run の URL を見れば確認できるので、 design 簡素化の対価として許容する。

結果として v3 polling は **per-run 1 POST** (verdict のみ) で動く。 §4 で書いた hotfix logic は code から消え、 history としてこの doc に残る。

### 残った defensive guard

post-polling write の前に「`pollResult.state === 'pending'` ならば `setFailed` して return する」 guard は残してある。 `pollUntilComplete` は `while(true)` で terminal state でしか return しないので runtime 上 unreachable だが、 `buildPollingOutput` の引数を `'success' | 'failure'` に narrow するための型 guard と、 将来 contract が変わったときに不整合な write を回避する保険を兼ねる。

## 6. v4 で commit status に revert した (suite-mismatch race の再発)

v3 (`v3.0.0`) は private mode の verdict 書き込みを `octokit.rest.checks.create` で行う設計だった。 §3 で論じた「同名 check_run を新規 create することで最新 suite に必ず入れる」想定が、 実機運用で崩れた。

### 観測した事象 (automerge-gate-example PR #28)

`auto_merge_enabled` 起点の workflow run で `octokit.rest.checks.create` を発行したところ、 GitHub 側が **新 check_run を非決定的な (= 当該 workflow run のものではない) check_suite に assign** した。 多くは PR 初回 run の GitHub Actions suite。 結果として **最新 suite には verdict 用 check_run が存在しない** 状態になり、 `mergeStateStatus: BLOCKED` + `statusCheckRollup.state: SUCCESS` という v2 と同じ stuck pattern が再発。

§3 で「`writeCheckRun` は毎回 create する」と決めた前提は、 「create された check_run は呼び出した workflow run の suite に入る」 という暗黙の仮定に依存していた。 GitHub 内部の suite assignment はそうなっていない。 docs では明確化されておらず、 実機検証で初めて分かった (= GitHub Actions サービス側の挙動で、 第三者 action からは制御不可)。

### v4 の修正

private mode の verdict signal を **commit status** に戻した:

- `octokit.rest.repos.createCommitStatus` で POST する。 keyed by `(SHA, context)`、 suite 概念なし。
- §5 の pre-write 撤去はそのまま v4 にも継承 (commit status は append-only per `(SHA, context)` ではあるが、 GitHub の required-check 評価は **同 `(SHA, context)` に対する最新 status だけを見る** ので、 verdict POST 1 回だけで `success` / `failure` が即時に required check に反映される)。
- §3 の `markCheckRunStale` は不要になった。 commit status は SHA ごとに独立しており、 古い SHA の status を「キャンセル」する概念がそもそも無い。
- §1〜§4 の check_run 周りの設計は v2/v3 履歴として残す。 v4 では code path から消えている。

### v1 が正しかった

v1 の commit status 設計は、 §3 / §6 で見つけた suite-mismatch race を **構造的に踏まない** 設計だった。 v2 で「Checks API の方が UI が良い (PATCH で 1 行に収まる)」という UX 観点で乗り換えたが、 race の root cause (= GitHub 内部の suite assignment が API caller には不可視) を v1 設計は意図せず回避していた。 v4 はこの構造的優位を取り戻すリバート。

### 何を見落としたか

- §3 で「create すれば最新 suite に入る」 と仮定したが、 GitHub の suite assignment ロジックは API caller の制御外。 docs にも明記されておらず、 実機で別 PR (automerge-gate-example #28) を運用するまで再発に気付かなかった。
- v2 → v3 の移行時に v1 の commit status 設計の構造的優位を棚卸ししなかった。 「commit status は append-only で UI が崩れる」 という UX 上の不満ばかり議論し、 race 耐性の側面を見ていなかった。
- 教訓: GitHub Actions / Checks API のような分散システムでは、 「同じ workflow run から create した resource が同じ suite に入る」 という仮定は API レベルで保証されていない。 race condition を構造的に消したいときは、 そもそも race の対象になり得ない API (= 単純な key-value pair) を選ぶ方が安全。

## 関連

- [docs/lessons/2026-05-05-check-suite-recursion-finding.md](./2026-05-05-check-suite-recursion-finding.md) — v1 設計の前提崩れ
- [docs/architecture.md](../architecture.md) — v4 設計の rationale
- PR [#15](https://github.com/pkgdeps/automerge-gate/pull/15) — v2 移行 (commit status → check_run)
- [src/commit-status.ts](../../src/commit-status.ts) — v4 の commit status 実装 (v2/v3 の `src/check-run.ts` を `git mv` でリネームして書き直した。 `git log --follow src/commit-status.ts` で v2/v3 の `stateToCheckRunFields` 実装履歴を辿れる)
