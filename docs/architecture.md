# Architecture

This document captures the design rationale for automerge-gate — why each major
design choice was made, and what alternatives were rejected. For usage, see the
[README](../README.md).

## Why this design

- **`pull_request.auto_merge_enabled` has no recursion guard** unlike
  `check_suite.completed`, so the gate reliably fires on GitHub-Actions-only
  repos.
- **Polling is gated by an explicit signal** in private mode (Enable Auto Merge
  or a write-permission Approve), so PRs the maintainer hasn't yet decided to
  merge don't burn runner minutes. Compared with merge-gatekeeper, which polls
  on every PR push, the resource cost scales with merge intent rather than with
  PR throughput. In public mode, the read-only token forces the simpler "always
  poll" model — there's no way to write a "waiting" signal back to the required
  check.
- **Single-job pattern.** The verdict reaches the required check through exactly
  one path per configuration: in private mode the action writes a commit status
  whose `context` matches the required check; in public mode the job's `name:`
  is the required-check context and its exit code is the conclusion. There's no
  self-referencing loop because the action filters out check_runs from its own
  workflow.
- **Commit status (not check_run) for the private-mode signal.** v2/v3 wrote the
  gate's verdict as a `check_run` via `octokit.rest.checks.create`. Empirical
  observation (automerge-gate-example PR #28) showed GitHub assigns API-created
  check_runs to a non-deterministic check_suite — sometimes a stale GitHub
  Actions suite from the PR's first run — which re-introduced the suite-mismatch
  race that v2 was supposed to have killed. Commit status has no `check_suite`
  concept (it's keyed by `(SHA, context)` only), so the same race is
  structurally impossible. v4 reverted the gate signal to commit status; v1's
  original choice turned out to be correct for a reason v1 didn't articulate.
- **GitHub native auto-merge handles the merge itself** once the required check
  turns green. This Action does not call `pulls.merge`.
- **No internal timeout input** — timeout is managed by the job's
  `timeout-minutes`. Having two timeouts to keep in sync (action input vs
  job-level) is a footgun, so the action delegates fully. There's exactly one
  knob, and it's a standard GitHub Actions feature.

## Cost model: private vs public vs merge-gatekeeper

The three approaches differ in _when_ they consume runner minutes. For a PR with
N pushes and M reviews, the table below counts how many gate jobs run end-to-end
(including poll loops).

| Approach                | Runs gate on                                                      | Gate jobs per PR | Fork PRs      |
| ----------------------- | ----------------------------------------------------------------- | ---------------- | ------------- |
| `gate-mode: private`    | merge-intent only (Enable Auto Merge or write-permission Approve) | 1–3              | not supported |
| `gate-mode: public`     | every workflow trigger (push, sync, Approve)                      | N + M + 1        | supported     |
| upsidr/merge-gatekeeper | every `pull_request` event                                        | N (≈ every push) | supported     |

### Why private mode can defer polling

In private mode the action holds a write token and reports the verdict by
POSTing a commit status with the required-check name as `context`. Absence of
that status is itself a blocking signal — the required check stays "Expected"
until the action runs, so it's safe to skip on events without merge intent.
Polling only starts once the maintainer signals intent (auto-merge or approving
review), which is also when waiting actually matters.

### Why public mode can't defer

Public mode relies on a read-only token, so the gate signal is the _job's exit
code_. Exit 0 means success; there is no exit code that means "still waiting,
please re-run later." If the job is skipped on a trigger, the required check
would either be missing (blocking forever) or stale-green from a previous run.
The gate therefore must run — and poll — on every trigger that GitHub
re-evaluates branch protection on. This matches merge-gatekeeper's cost profile,
which is the price of fork PR support.

### When to pick which

- **`private`** — internal repos where cost matters (paid runners, large org)
  and fork PRs aren't accepted. Polling scales with merge intent, not PR churn.
- **`public`** — OSS repos that accept fork PRs. Higher runner cost is the
  trade-off for not requiring a write token from the fork's workflow.

## Approaches and constraints

v1 → v4 の開発で encountered した GitHub の API /
event 機構のうち、 gate の signal にも trigger にも使い得るものを整理する。 制約をテーブルで一覧化する。

### Trigger mechanisms (いつ gate が走るか)

| Trigger                                                         | Description              | Status in this action   | 主な制約                                                                                      |
| --------------------------------------------------------------- | ------------------------ | ----------------------- | --------------------------------------------------------------------------------------------- |
| `check_suite.completed`                                         | check_suite 完了時に発火 | 不採用                  | recursion guard: GitHub Actions が作った check_suite には trigger しない (lessons 2026-05-05) |
| `check_run.completed`                                           | check_run 完了時に発火   | 不採用                  | 同上 (recursion 制約)                                                                         |
| `workflow_run`                                                  | 別 workflow 完了時に発火 | 不採用                  | pull_request 系より間接的、 採用利点なし                                                      |
| `pull_request` (opened/synchronize/reopened/auto_merge_enabled) | 標準 PR event            | **採用**                | 信頼性高、 user 駆動 events 全カバー                                                          |
| `pull_request_review` (submitted)                               | review 提出時            | **採用 (private only)** | Approve を merge 意図 signal として使う                                                       |
| `status`                                                        | commit status 更新時     | 不採用                  | recursion 懸念                                                                                |

### Gate signal mechanisms (gate を何で表すか)

| Mechanism     | API                                                                  | このaction での採用                | 主な制約 / 特徴                                                                                                                                                          |
| ------------- | -------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| commit status | `POST /repos/{o}/{r}/statuses/{sha}`                                 | **v1 / v4 (private mode)**         | states: pending/success/error/failure のみ; markdown 不可; permission: `statuses: write`; **suite 概念なし → race 構造的に発生不可**                                     |
| check_run     | `POST /check-runs`                                                   | v2 / v3 (private mode)             | markdown output, details_url、 PATCH-by-id 可; permission: `checks: write`; **GitHub が check_suite に自動 assign — 場合により非current suite になり stuck (issue #21)** |
| JOB exit code | (API なし — action exit code → JOB 自動生成 check_run の conclusion) | **v2 fork-gate / v3+ public mode** | fork PR で read-only token でも動く; 要 job `name:` = required check 名; success/failure のみ; skip path 不可 (= 常に polling)                                           |

### check_run の state / conclusion 制約

なぜ第三者 action から使えない値があるかは lessons 2026-05-06 §1, §2 を参照。

| 値                                                                                                        | 第三者 action から使用可? | Notes                                                        |
| --------------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------ |
| `status: queued`                                                                                          | 可                        | yellow dot                                                   |
| `status: in_progress`                                                                                     | 可                        | yellow spinner                                               |
| `status: completed`                                                                                       | 可                        | terminal、 conclusion 必須                                   |
| `status: waiting` / `pending` / `requested`                                                               | **不可 (422)**            | GitHub Actions サービス内部用                                |
| `conclusion: success` / `failure` / `cancelled` / `neutral` / `skipped` / `timed_out` / `action_required` | 可                        | 7 値                                                         |
| `conclusion: stale`                                                                                       | **不可 (422)**            | GitHub が re-run 時に古い check_run を退場させるための内部値 |

### concurrency strategies

| Strategy                    | 動作                              | trade-off                                                             |
| --------------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `cancel-in-progress: true`  | 新 run 起動時に古い run を cancel | cancelled JOB check_run が rollup state を汚す可能性 (v2 / v3 で観測) |
| `cancel-in-progress: false` | 古い run 完走、 新 run は queue   | 直列化、 多 event 時遅い                                              |
| 無指定                      | 全 run 並行                       | runner cost 増、 場合により conflict                                  |

このaction では `${{ github.workflow }}-${{ github.ref }}` group +
`cancel-in-progress: true`
(merge-gatekeeper と同じ標準 pattern) を採用。 v4 の commit status
mechanism は cancellation の影響を受けない。

### 構造的制約 (誤りやすいポイント)

| 制約                                                                                                     | 影響                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| GitHub Actions が作った check_suite/check_run event は recursion guard で自身 workflow を trigger しない | check_suite/check_run event を起点にした workflow は GHA-only repo で動かない                        |
| fork PR の `GITHUB_TOKEN` は read-only にダウングレード                                                  | fork PR で API write 不可 → JOB exit code 経由しか gate 表現できない                                 |
| `octokit.rest.checks.create` が check_suite を自動 assign (内部 logic 不透明)                            | API write の check_run が想定外の suite に landing し、 mergeable_state=BLOCKED で stuck (issue #21) |
| GHA 経由の PR は `pull_request.opened` を発火しない (recursion 防止)                                     | bot 作成 PR は `auto_merge_enabled` を maintainer が押すまで gate が走らない                         |
| commit status は `(SHA, context)` keyed、 同一 context は append-only で latest が visible state         | gate signal としては race-free、 ただし markdown 等の rich UI 不可                                   |
