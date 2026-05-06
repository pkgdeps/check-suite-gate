# Architecture

This document captures the design rationale for automerge-gate — why each major design choice was made, and what alternatives were rejected. For usage, see the [README](../README.md).

## Why this design

- **`pull_request.auto_merge_enabled` has no recursion guard** unlike `check_suite.completed`, so the gate reliably fires on GitHub-Actions-only repos.
- **Polling is gated by an explicit signal** in private mode (Enable Auto Merge or a write-permission Approve), so PRs the maintainer hasn't yet decided to merge don't burn runner minutes. Compared with merge-gatekeeper, which polls on every PR push, the resource cost scales with merge intent rather than with PR throughput. In public mode, the read-only token forces the simpler "always poll" model — there's no way to write a "waiting" signal back to the required check.
- **Single-job pattern.** The verdict reaches the required check through exactly one path per configuration: in private mode the action writes a check_run named to match the required check; in public mode the job's `name:` is the required-check context and its exit code is the conclusion. There's no self-referencing loop because the action filters out check_runs from its own workflow.
- **Check_run instead of commit status.** Commit statuses are append-only per SHA, so the same SHA's pending → success/failure transition stacks two entries; the Checks API lets the gate PATCH a single check_run by id, keeping the PR UI to one row per SHA.
- **GitHub native auto-merge handles the merge itself** once the required check turns green. This Action does not call `pulls.merge`.
- **No internal timeout input** — timeout is managed by the job's `timeout-minutes`. Having two timeouts to keep in sync (action input vs job-level) is a footgun, so the action delegates fully. There's exactly one knob, and it's a standard GitHub Actions feature.
