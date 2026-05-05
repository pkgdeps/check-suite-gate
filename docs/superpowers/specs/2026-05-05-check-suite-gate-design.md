# Design Doc: check-suite-gate

GitHub Actions 上で動く、 `check_suite.completed` を起点に「同一 commit 上の全 check の結果を集約して 1 つの commit status を書く」 merge gate Action。 `alls-green` の **multi-workflow 版**として、 monorepo + Renovate 大量 PR 環境で `merge-gatekeeper` の polling コストを払わずに集約 status を提供することを目的とする。

著者: azu
ステータス: Draft
作成日: 2026-05-05

---

## 背景

Branch protection / ruleset で `Require status checks to pass before merging` を有効にする場合、 各 check (workflow / job / external CI) の context を個別に required 登録するか、 **1 個の集約 status** を required 登録するかの 2 択になる。

個別登録すると workflow / job が増減するたびに ruleset 編集が必要で、 Renovate / Dependabot が動的に check を増やす環境では破綻する。 そのため「集約 status を 1 個書く gate」 を導入する運用が一般化しているが、 既存解には全部それぞれの問題がある。

| 既存解 | 問題 |
|---|---|
| `upsidr/merge-gatekeeper` | polling 型で runner 占有、 メンテ縮退、 v1.2.0 同名 job バグ |
| `re-actors/alls-green` | 同一 workflow 内の job しか集約できない |
| 1 ci.yml に詰めるパターン | workflow file を分割できない |
| `workflow_run` gate を自作 | 1 分課金 × N 回で コスト悪化 |
| `pascalgn/automerge-action` | 集約ではなく直接 merge する別物 |
| Bulldozer / Kodiak / Mergify | 自前ホスト or SaaS 課金、 過剰機能 |
| post-hook 付き action | post action が完全保証されない、 job 全体の status を取れない |

GitHub Actions の枠内で 「集約 status 1 個・workflow 分割可能・追加課金小・polling free」 を全部満たす OSS は 2026-05 時点で存在しない。 `check_suite.completed` を起点にする集約 action がこの空白を埋められる。

## 目標

- **集約 status 1 個** を ruleset に登録するだけで運用できる
- **workflow file の分割を維持**できる (monorepo 用途)
- **GitHub Actions の追加課金は 1 PR あたり数分**まで抑える
- **polling 不要** (`merge-gatekeeper` の runner 占有を解消)
- **Renovate / Dependabot が動的に check を増やしても自動追従** する
- **GitHub Actions 内で完結** (外部サーバー / GitHub App 不要)
- **stuck したら maintainer の手動操作 1 つで救出できる** (自動 timeout は持たない)

## 非目標

- 直接 merge する機能 (gate が緑になったら GitHub 純正の auto-merge が動く前提)
- merge queue 互換 (`merge_group` event 対応は v2 以降の検討事項)
- fork PR からの集約 (GitHub の構造上 fork PR では別ハンドリングが必要、 別 OSS の領域)
- Terraform 専用 / 外部 CI 専用ロジック (Atlantis 等は別 gate を併用する想定)
- 自動 timeout (stuck 検出は maintainer の手動 Re-run で解消する設計)

## 設計概要

```
(各 workflow)
  ↓ 完了
GitHub が check_suite.completed を発火
  ↓
check-suite-gate workflow が起動
  ↓
listSuitesForRef + listForSuite API で同 SHA の全 check_run を取得
  ↓
ignore-apps / ignore-checks で除外
  ↓
全 check_run が completed か判定
  ├─ 未完了あり (run_attempt == 1): pending を書いて exit
  ├─ 未完了あり (run_attempt > 1, 救出モード): 未完了は stuck とみなして集約から除外
  └─ 全完了: 残った check_run の conclusion を AND 評価
       ├─ 全 success / skipped / neutral: success を書く
       └─ 1 個でも failure / cancelled: failure を書く
```

利用者は `.github/workflows/check-suite-gate.yaml` を 1 ファイル設置し、 ruleset で `check-suite-gate/all-passed` を required 登録するだけ。

stuck したら集約 status クリック → 開いた gate workflow run page で **"Re-run all jobs"** ボタンを押すと、 `run_attempt > 1` の救出モードで再評価される。

### 利用者側の YAML

```yaml
# .github/workflows/check-suite-gate.yaml
name: check-suite-gate

on:
  check_suite:
    types: [completed]

permissions:
  statuses: write
  checks: read
  pull-requests: read
  actions: read

concurrency:
  group: gate-${{ github.event.check_suite.head_sha }}
  cancel-in-progress: false

jobs:
  aggregate:
    runs-on: ubuntu-latest
    steps:
      - uses: pkgdeps/check-suite-gate@v1
        with:
          context: 'check-suite-gate/all-passed'
          # オプション
          ignore-apps: 'dependabot[bot]'
          ignore-checks: 'optional-*,docs-only'
```

### ruleset 側

```hcl
# Terraform
resource "github_repository_ruleset" "main" {
  rules {
    required_status_checks {
      required_check {
        context = "check-suite-gate/all-passed"
      }
    }
  }
}
```

新 workflow / job / 外部 CI を追加しても ruleset は不変。 集約 logic 側が動的追従する。

## 動作詳細

### check_suite event の選択理由

`workflow_run` ではなく `check_suite` を起点にする理由は 3 つ。

第一に、 **起動回数が劇的に減る**。 `workflow_run` は workflow ファイル数だけ発火するため 9 workflow なら 9 回 = 9 分課金になる。 一方 `check_suite` は GitHub App ごとに 1 つで、 GitHub Actions / Cloudflare Pages bot / Codecov などを合わせて典型 3-5 個。 1 PR あたり 3-5 分に削減できる。

第二に、 **GitHub Actions 以外の check も自然に集約できる**。 Cloudflare Pages の preview deployment status、 Codecov、 Renovate 自身の check など、 GitHub App ベースのものは全て check_suite として扱われる。

第三に、 **`pull_requests` array が payload に直接含まれる**。 PR 紐付けが workflow_run より素直に書ける。

### 集約ロジック

`check_suite.completed` event を受信したら、 まず `listSuitesForRef(head_sha)` で同 SHA の全 check_suite を取得する。 各 suite について `listForSuite(check_suite_id)` で check_run まで展開する。 集約の最小単位は **check_run**。

その後、 以下の順でフィルタを適用する:

1. `ignore-apps` (suite.app.slug が一致する suite 配下の check_run を全除外)
2. `ignore-checks` (check_run.name が glob 一致する check_run を除外)
3. 自分自身の除外 (本 action が書く集約 commit status は check_run ではないため list に含まれない。 加えて gate workflow 自身が走っている GitHub Actions suite 内の自 job の check_run も除外する)

残った check_run について、 「1 つでも `status !== 'completed'` なら全体 pending」 として早期 exit する。 全部 completed なら conclusion を集約評価する。

conclusion の AND 評価ルールは GitHub 標準の required check と同じ:

- `success`, `skipped`, `neutral` → 緑として扱う
- `failure`, `cancelled`, `timed_out`, `action_required` → 赤として扱う
- `null` (未報告) → pending として扱う

これは GitHub Docs の「About status checks」 で定義されている標準解釈を踏襲する。 自前で再定義しない。

### 通常モードと救出モード

`github.run_attempt` で 1 つの workflow run を 2 つのモードに分岐する。

| モード | 条件 | 振る舞い |
|---|---|---|
| 通常 | `run_attempt == 1` | 厳密集約。 未完了 check_run が 1 個でもあれば pending を書く |
| 救出 | `run_attempt > 1` | 寛容集約。 未完了 check_run は **stuck とみなして集約から除外**し、 残りの conclusion で最終評価 |

通常モードは `check_suite.completed` event で 1 度目の起動として走る。 救出モードは maintainer が PR の集約 status をクリック → gate workflow run page → **"Re-run all jobs"** ボタンを押した結果として走る。

これにより自動 timeout (cron / wait-timer / sleep / external scheduler) を一切持たずに stuck を解消できる。 PR が永久 pending で詰まっても、 maintainer の手動操作 1 つで復旧する。

### Re-run UX のための target_url

集約 commit status を書く際、 `target_url` には現在の workflow run page を埋める:

```
${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}/attempts/${GITHUB_RUN_ATTEMPT}
```

これにより、 PR の Checks UI で集約 status をクリックした maintainer は gate workflow の specific run page に着地する。 そこから「Re-run all jobs」 ボタンが届く。

### 自分自身の除外

集約結果は **check_run ではなく commit status** として書く。 commit status は check_suite に含まれないため、 `listSuitesForRef` のレスポンスに gate 自身の集約結果は混ざらない。 自己参照ループは構造的に発生しない。

ただし、 gate workflow 自身が走っている間、 GitHub Actions App の check_suite は `status: in_progress` のままで、 その suite 配下に gate workflow の job check_run (= GitHub Actions が自動生成する build-in check) が含まれる。 これを集約に含めると永久に「未完了」 と判定される。

対策として、 GitHub Actions suite (`app.slug == 'github-actions'`) に含まれる check_run のうち、 自 job の check_run を除外する。 識別は以下の方式を取る:

- 環境変数 `GITHUB_RUN_ID` を action 内で取得
- 各 check_run の `details_url` (`https://github.com/owner/repo/actions/runs/{run_id}/job/{job_id}`) から run_id を抽出
- `run_id == GITHUB_RUN_ID` の check_run は自 job として除外

### race condition 対策

複数の check_suite が並列に完了すると gate workflow が並列に起動する。 各 instance が `listSuitesForRef` を叩いて status を書く構造のため、 race の振る舞いを設計で吸収する。

`concurrency: { group: gate-${head_sha}, cancel-in-progress: false }` を設定し、 全 instance を完走させる。 各 instance は同じロジックで判定するため最終状態は idempotent に収束する。 commit status は同じ context で書けば自動上書きされるため、 race による衝突は問題にならない。

ただし API の eventual consistency で、 trigger 元 check_suite 自身が「まだ in_progress」 と返ってくる短時間ウィンドウがある。 この対策として trigger 元 suite の id を `event.payload.check_suite.id` で取得し、 listSuitesForRef のレスポンスでこの id を含み completed か確認するまで 短い retry (最大 5 回 × 2 秒) を入れる。

commit status API の write は 5xx 対策で 3 回 exponential backoff retry する。

### path filter / skip された check の扱い

monorepo で path filter により workflow が skip された場合、 GitHub は **「該当 workflow に対する check_suite を生成しない」** ことがある。 generated されない場合、 listSuitesForRef のレスポンスにそもそも現れないため、 「観測された全 suite が完了 + 緑」 で判定するロジックなら自然に問題ない。

generated されるが conclusion が `skipped` になるケースもあり、 こちらは GitHub 標準と同じく success として扱う。

`ignore-apps` で動的に増える bot (例: `dependabot[bot]`) を、 `ignore-checks` で pre-known な optional check (例: `docs-only`, `coverage-info`) を glob で除外できる。

## API 仕様

### inputs

| 名前 | 必須 | デフォルト | 説明 |
|---|---|---|---|
| `context` | no | `check-suite-gate/all-passed` | 書き込む commit status の context 名 |
| `ignore-apps` | no | (空) | カンマ区切り。 これらの App の suite 配下の check_run を集約から除外 (例: `dependabot[bot]`) |
| `ignore-checks` | no | (空) | カンマ区切り。 これらの check_run name を集約から除外。 glob (`*` / `?`) サポート (例: `optional-*,docs-only`) |
| `token` | no | `${{ github.token }}` | API 認証 token |

緑/赤の判定ルールは GitHub 標準 (`success` / `skipped` / `neutral` を緑、 残りを赤) で固定する。 v1 では `success-conclusions` 等の調整 input は持たない。

### outputs

| 名前 | 説明 |
|---|---|
| `state` | 書き込んだ status の state (`pending` / `success` / `failure`) |
| `total-checks` | 観測された check_run 総数 (フィルタ前) |
| `evaluated-checks` | フィルタ後に評価対象となった check_run 数 |
| `completed-checks` | completed だった check_run 数 |
| `mode` | `normal` / `rescue` のどちらで評価したか |

### 内部実装

- **`actions/typescript-action` template を base にする** (esbuild / vitest / ESLint / dist 整合性チェック workflow / dependabot 設定が初期から揃う)
- TypeScript + esbuild で bundle した JavaScript Action
- `runs.using: node24` (GitHub Actions が公式サポートする最新 Node.js ランタイム。 template 既定値が古ければ手動で更新)
- `@octokit/rest` で listSuitesForRef / listForSuite / createCommitStatus
- Node.js 標準の `path.matchesGlob(path, pattern)` で `ignore-checks` の glob 評価 (外部依存なし)
- 状態は持たない (各 invocation 独立、 idempotent)

### permissions

```yaml
permissions:
  statuses: write    # commit status を書く
  checks: read       # listSuitesForRef / listForSuite
  pull-requests: read # PR 関連メタデータ取得
  actions: read      # 自 job の check_run 識別 (details_url 経由)
```

## 配布 / リリースフロー

### bundle と commit

- `npm run build` (esbuild) で TypeScript を 1 ファイルに bundle した `dist/index.js` を生成
- **`dist/index.js` を git に commit する** (利用者は `node_modules` を install せずに使うため)
- `action.yml` の `runs.main: dist/index.js` で指定
- 利用者が `uses: pkgdeps/check-suite-gate@v1` で参照すると、 runner が repo を checkout して `node dist/index.js` を実行

### tag 戦略

- `v1.2.3` のような semver tag (固定、 release ごとに新規作成)
- `v1` のような major moving tag (新 patch/minor リリースのたびに同 commit を指すよう移動。 `actions/checkout@v4` 系と同じ慣習)
- 利用者は `@v1` で pin することを推奨

### major moving tag の自動更新

`actions/publish-action` を release 時の workflow で使う。 release が published されると、 release tag (例: `v1.2.3`) から major version (`v1`) tag を自動的に同じ commit に移動する。 自前で `git tag -f` を回すより安全。

将来的に GitHub の「Immutable Actions」 が GA になった段階で、 `actions/publish-immutable-action` への移行を検討する (v2 検討事項)。

### Marketplace 公開

- 初回 release 作成時に「Publish this Action to the GitHub Marketplace」 にチェック
- 1 回登録すれば以後の release は自動で marketplace 反映

### dist の整合性チェック (CI)

PR の CI で `npm run build` を実行後 `git diff --exit-code dist/` を走らせ、 source と dist が乖離していたら fail させる。 これにより「source は変えたが build を忘れた PR」 を検出する。

## テスト戦略

2 段で組む。

### 1. ユニットテスト (vitest + nock or msw)

集約ロジックを octokit の network を mock して網羅する。 対象:

- conclusion AND 評価 (success / skipped / neutral / failure / cancelled / timed_out / action_required / null)
- `ignore-apps` フィルタ
- `ignore-checks` の glob match
- 自 job 除外ロジック (details_url からの run_id 抽出と一致)
- 通常モード vs 救出モード分岐 (`run_attempt` で振る舞いが変わること)
- eventual consistency retry (trigger 元 suite が in_progress のまま帰ってきた場合の retry 回数)
- commit status 書き込みの 5xx exponential backoff retry
- target_url 文字列の組み立て

### 2. self-hosting integration test

この repo 自身に gate を効かせて実 CI で動作確認する。 `.github/workflows/test-self.yml` で本 action を `uses: ./` で実行し、 PR 上で集約 status が書かれることを観測する。 dogfooding 兼 reg test。

## トレードオフと制約

### 設計上のトレードオフ

`check_suite` を起点とすることで `workflow_run` より起動回数を減らせるが、 完全には 1 分にならない。 GitHub Actions の課金が 1 分切り上げのため、 3-5 個の suite が完了するごとに各 1 分課金される。 1 ci.yml + 1 集約 job のパターンなら 1 分で済むが、 workflow file 分割を維持したい場合は妥協する。

集約 status を ruleset に登録する設計のため、 「個別の check が PR ページに見える」 メリットは GitHub UI 標準の checks タブに任せる。 集約 status は merge ブロックの判定にのみ使う。

自動 timeout を持たない代わりに、 stuck したら maintainer の手動 Re-run が必要になる。 滅多に起きない事象に複雑な仕掛け (cron / wait-timer / external scheduler) を持ち込むより、 status クリック → Re-run の手動オペレーションで救出する方がトータルの実装・運用コストが小さいと判断した。

### 既知の制約

- **GitHub Actions ファイルが default branch にないと workflow_run 系 event は発火しない**。 これは GitHub Actions の仕様で、 gate workflow の最初の有効化は通常通り 1 度 main に merge する必要がある。
- **fork PR では base repo 側の event 動作が制限される**。 secrets が解決されない / write token が出ないケースがあり、 fork PR からの集約は現状サポート外。 OSS で fork PR を受ける用途では、 別途 `pull_request_target` 系の workflow と組み合わせる必要がある。
- **post action が走らない条件と同じく、 runner が物理死した場合 status は pending のまま固まる**。 GitHub Actions の枠内ではこれを完全保証できない。 stuck したら手動 Re-run で救出する。
- **check_suite は GitHub App 単位**。 自前で `repos/{owner}/{repo}/statuses/{sha}` で書かれる legacy commit status は check_suite に含まれない場合がある。 Atlantis や Jenkins が legacy status API を直接叩く場合は別途 `status` event でハンドリングが必要 (v2 検討事項)。

## 既存解との比較

### vs `re-actors/alls-green`

alls-green は同一 workflow 内の job のみ集約できる。 `needs:` で `if: always()` の集約 job を作る方式。 1 ci.yml に全部詰めるなら最適だが、 workflow ファイル分割環境では使えない。

check-suite-gate は **workflow ファイルを分割したまま集約できる**。 alls-green の multi-workflow 拡張版という位置付け。

### vs `upsidr/merge-gatekeeper`

merge-gatekeeper は polling 型で「全 check 完了まで自分が runner を占有して待つ」 動作。 30 分の CI なら 30 分課金。 メンテ縮退、 v1.2.0 同名 job バグも残っている。

check-suite-gate は event 駆動で、 各起動は数十秒で終わる (1 分課金)。 メンテも GitHub 公式 API のみに依存する。

stuck 検出は merge-gatekeeper の polling timeout に対して、 maintainer の手動 Re-run で代替する。 滅多に起きない事象に runner 占有のコストを払い続けるより合理的と判断。

### vs `workflow_run` gate を自作

workflow_run は workflow ファイル数だけ発火するため 1 PR あたり N 分課金。 9 workflow なら 9 分。 check_suite なら App 数 (典型 3-5) で済むため約半減。 GitHub Actions 以外の check も自然に集約される利点もある。

### vs CF Worker webhook gate

CF Worker 版なら GitHub Actions 課金がゼロ、 動的 check 追従が完全、 任意のロジックを書ける。 ただし GitHub App 登録、 PKCS#8 key 管理、 Cloudflare Worker / D1 セットアップが必要で、 数百行の実装コストが乗る。

check-suite-gate は **GitHub Actions 内で完結する** ため `.github/workflows/check-suite-gate.yaml` 1 ファイルで導入できる。 CF Worker 版を書く前段として、 もしくは「外部サービスを増やしたくない」 ユーザー向けの選択肢として位置付ける。

## 段階的な開発

v1 では monorepo (private repo / fork PR なし) 用途に絞った最小実装でリリースする。 オプションは `context`, `ignore-apps`, `ignore-checks`, `token` のみ。 race / retry / 自己参照ループ防止 / Re-run 救出モードは実装する。 自動 timeout は持たない。

v2 で fork PR 対応 (`pull_request_target` 連携)、 `merge_group` event 対応、 `required-apps` / `required-checks` / `success-conclusions` の追加、 legacy status event のハンドリング、 dashboard 用 outputs 拡張を検討する。

v3 で Cloudflare Worker 版 webhook gate との互換 protocol を定義し、 「重い repo は CF Worker、 軽い repo は check-suite-gate」 の使い分けを統一 config で表現できるようにする。

## リスクとオープン課題

GitHub の `check_suite` event 仕様は **完全に文書化されていない部分**があり、 特に「いつ check_suite が新規作成されるか」 「path filter で skip された workflow が check_suite を生成するか」 「自 job の check_run の `details_url` フォーマットは安定か」 は実測する必要がある。 v0.1.0 を draft で公開後、 self-hosting テストで挙動を観察する想定。

GitHub 自身が将来 `check_suite` の挙動を変更する可能性は常にあり、 その場合は実装側の追従が必要。

`merge-gatekeeper` のような polling 型から本 action に移行する場合、 「移行中は両方 required にする」 「片方 disable」 などの段階的移行手順を README に記載する。

## 参考

- check_suite event 公式仕様: https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#check_suite
- check suite REST API: https://docs.github.com/en/rest/checks/suites
- listSuitesForRef API: https://docs.github.com/en/rest/checks/suites#list-check-suites-for-a-git-reference
- listForSuite API: https://docs.github.com/en/rest/checks/runs#list-check-runs-in-a-check-suite
- About status checks (conclusion 解釈): https://docs.github.com/en/articles/about-status-checks
- re-actors/alls-green: https://github.com/re-actors/alls-green
- upsidr/merge-gatekeeper: https://github.com/upsidr/merge-gatekeeper
- pascalgn/automerge-action (check_suite を使う既存例): https://github.com/pascalgn/automerge-action
- jdpx/check-group (Probot 系の集約 App): https://github.com/jdpx/check-group
- community discussion #75568 (`needs:` 集約 pattern): https://github.com/orgs/community/discussions/75568
