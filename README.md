# check-suite-gate

A GitHub Action that aggregates all check results on the same commit into a single commit status, triggered by `check_suite.completed`. Designed as a **multi-workflow successor to `re-actors/alls-green`** for monorepo + Renovate environments, replacing `upsidr/merge-gatekeeper`'s polling-based design that occupies a runner for the entire CI duration.

## Why

When you require status checks via branch protection or rulesets, you have two options: either register every individual check (which breaks down as workflows are added/removed dynamically by Renovate, Dependabot, or path filters), or register a single aggregated status. This Action implements the latter for the multi-workflow case where `re-actors/alls-green` cannot help.

## Usage

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
          ignore-apps: 'dependabot[bot]'
          ignore-checks: 'optional-*,docs-only'
```

Then register `check-suite-gate/all-passed` as a required status check in your ruleset / branch protection. Newly added workflows or external CI checks are picked up automatically — no ruleset changes required.

## Inputs

| name | required | default | description |
|---|---|---|---|
| `context` | no | `check-suite-gate/all-passed` | Commit status context name |
| `ignore-apps` | no | (empty) | Comma-separated GitHub App slugs whose check_runs are excluded from aggregation |
| `ignore-checks` | no | (empty) | Comma-separated check_run name patterns to exclude. Glob (`*` / `?`) supported. `*` crosses path separators (e.g. `ci*` matches `ci / lint`) |
| `token` | no | `${{ github.token }}` | GitHub token used for API access |

## Outputs

| name | description |
|---|---|
| `state` | `pending` / `success` / `failure` |
| `total-checks` | Number of check_runs observed before filtering |
| `evaluated-checks` | Number of check_runs after filters |
| `completed-checks` | Number of completed check_runs after filters |
| `mode` | `normal` (run_attempt == 1) or `rescue` (run_attempt > 1) |

## Rescue Mode (Recovering from Stuck Status)

When the aggregated status is stuck on `pending` (e.g. a third-party GitHub App never reports back), click the aggregated status in the PR's Checks UI. This opens the gate workflow's run page where you can press **"Re-run all jobs"**. With `run_attempt > 1`, the action enters rescue mode: incomplete check_runs are excluded from aggregation, and the verdict is decided based on the remaining ones. There is no automatic timeout — the manual escape hatch is intentional.

## Design Decisions

- **`check_suite.completed` over `workflow_run`**: triggers on every GitHub App's check_suite (typically 3-5 per PR — GitHub Actions, Cloudflare Pages, Codecov, etc.) rather than once per workflow file. Cuts billable runner-minutes roughly in half on monorepos.
- **commit status, not check_run**: the aggregated result is a commit status, not a check_run. This avoids self-referencing loops in the github-actions check_suite and keeps API call count to one per write.
- **No automatic timeout**: stuck check_suites are recovered manually via Re-run all jobs (rescue mode). Polling/cron/Environments wait-timer would add complexity and runner cost for an edge case that occurs rarely.
- **Self-job exclusion**: the action's own check_run (under github-actions app slug) is excluded by parsing `details_url` for `GITHUB_RUN_ID`.

## Comparisons

| Existing solution | Limitation |
|---|---|
| `re-actors/alls-green` | Same workflow only — cannot aggregate across workflow files |
| `upsidr/merge-gatekeeper` | Polling — occupies a runner for the full CI duration |
| `int128/wait-for-workflows-action` / `poseidon/wait-for-status-checks` / similar | Polling-based, runner-occupying |
| `pascalgn/automerge-action` | Merges directly rather than producing a status |
| Bulldozer / Kodiak / Mergify | Self-hosted or SaaS — heavier |

## Migration from `upsidr/merge-gatekeeper`

Run both gates in parallel during transition:
1. Add this Action's workflow and register `check-suite-gate/all-passed` as required.
2. Keep `merge-gatekeeper`'s required check until you've verified parity on a few PRs.
3. Remove `merge-gatekeeper` from required checks, then remove its workflow file.

## Limitations

- **Fork PRs**: not supported — secrets and write tokens behave differently across base/fork boundaries.
- **Merge queue (`merge_group`)**: not supported in v1; planned for v2.
- **Dead runner**: if the runner physically dies mid-execution, the commit status remains `pending`. Use the rescue mode (Re-run all jobs) to recover.
- **Legacy commit status events**: third-party CI that writes via the legacy commit status API may not appear in `check_suite`. Planned for v2.

## License

MIT
