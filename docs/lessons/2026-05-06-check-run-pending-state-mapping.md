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

## 1. pending state ("Enable auto-merge 待ち")

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

## 関連

- [docs/lessons/2026-05-05-check-suite-recursion-finding.md](./2026-05-05-check-suite-recursion-finding.md) — v1 設計の前提崩れ
- PR [#15](https://github.com/pkgdeps/automerge-gate/pull/15) — v2 移行 (commit status → check_run)
- [src/check-run.ts](../../src/check-run.ts) — `stateToCheckRunFields` 実装

