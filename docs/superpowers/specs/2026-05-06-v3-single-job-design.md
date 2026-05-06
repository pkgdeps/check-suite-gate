# v3 設計: 単一 job pattern による race 撤廃と private/public 用途分離

著者: azu
日付: 2026-05-06
ステータス: draft (v2.1.0 の hotfix 後に着手予定)

## 動機

v2.0.0 の README 推奨構成 (`main-gate` / `fork-gate` の 2-job mutex) には issue #17 の race condition がある。 v2.1.0 で polling 開始前の queued check_run pre-write による hotfix を入れたが、 **構造的な複雑さは残ったまま**。

v3 ではこれを抜本的に解消する。

## 設計目標

1. **race condition が起きない**: main/fork の 2-job mutex を撤廃し単一 job に
2. **GHA 経由の PR でも kick できる**: `auto_merge_enabled` event が trigger できる構成を維持
3. **private と public で適切な構成を選べる**: コスト最適化 (private) と fork PR 対応 (public) のトレードオフを明示

## 構成 2 種

### 構成 A: private 用 (cost-optimized)

```yaml
name: automerge-gate

on:
  pull_request:
    types: [auto_merge_enabled]
  pull_request_review:
    types: [submitted]

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
          gate: main
          context: 'automerge-gate/all-passed'
```

特徴:

- merge意図イベントだけで起動 (`auto_merge_enabled`, `pull_request_review.submitted approved`)
- action が API で check_run を write (success/failure を report)
- pending mode は撤去 (= job 起動時点で merge意図があるので、 必ず polling に入る)
- runner cost: PR毎に 1〜数 run のみ (merge-gatekeeper の 1/N)

### 構成 B: public 用 (fork PR 対応)

```yaml
name: automerge-gate

on:
  pull_request:
    types: [opened, synchronize, reopened, auto_merge_enabled]
  pull_request_review:
    types: [submitted]

jobs:
  gate:
    name: automerge-gate/all-passed   # ← required check 名
    if: >-
      github.event_name != 'pull_request_review'
      || github.event.review.state == 'approved'
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      checks: read
      pull-requests: read
      actions: read
    steps:
      - uses: pkgdeps/automerge-gate@v3.0.0
        with:
          gate: fork
```

特徴:

- gate signal = JOB の check_run conclusion (= action の exit code)
- action は API で check_run を write しない (token read-only on fork)
- `synchronize` 等の頻度高い event でも起動 (fork PR は merge 前に polling 必須)
- pending state UI: 「Expected — Waiting for status to be reported」 (GitHub 標準)

## v2 との差分

| | v2 | v3 |
|---|---|---|
| Job 数 | 2 (main-gate / fork-gate mutex) | 1 |
| `gate` input | `main` / `fork` | 同 (構成で使い分け) |
| race condition | あり (issue #17、 v2.1.0 で hotfix済) | 構造的に発生不可 |
| pending mode write | あり | なし (merge意図来るまで起動しない) |
| README example | 単一 (mutex pattern) | 2 種 (private / public) |

## なぜ「2 構成」 なのか (1 構成にまとめられない理由)

private / public で permission/trigger が根本的に異なるため:

| | private | public |
|---|---|---|
| token scope | 全権限 | fork PR 時 read-only |
| API write 可否 | ◯ | × (fork) |
| gate 信号 | API check_run | JOB exit code |
| merge意図 trigger だけで OK か | ◯ (push 時に required check が無くても、 push の人が PR内なので問題ない) | △ (fork PR で API書けないため synchronize 時も poll 必要) |

つまり同じ workflow で両用途満たそうとすると、 結局 v2 の 2-job mutex に戻ってしまう。 **「1 つの workflow で 1 つの構成」** に分けたほうがシンプル。

## auto_merge_enabled の特殊性

GHA 経由で作った PR (Renovate, dependabot, custom bot) では `pull_request.opened` event が発火しないことが多い (recursion防止)。 一方、 maintainer が `Enable auto-merge` を押した時の `auto_merge_enabled` event は **発火する**。

→ 両構成とも `auto_merge_enabled` を trigger に含めることが必須。 GHA 経由 PR の merge route として確実に動く唯一の入り口。

## 残課題

### 1. pending state の UI

- 構成 A (private): merge意図来るまで job 起動しない → required check 不在 → 「Expected — Waiting for status to be reported」 表示
- 構成 B (public): 同上

これは [docs/lessons/2026-05-06-check-run-pending-state-mapping.md](../../lessons/2026-05-06-check-run-pending-state-mapping.md) で議論済の Option B 相当。 PR list の checkmark が緑になる利点がある一方、 「Click Enable Auto Merge」 のような誘導文言が出ない。

trade-off の整理:

| | v2 (queued check_run write) | v3 構成 A/B (write しない) |
|---|---|---|
| PR list checkmark | 黄 (pending) | 緑 (reported checks がpassなら) |
| 個別PR の merge box | 「Queued — Waiting for...」 | 「Expected — Waiting for status to be reported」 |
| merge block | ◯ | ◯ |
| 構造的 race可能性 | ある (queued の latest を使うので race の余地) | 構造的になし (job 起動 = polling のみ) |

v3 の取り得る選択:

- (b1) write しない: Option B 相当、 PR list で緑になる
- (b2) merge意図到来時に queued を pre-write: 現 v2.1.0 の hotfix 風、 race無いが PR list は黄

意見の分かれるところ。 README の構成 A で b1 にして、 「もっとリッチな pending UI が欲しいなら自前で write する step を足してもらう」 という方針もアリ。

### 2. Approve sticky のための synchronize trigger

「過去に Approve された PR で push したら、 polling を再起動 (新 SHA で評価)」 という挙動を維持したい。

構成 A: trigger に `synchronize` を含めない → push後の自動 re-evaluation が起きない。 maintainer が再度 `Enable auto-merge` を押す or 新 Approve が必要。 これはこれで明示的で良いとも言える。

構成 B: `synchronize` を含めるので問題ない。

### 3. action input の整理

`gate: main | fork` を残すか、 v3 で別の名前 (例: `mode: api-write | exit-code`) にするか。 後方互換性のため `gate` keep、 alias で `mode` 追加もあり。

## 移行計画

1. **v2.1.0**: issue #17 hotfix を release (queued pre-write)
2. **v3 design review**: この doc + brainstorming で詳細を詰める
3. **v3.0.0**: README 全面書き換え、 単一 job pattern x 2 example、 既存 `gate` input は残す、 v2 README を v2-legacy.md に移動
4. **6ヶ月後**: v2 サポート終了 (or 継続するか判断)

## 関連

- [Issue #17](https://github.com/pkgdeps/automerge-gate/issues/17) — race condition の発見
- [docs/lessons/2026-05-06-check-run-pending-state-mapping.md](../../lessons/2026-05-06-check-run-pending-state-mapping.md) — check_run の各種 state を第三者 action でどう表現するか
- [docs/lessons/2026-05-05-check-suite-recursion-finding.md](../../lessons/2026-05-05-check-suite-recursion-finding.md) — v1 の前提崩れ
