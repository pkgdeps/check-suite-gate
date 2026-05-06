# 学び: check_run の "Enable auto-merge 待ち" を表す state の選定

著者: azu
日付: 2026-05-06
ステータス: v2 で commit status から check_run に移行する際の設計判断記録

## 結論

automerge-gate の pending state ("maintainer が Enable auto-merge を押すのを待っている" 状態) は **`status: queued` (no conclusion)** で表現する。

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

## 何を見落としたか

- docs の "Only GitHub Actions can set" を最初から (a) と読み切れず、 (b) の可能性を残した。 一般的に GitHub docs で "GitHub Actions" は **GitHub Actions サービス自体** を指すことが多く、 workflow context のことは通常 "the workflow" / "your workflow" / "the GitHub Actions runner" と書かれる。 紛らわしい場合は実機で試すのが結局速い (1 push で確認できる)。
- `action_required` は API レベルではうまく hit しても UI rendering が intent に合わないことがある (= UX を見て初めて分かる)。 後続の同種の検討では「色味どう描画される?」を最初に確認するルートにすると早い。

## 関連

- [docs/lessons/2026-05-05-check-suite-recursion-finding.md](./2026-05-05-check-suite-recursion-finding.md) — v1 設計の前提崩れ
- PR [#15](https://github.com/pkgdeps/automerge-gate/pull/15) — v2 移行 (commit status → check_run)
- [src/check-run.ts](../../src/check-run.ts) — `stateToCheckRunFields` 実装
