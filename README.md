# automerge-gate

A GitHub Action that aggregates all check_run results on the same commit into a single commit status, started by the maintainer pressing **"Enable Auto Merge"** on a pull request. Once aggregated to green, GitHub's native auto-merge fires and merges the PR.

This is the successor to [`pkgdeps/check-suite-gate`](https://github.com/pkgdeps/check-suite-gate) (v1, archived). The v1 design used `check_suite.completed` as the trigger but was blocked by GitHub's recursion guard for that event in repos that only run GitHub Actions. v2 switches to `pull_request.auto_merge_enabled`, which has no recursion guard, and adds a polling loop bounded by the workflow job's `timeout-minutes`.

## How it works

```
PR opened / push / reopened
   ↓
automerge-gate writes a pending commit status
   ("Awaiting Auto Merge enable")
   → register this context as a required check, and the PR is merge-blocked
   ↓
maintainer presses "Enable Auto Merge"
   ↓
GitHub fires pull_request.auto_merge_enabled
   ↓
automerge-gate runs a polling loop:
   listSuitesForRef + listForSuite for the PR head SHA
   filter ignore-apps / ignore-checks / its own check_run
   if every remaining run is completed → write success/failure → exit
   else → sleep poll-interval-seconds → poll again
   (the job's `timeout-minutes` bounds total runtime)
   ↓
status turns green → GitHub native auto-merge fires
status turns red    → auto-merge is blocked
```

## Usage

```yaml
# .github/workflows/automerge-gate.yaml
name: automerge-gate

on:
  pull_request:
    types: [opened, synchronize, reopened, auto_merge_enabled]

permissions:
  statuses: write
  checks: read
  pull-requests: read
  actions: read

concurrency:
  group: automerge-gate-${{ github.event.pull_request.number }}
  cancel-in-progress: true

jobs:
  gate:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: pkgdeps/automerge-gate@v1
        with:
          context: 'automerge-gate/all-passed'
          ignore-apps: |
            dependabot
            renovate
          ignore-checks: |
            optional-*
            docs-only
            ci / lint
```

Then register `automerge-gate/all-passed` as a required status check in your ruleset / branch protection. The PR will be merge-blocked until a maintainer presses "Enable Auto Merge" and the gate writes a success status.

## Inputs

| name | required | default | description |
|---|---|---|---|
| `context` | no | `automerge-gate/all-passed` | Commit status context name. Must match the required check in your ruleset. |
| `poll-interval-seconds` | no | `30` | How often to re-fetch check status |
| `ignore-apps` | no | (empty) | GitHub App slugs to exclude. Comma-separated **or newline-separated** |
| `ignore-checks` | no | (empty) | check_run name patterns to exclude (glob `*` / `?`). Comma-separated **or newline-separated** |
| `token` | no | `${{ github.token }}` | GitHub token |

The polling loop has no internal timeout. Bound it via the job's `timeout-minutes` (10 minutes is recommended for typical CI).

## Outputs

| name | description |
|---|---|
| `state` | `pending` / `success` / `failure` |
| `total-checks` | Number of check_runs observed before filtering |
| `evaluated-checks` | Number of check_runs after filters |
| `completed-checks` | Number of completed check_runs after filters |
| `polled-iterations` | Number of polling iterations (0 in pending mode) |

## Why this design

- **`pull_request.auto_merge_enabled` has no recursion guard** unlike `check_suite.completed`, so the gate reliably fires on GitHub-Actions-only repos.
- **Polling is gated by an explicit signal** (Enable Auto Merge), so PRs the maintainer hasn't yet decided to merge don't burn runner minutes. Compared with merge-gatekeeper, which polls on every PR push, the resource cost scales with merge intent rather than with PR throughput.
- **The aggregated result is a commit status, not a check_run**, so there's no self-referencing loop in the github-actions check_suite — the gate doesn't see its own writes when it polls.
- **GitHub native auto-merge handles the merge itself** once the aggregated status turns green. This Action does not call `pulls.merge`.
- **No internal timeout** — relies on the job's `timeout-minutes`, keeping the action's surface minimal.

## Limitations

- **Fork PRs** are not supported — secrets and write tokens behave differently across base/fork boundaries.
- **Merge queue (`merge_group`)** is not supported in v1.
- **Dead runner / job timeout**: if the runner is killed mid-polling (job hits `timeout-minutes`, dies physically, etc.), the commit status remains as it was last written (`pending`). The maintainer can disable then re-enable Auto Merge to re-trigger.
- **Legacy commit status events**: third-party CI that writes via the legacy commit status API may not appear in `check_suite` and would not be aggregated. v2 does not handle the `status` event.

## v1 (archived)

The previous version of this Action under the name `check-suite-gate` is preserved in the git history of this repository. The post-mortem on why it didn't work (Japanese) is in [`docs/lessons/2026-05-05-check-suite-recursion-finding.md`](docs/lessons/2026-05-05-check-suite-recursion-finding.md). The v1 spec and plan are also kept under `docs/superpowers/specs/` and `docs/superpowers/plans/` for reference.

## License

MIT
