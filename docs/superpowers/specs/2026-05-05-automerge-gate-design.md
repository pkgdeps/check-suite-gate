# Design Doc: automerge-gate

`pull_request.auto_merge_enabled` event を起点に、 同 SHA の全 check が完了するまで polling し、 結果を 1 つの commit status として集約する merge gate Action。

著者: azu
ステータス: Draft
作成日: 2026-05-05

---

## 背景

このリポジトリは元々 [`check-suite-gate`](./2026-05-05-check-suite-gate-design.md) として `check_suite.completed` event 駆動の集約 gate を v1 実装したが、 GitHub Actions の recursion 防止仕様により **GitHub Actions only な repo では `check_suite` event 由来の workflow が trigger されない**ことが dogfood test (#2) で実証された。 詳細は `docs/lessons/2026-05-05-check-suite-recursion-finding.md`。

v2 では起点を `pull_request.auto_merge_enabled` に切り替え、 polling ベースで集約する設計に大きく見直す。 これは:

- `pull_request` event は recursion 制約に該当しない (確実に発火)
- maintainer が "Enable Auto Merge" を押した PR だけで gate が動く (空回り削減)
- GitHub 純正 auto-merge と直結 (集約 status が緑になった瞬間 GitHub が自動 merge)

`upsidr/merge-gatekeeper` / `DataDog/ensure-ci-success` 系の polling Action と同じカテゴリだが、 **enable された PR だけ runner 占有**する点で resource 効率が良い。

## 目標

- **集約 status 1 個** を ruleset に登録するだけで運用できる (v1 と同じ)
- **Auto Merge を押した PR だけで gate が動く** (空回り削減)
- **GitHub 純正 auto-merge と直結** (集約 status が緑なら自動 merge)
- **GitHub Actions / 外部 GitHub App / legacy CI を区別なく集約**できる
- **GitHub Actions 内で完結** (外部サーバー / GitHub App 不要)
- **timeout 到達時の挙動を選択可能** (failure / pending)

## 非目標

- 直接 merge する機能 (gate が緑になったら GitHub 純正 auto-merge が動く前提)
- merge queue (`merge_group`) 互換 (v3 以降の検討事項)
- fork PR からの集約 (secrets / write token の制約、 別 OSS の領域)
- 全 PR で polling (= merge-gatekeeper の挙動)。 enable された PR だけ評価する

## 設計概要

```
PR 作成 / push
  ↓
集約 commit status は書かれない (= pending、 required check として merge ブロック)
個々の CI workflows は通常通り起動 (push event)
  ↓
maintainer が "Enable Auto Merge" を押す
  ↓
GitHub が pull_request.auto_merge_enabled event を発火
  ↓
automerge-gate workflow が起動
  ↓
Loop {
  listSuitesForRef + listForSuite で同 SHA の全 check_run を取得
  ignore-apps / ignore-checks / 自分自身を除外
  全 check_run が completed か判定
    完了済 → 集約評価 → commit status 書き込み → exit
    未完了あり → poll-interval-seconds 待機 → loop 継続
}
timeout-seconds 到達 → on-timeout に従って failure or pending を書き込み → exit
  ↓
集約 status が success → GitHub 純正 auto-merge が即 merge
集約 status が failure → auto-merge ブロック (maintainer 対処)
```

利用者は `.github/workflows/automerge-gate.yaml` を 1 ファイル設置し、 ruleset で `automerge-gate/all-passed` を required 登録するだけ。

### 利用者側の YAML

```yaml
# .github/workflows/automerge-gate.yaml
name: automerge-gate

on:
  pull_request:
    types: [auto_merge_enabled]

permissions:
  statuses: write
  checks: read
  pull-requests: read
  actions: read

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: pkgdeps/automerge-gate@v1
        with:
          context: 'automerge-gate/all-passed'
          # オプション
          poll-interval-seconds: '30'
          timeout-seconds: '3600'
          on-timeout: 'failure'
          ignore-apps: 'dependabot'
          ignore-checks: 'optional-*,docs-only'
```

### ruleset 側

```hcl
resource "github_repository_ruleset" "main" {
  rules {
    required_status_checks {
      required_check {
        context = "automerge-gate/all-passed"
      }
    }
  }
}
```

`automerge-gate/all-passed` を required にすると、 「Enable Auto Merge を押すまで pending → 押した瞬間 gate が動いて評価 → 緑なら GitHub 純正 auto-merge が merge」 のフローになる。 通常の review merge をする場合は手動で merge できる (required check は green でなくても admin override 可能、 もしくは required から外す運用)。

## 動作詳細

### `pull_request.auto_merge_enabled` event の選択理由

- recursion 制約の対象外 (= 確実に trigger される)
- maintainer の意図的な signal で起動 → Renovate / Dependabot 大量 PR で空回りしない
- GitHub 純正 auto-merge との結合が自然 (enable した瞬間に gate が動き、 緑になったら GitHub が merge)
- GitHub Actions only / 外部 App 混在 / legacy CI の全環境で動く (event 自体に environment 依存がない)

採用しなかった選択肢:
- `check_suite.completed` / `check_run.completed`: recursion 制約で GitHub Actions only な repo で発火しない (v1 が頓挫した原因)
- `workflow_run.completed`: 利用者が workflow 名を明示列挙必要、 動的追従に弱い、 外部 App の checks を集約できない
- `pull_request: types: [synchronize, opened]`: 全 push で gate が起動して polling し続ける = merge-gatekeeper と同等の cost、 enable signal の利点が消える
- `status`: legacy commit status のみ拾える、 GitHub Actions の checks を拾えない

### 集約ロジック

`pull_request.auto_merge_enabled` event を受信したら、 polling loop に入る。 各 iteration で:

1. `listSuitesForRef(head_sha)` で同 SHA の全 check_suite を取得
2. 各 suite について `listForSuite(check_suite_id)` で check_run まで展開
3. フィルタを順に適用:
   - `ignore-apps` (suite.app.slug 一致の suite 配下を全除外)
   - `ignore-checks` (check_run.name の glob 一致を除外)
   - 自分自身の除外 (gate workflow 自身の check_run、 後述)
4. 残った check_run が全部 `status === 'completed'` なら集約評価へ進む、 そうでなければ `poll-interval-seconds` 待機して loop 継続

集約評価:

- 全部 `success` / `skipped` / `neutral` → 集約 status は **success**
- 1 個でも `failure` / `cancelled` / `timed_out` / `action_required` → **failure**
- conclusion `null` (未報告) → そもそも completed ではないので polling 継続

GitHub Docs の「About status checks」 標準解釈を踏襲。 自前で再定義しない。

### polling timeout の挙動

`timeout-seconds` (default 3600 = 60 分) を超えても全 check が完了しなければ、 `on-timeout` 設定に従って終了:

- `on-timeout: failure` (default) — 集約 status を **failure** で書き込む。 GitHub 純正 auto-merge は failure を見て自動 merge を諦める。 maintainer は CI を再実行 / fix push / Auto Merge を解除して手動対処
- `on-timeout: pending` — 集約 status を pending のまま放置 (新たに書き込まない)。 必要なら maintainer が disable→enable で再起動

なお polling 中の workflow run は GitHub Actions の job の `timeout-minutes` (default 360 = 6 時間) でも切られる。 `timeout-seconds` は `job.timeout-minutes * 60` 以下にすべき。

### 自分自身の除外

集約結果は commit status として書く (check_run ではない)。 commit status は check_suite に含まれないため自己ループは構造的に発生しない。

ただし polling 中、 gate workflow 自体が走っている GitHub Actions App の check_suite は `status: in_progress` のままで、 その suite 配下に gate workflow の job check_run (= GitHub Actions が自動生成する build-in check) が含まれる。 これを集約に含めると永久に未完了判定になる。

対策として、 GitHub Actions suite (`app.slug == 'github-actions'`) に含まれる check_run のうち、 自 job の check_run を除外する:

- 環境変数 `GITHUB_RUN_ID` を action 内で取得
- 各 check_run の `details_url` (`https://github.com/owner/repo/actions/runs/{run_id}/job/{job_id}`) から run_id を抽出
- `run_id == GITHUB_RUN_ID` の check_run は自 job として除外

(v1 と同じロジック。 そのまま流用可能)

### race condition / concurrency 対策

`pull_request.auto_merge_enabled` event は 1 PR で複数回発火する可能性がある (maintainer が disable→enable を繰り返す)。 各起動で polling が走ると runner が無駄に消費される。 利用者側で:

```yaml
concurrency:
  group: automerge-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true
```

を設定して、 後続の起動が前の polling を cancel するように推奨する。 README の例にも明記。

API の eventual consistency への対策: polling loop の各 iteration が独立に listSuitesForRef を叩くので、 trigger 直後にまだ check_suite が表示されない短時間ウィンドウは自然に解消する (次の poll で取得できる)。

API call 失敗対策: listSuitesForRef / listForSuite / createCommitStatus の各呼び出しは 5xx exponential backoff retry (3 回) を入れる。 4xx は即時 throw。

### path filter / skip された check の扱い

monorepo で path filter により workflow が skip された場合、 GitHub は該当 workflow に対する check_suite を生成しないか、 conclusion `skipped` の check_run を作る。 前者なら listSuitesForRef のレスポンスに現れない、 後者なら success として扱う (GitHub 標準解釈)。 どちらでも自然に動作する。

### Auto Merge の有効/無効状態と gate の関係

`pull_request.auto_merge_enabled` で gate が起動した後、 polling 中に maintainer が Auto Merge を disable したらどうなるか:

- gate workflow は polling を継続 (auto_merge 状態は確認しない)
- 集約 status を最終的に書き込む (success / failure / pending のいずれか)
- maintainer が disable している間は GitHub 純正 auto-merge は動かないので、 集約 status が緑でも merge されない (= 期待通りの挙動)
- 後で再 enable すると gate が再起動し、 既に集約 status が書かれていれば即 GitHub が判断する (gate 自体は再 polling するが、 短時間で完了する想定)

つまり gate は auto_merge の現状を care せず、 ただ「enable された signal を受けたら集約評価する」 だけ。 シンプル。

## API 仕様

### inputs

| 名前 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `context` | no | `automerge-gate/all-passed` | 書き込む commit status の context 名 |
| `poll-interval-seconds` | no | `30` | check 状態を再 fetch する間隔 (秒) |
| `timeout-seconds` | no | `3600` | 全 check 完了を待つ timeout (秒)、 デフォルト 60 分 |
| `on-timeout` | no | `failure` | timeout 到達時の挙動。 `failure` / `pending` |
| `ignore-apps` | no | (空) | カンマ区切り。 これらの App slug の check_run を集約から除外 |
| `ignore-checks` | no | (空) | カンマ区切り。 check_run name の glob (`*` / `?` 対応、 `/` 越え可) で除外 |
| `token` | no | `${{ github.token }}` | API token |

### outputs

| 名前 | 説明 |
|---|---|
| `state` | 書き込んだ status の state (`pending` / `success` / `failure`) |
| `total-checks` | 観測された check_run 総数 (フィルタ前) |
| `evaluated-checks` | フィルタ後に評価対象となった check_run 数 |
| `completed-checks` | completed だった check_run 数 |
| `polled-iterations` | polling loop の繰り返し回数 (timeout 分析用) |

### 内部実装

- `actions/typescript-action` template ベース
- TypeScript + esbuild で bundle した JavaScript Action
- `runs.using: node24`
- `@octokit/rest` で listSuitesForRef / listForSuite / createCommitStatus
- Node.js 標準の `path.matchesGlob` で `ignore-checks` の glob 評価 (外部依存なし)
- 状態は持たない (各 invocation 独立、 polling は in-memory のみ)

### permissions

```yaml
permissions:
  statuses: write     # commit status を書く
  checks: read        # listSuitesForRef / listForSuite
  pull-requests: read # PR メタデータ取得
  actions: read       # 自 job の check_run 識別 (details_url 経由)
```

### v1 から流用するモジュール

`pkgdeps/check-suite-gate` v1 (このリポの archive 済み実装) からそのまま再利用:

- `src/conclusion.ts` — green/red/pending classifier (GitHub-standard verdict)
- `src/filter.ts` — ignore-apps / ignore-checks フィルタ (`/`-flatten + path.matchesGlob)
- `src/self-exclusion.ts` — 自 job の除外 (details_url 正規表現)
- `src/api.ts` — listSuitesForRef + listForSuite + retry ヘルパー
- `src/inputs.ts` — input parser (parseList, token 必須チェック)
- `__tests__/` の各ユニットテスト

書き換えが必要なモジュール:

- `src/aggregator.ts` — 通常モード / 救出モード分岐を削除し、 polling 用の単純な「全完了 + 緑/赤評価」 に
- `src/status.ts` — `target_url` の組み立て対象を変える (pending 中は polling workflow run page に向ける)
- `src/index.ts` — entry point の event 判定と polling loop を書き直す
- `action.yml` — name / inputs / outputs を v2 に
- `.github/workflows/test-self.yml` — `auto_merge_enabled` ベースに書き換え (新仕様で実 PR で dogfood する)

## 配布 / リリースフロー

v1 と同じ。 `actions/typescript-action` template の `script/release` で major moving tag (`v1`) を運用、 `dist/index.js` を git に commit、 PR の CI で `npm run build` 後 `git diff --exit-code dist/` で整合性確認。

詳細は v1 spec の「配布 / リリースフロー」 セクションを参照。 v2 でも同じ。

## テスト戦略

### 1. ユニットテスト (vitest + nock or msw)

集約ロジック / polling 制御を mock で網羅。 v1 既存テストに追加:

- polling loop の正常系 (1 回目で全完了 / 数回 loop して全完了)
- timeout 到達時に on-timeout=failure で failure 書き込み
- timeout 到達時に on-timeout=pending で書き込み無し
- poll 間隔の sleep (fake timer)
- API 5xx 時の retry / 4xx 時の即時 throw

### 2. self-hosting integration test

このリポ自身に gate を効かせて、 maintainer が "Enable Auto Merge" を押した実 PR で集約 status が書き込まれることを観測する。 v1 では check_suite event の制約で動かなかったが、 v2 は recursion 制約に該当しないので動くことを実証できる。

## トレードオフと制約

### 設計上のトレードオフ

- **enable された PR だけ runner 占有** — merge-gatekeeper の polling を「全 PR」 から「enable された PR」 に絞ることで cost を 1/N に抑える設計。 ただしゼロにはならない。 大量に enable した PR が同時並列するとそれぞれが runner を占有し続ける
- **polling 自体は merge-gatekeeper と同じ runner 占有モデル** — `poll-interval-seconds × iterations × 1 分 (Actions の課金単位)` の billable minutes を消費。 default 30 秒 × 60 分なら最大 60 分 ≒ 60 billable minutes / 1 PR
- **集約評価は polling loop 内のみ** — enable していない PR では集約 status は書かれない (= pending のまま)。 通常 review merge を併用する運用では admin override か required check の解除が必要
- **monorepo の動的 workflow に追従できる** — workflow_run と違い、 集約は「同 SHA に存在する全 check_suite」 を見るので、 後から workflow が追加されても自動で拾う

### 既知の制約

- **GitHub Actions ファイルが default branch にないと event は発火しない**: gate workflow の最初の有効化は通常通り 1 度 main に merge する必要がある
- **fork PR では base repo 側の event 動作が制限される**: secrets / write token が出ないため、 fork PR からは gate を動かせない (v1 と同じ)
- **runner が物理死した場合**: polling loop の途中で runner が落ちると集約 status は書かれず pending のまま。 GitHub Actions の枠内では完全保証できない。 maintainer が disable→enable で再起動するか、 別の event (`pull_request.synchronize` 併用) で再評価する手も検討余地あり (v2 では入れない)
- **legacy commit status イベント**: 自前で `repos/{owner}/{repo}/statuses/{sha}` を直接叩く外部 CI (Atlantis / Jenkins 等) は check_suite に含まれない場合がある。 polling 中に listSuitesForRef では取れない。 v3 検討事項
- **`workflows: ["*"]` の workflow_run filter サポート無し**: もし v3 で workflow_run と併用するなら利用者が明示列挙する必要がある

## 既存解との比較

### vs `upsidr/merge-gatekeeper`

merge-gatekeeper は polling 型で、 通常の `pull_request: synchronize` 等で起動する。 全 PR で全 CI 完了まで runner を占有する。

automerge-gate は polling 自体は同じだが、 **`auto_merge_enabled` で起動するため enable された PR だけが対象**。 通常の review merge / draft PR / merge 意図のない PR では runner を占有しない。

merge-gatekeeper のメンテ縮退・v1.2.0 同名 job バグの代替候補にもなる。

### vs `DataDog/ensure-ci-success`

DataDog 製の polling Action。 構造は merge-gatekeeper と類似。 同じく全 PR で polling する設計。

automerge-gate は起動 trigger が `auto_merge_enabled` に絞られている点が異なる。 input 設計 (`poll-interval-seconds`, `timeout-seconds`, `on-timeout`) は ensure-ci-success / merge-gatekeeper の慣習を踏襲。

### vs `re-actors/alls-green`

alls-green は同一 workflow 内の job のみ集約 (`needs:` + `if: always()`)。 multi-workflow には対応できない。

automerge-gate は workflow ファイル分割を維持しつつ、 全 check_run を集約できる。 alls-green の multi-workflow + auto-merge 連携版という位置付け。

### vs `pascalgn/automerge-action`

pascalgn は集約ではなく直接 merge する別カテゴリ。 多重 event listen (`pull_request` / `pull_request_review` / `check_suite` / `status`) で reactive に動く。 GitHub 純正 auto-merge を補完するか代替する。

automerge-gate は merge は GitHub 純正 auto-merge に任せ、 集約 status を書くだけに専念する。 責務が分離されているので combine 可能。

### vs `check-suite-gate` (v1)

このリポの v1 archive 済み実装。 `check_suite.completed` event を起点にしたが、 GitHub Actions の recursion 防止仕様で発火せず、 GitHub Actions only な monorepo で動かなかった。

automerge-gate は `auto_merge_enabled` event に切り替えることで recursion 制約を回避し、 同じ「集約 status を 1 個書く」 ゴールを達成する。 v1 の knowledge (集約ロジック / フィルタ / self-exclusion) はそのまま流用。

## 段階的な開発

v1 では monorepo (private repo / fork PR なし) 用途に絞った最小実装でリリースする。 inputs は `context`, `poll-interval-seconds`, `timeout-seconds`, `on-timeout`, `ignore-apps`, `ignore-checks`, `token` の 7 個。 race / retry / 自己参照ループ防止 / polling loop は実装する。

v2 で `pull_request.synchronize` 併用 (push されたら polling を再起動)、 fork PR 対応 (`pull_request_target` 連携)、 `merge_group` event 対応、 `required-apps` / `required-checks` の追加、 legacy status event のハンドリング、 dashboard 用 outputs 拡張を検討する。

v3 で Cloudflare Worker 版 webhook gate との互換 protocol を検討。

## リスクとオープン課題

- `pull_request.auto_merge_enabled` event の payload に必要な情報 (head_sha / pull_request.number) が含まれているか実測確認 (公式 docs では含まれている前提だが、 v1 で同じ前提を実測せず失敗した経緯があるため empirical に確認する)
- polling 中に Auto Merge が disable された場合の挙動: gate は polling を継続するが、 集約 status が書かれた時点で GitHub 純正 auto-merge は動かない (期待通り)。 ただし API call が無駄になる可能性 → v2 で `pulls.get` を併用して auto_merge 状態を確認 → disable されていれば early-exit、 を検討
- timeout 到達時に commit status が書き込まれた直後、 さらに別 event で再評価される仕組みが無い (v1 の救出モードに相当する機構が無い)。 timeout 後は maintainer が手動対処する前提
- self-hosting integration test が auto_merge_enabled で動くか実測確認 (v1 で dogfood が前提で動いたかを確認しなかった反省)

## 参考

- [pull_request webhook event activity types - GitHub Docs](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request) — `auto_merge_enabled` / `auto_merge_disabled` の仕様
- [Automatically merging a pull request - GitHub Docs](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request)
- [Events that trigger workflows - GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [About status checks - GitHub Docs](https://docs.github.com/en/articles/about-status-checks)
- [upsidr/merge-gatekeeper](https://github.com/upsidr/merge-gatekeeper)
- [DataDog/ensure-ci-success](https://github.com/DataDog/ensure-ci-success)
- [re-actors/alls-green](https://github.com/re-actors/alls-green)
- [pascalgn/automerge-action](https://github.com/pascalgn/automerge-action)
- [peter-evans/enable-pull-request-automerge](https://github.com/peter-evans/enable-pull-request-automerge)
- v1 spec (このリポ): `docs/superpowers/specs/2026-05-05-check-suite-gate-design.md`
- v1 post-mortem (このリポ): `docs/lessons/2026-05-05-check-suite-recursion-finding.md`
