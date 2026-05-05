# 学び: `check_suite` event は GitHub Actions only な repo では trigger されない

著者: azu
日付: 2026-05-05
ステータス: v1 設計の前提が崩れた根本原因の記録

## 結論

`check_suite.completed` event を起点に GitHub Actions workflow を起動する設計は、 **GitHub Actions 単独 repo (= 外部 GitHub App が check_run を作らない repo) では動かない**。

このリポジトリの v1 実装はこの前提を見落としており、 dogfood test PR で実証された (test-self.yml は 1 度も発火しなかった)。

## 原因

GitHub Actions 公式 docs ([Events that trigger workflows / check_suite](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#check_suite)):

> To prevent recursive workflows, this event does not trigger workflows if the check suite was created by GitHub Actions or if the check suite's head SHA is associated with GitHub Actions.

`check_run` event にも完全に同じ文が書かれている。 つまり:

| event | recursion 制約 |
|---|---|
| `check_suite` | GitHub Actions 起源 / GitHub Actions associated SHA は不可 |
| `check_run` | 同上 |
| `workflow_run` | なし (これだけが GitHub Actions only 環境で確実に動く) |
| `status` | なし |

加えて community discussion [#26169](https://github.com/orgs/community/discussions/26169) で:

> `check_suite` events only trigger when created by GitHub Apps, not from standard workflows or OAuth tokens.

つまり check_suite event を起点とする workflow は、 **GitHub Apps の世界向け**に設計されている。 GitHub Actions だけで完結する用途には `workflow_run` を使うのが GitHub の design intent。

## 何を見落としたか

brainstorming の段階で `workflow_run` vs `check_suite` を比較したとき、 起動回数 (workflow file 数 vs App 数) と「外部 App の check も自然に拾える」 メリットだけを評価した。 公式 docs の **2 つ目の制約 (head SHA associated with GitHub Actions)** を読まなかった。 advisor も呼ばずに spec を確定させた。

具体的なアンチパターン:

- 「on: check_suite を listen する OSS が一定数ある」 = 動く根拠としては弱い (それらの大半は GitHub Apps 経由で webhook を受ける運用が前提だった)
- spec の比較表で `pascalgn/automerge-action` が「check_suite を使う既存例」 と書いていたが、 これも GitHub App としての運用が現実
- 公式 docs に書いてある制約を一次資料として確認していなかった

## 動作する条件 (理論上)

| 環境 | 動作 |
|---|---|
| GitHub Actions のみ (monorepo + Renovate / Dependabot) | ❌ 動かない |
| GitHub Actions + Cloudflare Pages bot | ⭕ 動く可能性 (CF Pages 起源の suite が trigger) |
| GitHub Actions + Codecov / Renovate App / 独自 GitHub App | ⭕ 動く可能性 |
| 外部 App + GitHub Actions だが「同 SHA に GitHub Actions の workflow_run が紐付く」 | △ 「associated with」 の解釈次第、 empirical 確認要 |

empirical 確認をしていないため、 「外部 App と並走する場合に本当に発火するか」 は未検証。 spec のメインターゲット (= GitHub Actions only な monorepo) では確実に動かない。

## 起動回数の比較 (1 PR あたり、 典型 monorepo)

| event | 起動回数 |
|---|---|
| `workflow_run` | workflow file 数 ≈ 9 |
| `check_suite` | App 数 ≈ 3-5 |
| `check_run` | job 数 ≈ 20+ |
| `status` | legacy status 数 ≈ 0-3 |

`check_run` は起動回数も多く制約も同じで、 メリットがない。 GitHub Actions only 環境で確実に発火するのは `workflow_run` のみ。

## 設計の意味と次の選択肢

このリポジトリの v1 は archive する。 再起動するなら 3 通り:

- **A: `workflow_run` event ベースに再設計** — 起動回数は workflow file 数だけ増えるが確実に動く。 `merge-gatekeeper` の polling よりは大幅に軽い。 `re-actors/alls-green` の multi-workflow 版という位置付けは保てる
- **B: GitHub App 化** — Cloudflare Worker + GitHub App として実装、 webhook を直接受ける。 `check_suite` event の制約を完全に回避でき、 GitHub Actions の課金もゼロ。 ただし App 登録 / key 管理 / ホスティングが必要 (= 重い)
- **C: 別 repo で v2 を始める** — v1 の commit 履歴が誤った前提に基づくため、 履歴を引き継がず別 repo で再起動する選択肢もある

どれを選んでも、 「GitHub Actions 公式 docs を一次資料として確認する」 「brainstorming で advisor を呼んで前提を cross-check する」 のは spec 確定前に必須。

## 参考

- [Events that trigger workflows - GitHub Docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Triggering a workflow - GitHub Docs](https://docs.github.com/actions/using-workflows/triggering-a-workflow)
- [community discussion #26169 - on: check_suite never triggers, why?](https://github.com/orgs/community/discussions/26169)
- [community discussion #25702 - Push from Action does not trigger subsequent action](https://github.com/orgs/community/discussions/25702)
- このリポジトリの spec: `docs/superpowers/specs/2026-05-05-check-suite-gate-design.md`
- このリポジトリの plan: `docs/superpowers/plans/2026-05-05-check-suite-gate-implementation.md`
- dogfood test PR (発火しなかった証拠): https://github.com/pkgdeps/check-suite-gate/pull/2
