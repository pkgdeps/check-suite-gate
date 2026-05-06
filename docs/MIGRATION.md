# Migrating from v2 to v3

v3 replaces the v2 two-job mutex pattern (`main-gate` / `fork-gate`) with a single-job pattern, splits the action into two configurations (private / public), and renames the input `gate` → `gate-mode`. This is a hard break: v2 workflows fail at startup on v3 because the input value `main` / `fork` is rejected.

The full design rationale lives in [`docs/superpowers/specs/2026-05-06-v3-single-job-design.md`](superpowers/specs/2026-05-06-v3-single-job-design.md).

## TL;DR

1. Decide whether your repo accepts external fork PRs.
2. Replace the v2 two-job workflow with one of the two single-job configurations below.
3. Rename `gate: main` → `gate-mode: 'private'` (or `gate: fork` → `gate-mode: 'public'`).
4. Branch protection's required check name (`automerge-gate/all-passed`) does not change.

## Input mapping

| v2 | v3 | notes |
|---|---|---|
| `gate: main` | `gate-mode: 'private'` | hard rename — values changed too |
| `gate: fork` | `gate-mode: 'public'` | hard rename — values changed too |
| `context` | `context` | unchanged; private-mode only in v3 |
| `poll-interval-seconds` | `poll-interval-seconds` | unchanged |
| `ignore-apps` | `ignore-apps` | unchanged |
| `ignore-checks` | `ignore-checks` | unchanged |
| `token` | `token` | unchanged |

If you keep the v2 input shape, the action exits at startup with:

```
input `gate-mode` must be "private" or "public" (got: "main"). If migrating from v2: gate: main → gate-mode: private, gate: fork → gate-mode: public.
```

## If you used the v2 `main-gate` job (no fork PRs)

Your repository never receives external fork PRs (private repo, internal-only org, etc.). The `fork-gate` job in your v2 workflow was always skipped.

### Before (v2)

```yaml
name: automerge-gate

on:
  pull_request:
    types: [opened, synchronize, reopened, auto_merge_enabled]
  pull_request_review:
    types: [submitted]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  main-gate:
    if: >-
      github.event.pull_request.head.repo.id == github.event.pull_request.base.repo.id
      && (github.event_name != 'pull_request_review' || github.event.review.state == 'approved')
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      checks: write
      pull-requests: read
      actions: read
    steps:
      - uses: pkgdeps/automerge-gate@v2.1.0
        with:
          gate: main
          context: 'automerge-gate/all-passed'

  fork-gate:
    if: >-
      github.event.pull_request.head.repo.id != github.event.pull_request.base.repo.id
      && (github.event_name != 'pull_request_review' || github.event.review.state == 'approved')
    name: automerge-gate/all-passed
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      checks: read
      pull-requests: read
      actions: read
    steps:
      - uses: pkgdeps/automerge-gate@v2.1.0
        with:
          gate: fork
```

### After (v3, private)

```yaml
name: automerge-gate

on:
  pull_request:
    types: [opened, synchronize, reopened, auto_merge_enabled]
  pull_request_review:
    types: [submitted]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

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
          gate-mode: 'private'
          context: 'automerge-gate/all-passed'
```

What changed:

- `fork-gate` job removed.
- `main-gate` renamed to `gate` with the cross-repo `head.repo.id` mutex condition stripped out (it's now redundant — there's only one job).
- `gate: main` → `gate-mode: 'private'`.
- Action ref bumped to `v3.0.0`.

## If you used the v2 `fork-gate` job (accepts fork PRs)

Your repository accepts external fork PRs. In v2 the `main-gate` ran for same-repo PRs (writing the aggregated check_run) and the `fork-gate` ran for fork PRs (signal via job exit code). v3 forces a single mode for the whole repo.

For fork-accepting repos, **pick `public`** — `GITHUB_TOKEN` is read-only on fork PRs, so the action can't write a check_run there. v3 public mode handles same-repo and fork PRs uniformly via the gate job's own check_run conclusion.

### Before (v2)

Same as the snippet above (the v2 README recommended both jobs together — the mutex picked the right one per PR).

### After (v3, public)

```yaml
name: automerge-gate

on:
  pull_request:
    types: [opened, synchronize, reopened, auto_merge_enabled]

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  gate:
    name: automerge-gate/all-passed   # must match the required check in your ruleset
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      checks: read
      pull-requests: read
      actions: read
    steps:
      - uses: pkgdeps/automerge-gate@v3.0.0
        with:
          gate-mode: 'public'
```

What changed:

- Both v2 jobs replaced by one `gate` job.
- `pull_request_review` trigger dropped — public mode always polls and never skips, so there's no Approve-as-skip-suppressor logic to drive (Approve sticky is private-only in v3).
- Job `name:` is set to `automerge-gate/all-passed` — same as v2's `fork-gate` job. The required check evaluates the gate job's own check_run, so its name has to match.
- `permissions.checks: read` (no API write).
- `gate: fork` → `gate-mode: 'public'`.
- The `head.repo.id` mutex is gone.

## Behaviour differences worth knowing

### 1. No more `pending` check_run write

v2 (post `v2.1.0` hotfix) wrote a `status: queued` check_run before polling, and also wrote one on `synchronize`/`opened` events that had no merge intent yet, so the required check had a yellow-dot signal in the PR UI.

v3 does **not** write a check_run when there is no merge intent. The required check stays at GitHub's default `Expected — Waiting for status to be reported`. This is functionally equivalent — merge stays blocked the same way — and saves one API write per non-merge-intent push. See [`docs/lessons/2026-05-06-check-run-pending-state-mapping.md`](lessons/2026-05-06-check-run-pending-state-mapping.md) §5.

### 2. No more main/fork race condition

v2's two-job mutex had a race ([issue #17](https://github.com/pkgdeps/automerge-gate/issues/17)): when `auto_merge_enabled` fired, the fork-gate job in the new suite would land its `skipped` check_run before the main-gate finished polling, and that `skipped` (treated as passing for required-check evaluation) could race ahead of the actual verdict and let an unfinished PR auto-merge. The `v2.1.0` hotfix worked around it with a queued pre-write before polling.

v3 has a single job per workflow run, so the race is structurally impossible — there is only one source of truth for the required check, and it cannot collide with itself. The `v2.1.0` hotfix is no longer needed and is dropped from v3.

### 3. Approve sticky is private-only

v2 honored a sticky Approve from a write-permission reviewer: pushing a new commit after Approve would re-run the gate without needing to re-Approve. v3 keeps this behaviour in private mode (Approve is one of the merge-intent triggers that takes the run from `skip` to `polling`).

In public mode, every triggering event polls — there is no `skip` path — so the "sticky" concept does not apply. The gate runs and reports its verdict on every push regardless of review state.

## Branch protection / required check name

The required check name is unchanged: `automerge-gate/all-passed`. Don't touch your ruleset.

## Action ref bump

Pin to a fixed v3 tag: `uses: pkgdeps/automerge-gate@v3.0.0`. There is no moving major tag.
