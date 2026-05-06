# Architecture

This document captures the design rationale for automerge-gate — why each major design choice was made, and what alternatives were rejected. For usage, see the [README](../README.md).

## Why this design

- **`pull_request.auto_merge_enabled` has no recursion guard** unlike `check_suite.completed`, so the gate reliably fires on GitHub-Actions-only repos.
- **Polling is gated by an explicit signal** in private mode (Enable Auto Merge or a write-permission Approve), so PRs the maintainer hasn't yet decided to merge don't burn runner minutes. Compared with merge-gatekeeper, which polls on every PR push, the resource cost scales with merge intent rather than with PR throughput. In public mode, the read-only token forces the simpler "always poll" model — there's no way to write a "waiting" signal back to the required check.
- **Single-job pattern.** The verdict reaches the required check through exactly one path per configuration: in private mode the action writes a check_run named to match the required check; in public mode the job's `name:` is the required-check context and its exit code is the conclusion. There's no self-referencing loop because the action filters out check_runs from its own workflow.
- **Check_run instead of commit status.** Commit statuses are append-only per SHA, so the same SHA's pending → success/failure transition stacks two entries; the Checks API lets the gate PATCH a single check_run by id, keeping the PR UI to one row per SHA.
- **GitHub native auto-merge handles the merge itself** once the required check turns green. This Action does not call `pulls.merge`.
- **No internal timeout input** — timeout is managed by the job's `timeout-minutes`. Having two timeouts to keep in sync (action input vs job-level) is a footgun, so the action delegates fully. There's exactly one knob, and it's a standard GitHub Actions feature.

## Cost model: private vs public vs merge-gatekeeper

The three approaches differ in *when* they consume runner minutes. For a PR with N pushes and M reviews, the table below counts how many gate jobs run end-to-end (including poll loops).

| Approach                  | Runs gate on                              | Gate jobs per PR | Fork PRs |
| ------------------------- | ----------------------------------------- | ---------------- | -------- |
| `gate-mode: private`      | merge-intent only (Enable Auto Merge or write-permission Approve) | 1–3              | not supported |
| `gate-mode: public`       | every workflow trigger (push, sync, Approve) | N + M + 1        | supported |
| upsidr/merge-gatekeeper   | every `pull_request` event                | N (≈ every push) | supported |

### Why private mode can defer polling

In private mode the action holds a write token and reports the verdict by PATCHing a `check_run` with the required-check name. Absence of that check_run is itself a blocking signal — the required check stays "Expected" until the action runs, so it's safe to skip on events without merge intent. Polling only starts once the maintainer signals intent (auto-merge or approving review), which is also when waiting actually matters.

### Why public mode can't defer

Public mode relies on a read-only token, so the gate signal is the *job's exit code*. Exit 0 means success; there is no exit code that means "still waiting, please re-run later." If the job is skipped on a trigger, the required check would either be missing (blocking forever) or stale-green from a previous run. The gate therefore must run — and poll — on every trigger that GitHub re-evaluates branch protection on. This matches merge-gatekeeper's cost profile, which is the price of fork PR support.

### When to pick which

- **`private`** — internal repos where cost matters (paid runners, large org) and fork PRs aren't accepted. Polling scales with merge intent, not PR churn.
- **`public`** — OSS repos that accept fork PRs. Higher runner cost is the trade-off for not requiring a write token from the fork's workflow.
