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

A reference of the GitHub APIs and events evaluated across v1 → v4 — both as
gate signals and as triggers — with the constraints that drove each adoption or
rejection.

### Trigger mechanisms (what causes the gate to run)

| Trigger                                                         | Description                | Status in this action | Key constraints                                                                                                            |
| --------------------------------------------------------------- | -------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `check_suite.completed`                                         | fires when a suite ends    | rejected              | GitHub Actions' recursion guard: suites created by GitHub Actions don't trigger workflows in the same repo (lessons §3–§5) |
| `check_run.completed`                                           | fires when a run ends      | rejected              | same recursion guard                                                                                                       |
| `workflow_run`                                                  | fires when a workflow ends | rejected              | more indirect than `pull_request` events with no offsetting benefit                                                        |
| `pull_request` (opened/synchronize/reopened/auto_merge_enabled) | standard PR events         | **adopted**           | reliable, covers all user-driven events                                                                                    |
| `pull_request_review` (submitted)                               | fires on review submission | **adopted (private)** | used as a merge-intent signal via Approve                                                                                  |
| `status`                                                        | fires on commit status     | rejected              | risk of recursion if we ever write a status from the gate                                                                  |

### Gate signal mechanisms (how the verdict reaches the required check)

| Mechanism     | API                                                                | Adoption                           | Key constraints / properties                                                                                                                               |
| ------------- | ------------------------------------------------------------------ | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| commit status | `POST /repos/{o}/{r}/statuses/{sha}`                               | **v1 / v4 (private mode)**         | states: pending / success / error / failure only; no markdown; needs `statuses: write`; **no suite concept → race is structurally impossible**             |
| check_run     | `POST /check-runs`                                                 | v2 / v3 (private mode)             | markdown output, `details_url`, PATCH-by-id; needs `checks: write`; **GitHub auto-assigns the run to a check_suite — sometimes the wrong one (issue #21)** |
| JOB exit code | none — the action's exit code becomes the JOB check_run conclusion | **v2 fork-gate / v3+ public mode** | works with read-only fork tokens; requires job `name:` to equal the required-check context; success/failure only; no skip path (so always polls)           |

### check_run state / conclusion availability

See lessons 2026-05-06 §1 and §2 for why some values are reserved.

| Value                                                                                                     | Usable from third-party actions? | Notes                                                        |
| --------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------ |
| `status: queued`                                                                                          | yes                              | yellow dot                                                   |
| `status: in_progress`                                                                                     | yes                              | yellow spinner                                               |
| `status: completed`                                                                                       | yes                              | terminal, requires `conclusion`                              |
| `status: waiting` / `pending` / `requested`                                                               | **no (422)**                     | reserved for GitHub Actions internal use                     |
| `conclusion: success` / `failure` / `cancelled` / `neutral` / `skipped` / `timed_out` / `action_required` | yes                              | seven values                                                 |
| `conclusion: stale`                                                                                       | **no (422)**                     | reserved — GitHub uses it to retire old check_runs on re-run |

### Concurrency strategies

| Strategy                    | Behavior                                 | Trade-off                                                                   |
| --------------------------- | ---------------------------------------- | --------------------------------------------------------------------------- |
| `cancel-in-progress: true`  | cancels older runs when a new run starts | cancelled JOB check_runs can pollute the rollup state (observed in v2 / v3) |
| `cancel-in-progress: false` | older runs complete, new runs queue      | serialized — slow when events arrive in bursts                              |
| unspecified                 | all runs execute in parallel             | higher runner cost, possible conflicts                                      |

This action uses `${{ github.workflow }}-${{ github.ref }}` as the concurrency
group with `cancel-in-progress: true` — the same pattern merge-gatekeeper uses.
The v4 commit-status mechanism is unaffected by cancellation because the status
is keyed by `(SHA, context)`.

### Structural pitfalls

| Constraint                                                                                               | Impact                                                                                                |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| GitHub Actions' recursion guard suppresses `check_suite` / `check_run` events from its own runs          | workflows triggered by those events don't run in GHA-only repos                                       |
| Fork PRs receive a read-only `GITHUB_TOKEN`                                                              | API writes are blocked — only the JOB exit code can carry the verdict                                 |
| `octokit.rest.checks.create` auto-assigns to a `check_suite` (internal logic is not documented)          | API-created check_runs can land on an unintended suite, leaving `mergeable_state=BLOCKED` (issue #21) |
| PRs opened by GitHub Actions don't fire `pull_request.opened` (recursion protection)                     | bot-opened PRs don't run the gate until a maintainer enables auto-merge                               |
| Commit status is keyed by `(SHA, context)` — same-context writes are append-only with the latest visible | race-free as a gate signal, but no rich UI (markdown, etc.)                                           |
