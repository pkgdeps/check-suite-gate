# check-suite-gate

> ## ⚠️ Status: archived — does not work as designed
>
> This repository is preserved for the design record and the implementation reference. It does not function as a usable Action. Read this section before reading the rest of the README.
>
> ### What was attempted
>
> A GitHub Action that listens for `check_suite.completed` events and writes a single aggregated commit status to the same SHA. The intent was to give monorepos a "register one required status, let it dynamically follow whatever workflows / external CI / GitHub Apps exist on a PR" experience — a multi-workflow successor to [`re-actors/alls-green`](https://github.com/re-actors/alls-green), without the runner-occupying polling cost of [`upsidr/merge-gatekeeper`](https://github.com/upsidr/merge-gatekeeper).
>
> ### Why it does not work
>
> GitHub Actions has a hard restriction on the `check_suite` (and `check_run`) trigger that the design overlooked. From [Events that trigger workflows / check_suite](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#check_suite):
>
> > To prevent recursive workflows, this event does not trigger workflows if the check suite was created by GitHub Actions **or if the check suite's head SHA is associated with GitHub Actions.**
>
> The same wording appears verbatim under `check_run`. Two consequences:
>
> 1. **The check suite GitHub Actions itself produces never triggers a downstream workflow.** Any `on: check_suite` workflow listening to its own ci.yml's completion will never fire.
> 2. **The "associated head SHA" clause likely extends the restriction to suites created by other GitHub Apps**, as long as the same SHA also has GitHub Actions activity on it. This was not empirically narrowed down here, but the [community discussion #26169](https://github.com/orgs/community/discussions/26169) consensus is that `on: check_suite` is effectively only useful when consumed by an external GitHub App via webhooks, not by an Actions workflow listening for it.
>
> The empirical confirmation is in [#2](https://github.com/pkgdeps/check-suite-gate/pull/2): on a PR where ci.yml ran and completed successfully, the self-hosted `test-self.yml` (configured `on: check_suite: types: [completed]`) **never fired even once** — `event=check_suite` shows zero workflow runs in the API. The aggregated commit status was never written.
>
> ### Where this leaves the design
>
> The recursion guard is by design and applies to both `check_suite` and `check_run`. The events that *do* trigger workflows in a GitHub-Actions-only repo are:
>
> | event | runs per PR (typical monorepo) | recursion guard | viable here? |
> |---|---|---|---|
> | `workflow_run` | one per workflow file (≈ 9) | none | ✅ |
> | `check_suite` | one per GitHub App (≈ 3-5) | yes | ❌ |
> | `check_run` | one per job (≈ 20+) | yes | ❌ |
> | `status` | one per legacy commit status (≈ 0-3) | none | ✅ for legacy CI only |
>
> So `workflow_run` is the only event that could carry this design forward. It costs more billable minutes than `check_suite` would have (one trigger per workflow file rather than per App), but spec-style aggregation across separate workflow files remains achievable. A re-implementation along those lines would also need to lose the "external GitHub App checks like Cloudflare Pages get aggregated for free" benefit, since `workflow_run` only fires on Actions workflows.
>
> Alternatively, this could be re-implemented as an **external GitHub App** receiving `check_suite` webhooks directly (Cloudflare Worker / Probot / similar). Webhooks have no recursion guard. This trades the "no external infrastructure" goal for correctness.
>
> ### What was learned
>
> The mistake in the brainstorming phase was reading only the first half of the `check_suite` event description and reasoning from the trigger-count table without verifying the `or if the check suite's head SHA is associated with GitHub Actions` clause against an empirical test. A 30-minute dogfood PR before locking in the spec would have surfaced this. The post-mortem in Japanese is in [docs/lessons/2026-05-05-check-suite-recursion-finding.md](docs/lessons/2026-05-05-check-suite-recursion-finding.md).
>
> ### What remains useful here
>
> The implementation under `src/` is well-tested (49 unit tests, TDD-driven) and could be salvaged by anyone re-attempting this with `workflow_run`. Modules worth keeping: `conclusion.ts` (GitHub-standard verdict mapping), `filter.ts` (App + glob exclusions, with `path.matchesGlob` and `/`-flatten), `self-exclusion.ts` (own-run identification via `details_url` regex), `aggregator.ts` (normal vs rescue mode), `api.ts` (octokit wrapper with retries and pagination). The wiring in `index.ts` would need to be rewritten for the new event surface.
>
> ---
>
> The rest of this README is the original v1 documentation, kept as-is for reference. **Do not use this Action.** The `dist/index.js` is published but inert — no event ever invokes it.
>
> ---

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
