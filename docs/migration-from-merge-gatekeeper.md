# Migrating from merge-gatekeeper to automerge-gate

[upsidr/merge-gatekeeper](https://github.com/upsidr/merge-gatekeeper) and automerge-gate solve the same problem: collapse "every check on the PR must pass" into a single required check, so the ruleset never has to enumerate individual checks. If you already run merge-gatekeeper, this guide maps its configuration onto automerge-gate.

merge-gatekeeper has not shipped a release since February 2023 ([upsidr/merge-gatekeeper#94](https://github.com/upsidr/merge-gatekeeper/issues/94)). automerge-gate is an actively maintained replacement with the same single-aggregated-check model.

For usage details referenced below, see the [README](../README.md).

## What changes

The two actions share the goal but differ in how the gate fires and what it reads.

|                             | merge-gatekeeper                                | automerge-gate                                                                                       |
| --------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| When it gates               | every PR push                                   | on merge intent (`private`) or every push (`public`) — see [README modes](../README.md#how-it-works) |
| Data source                 | check_runs **and** legacy commit statuses       | check_runs **only**                                                                                  |
| Merge mechanism             | the job's own check is the required check       | GitHub native auto-merge, fired when the required check turns green                                  |
| `merge_group` (merge queue) | supported                                       | **not supported**                                                                                    |
| Ignore syntax               | comma-separated list of check names (`ignored`) | JSONC array of `{ app?, workflow?, name? }` glob rules (`ignore-checks`)                             |
| Poll interval               | `interval` (seconds)                            | `poll-interval-seconds`                                                                              |
| Timeout                     | `timeout` input (seconds)                       | job `timeout-minutes` (no action input)                                                              |
| Runtime                     | container action (needs Docker on the runner)   | JavaScript action (no Docker)                                                                        |

Two of these are migration-blocking if they apply to you:

- **No merge queue.** automerge-gate does not support `merge_group`. If you merge through a GitHub merge queue, automerge-gate is not a drop-in replacement.
- **check_runs only.** automerge-gate ignores legacy commit statuses entirely. Any CI that reports only via the legacy commit-status API (some Jenkins/Atlantis setups) is not aggregated; register it as a separate required check in the ruleset alongside the gate. See [Limitations](../README.md#limitations).

## Migration steps

### Step 1: Pick a mode

merge-gatekeeper has one behavior; automerge-gate has two. Pick based on whether the repo accepts external fork PRs — see [Step 1: Pick a mode](../README.md#step-1-pick-a-mode). Internal-only repos generally want `private` (it skips polling on PRs with no merge intent and saves runner minutes); repos that take fork PRs need `public`.

### Step 2: Translate the workflow file

A typical merge-gatekeeper workflow:

```yaml
name: Merge Gatekeeper
on:
  pull_request:
  merge_group:
jobs:
  merge-gatekeeper:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    permissions:
      checks: read
      statuses: read
    steps:
      - uses: upsidr/merge-gatekeeper@v1
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          interval: 5
          timeout: 1200
          ignored: |
            optional-job,
            external-app-check
```

The `private`-mode equivalent (drop `merge_group`, add the review trigger and `auto_merge_enabled` type):

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
      github.event_name != 'pull_request_review' ||
      github.event.review.state == 'approved'
    runs-on: ubuntu-latest
    timeout-minutes: 20 # was merge-gatekeeper's `timeout: 1200`
    permissions:
      statuses: write # private mode writes the aggregate as a commit status
      checks: read
      pull-requests: read
      actions: read # only needed if ignore-checks uses a `workflow` rule
    steps:
      - uses: pkgdeps/automerge-gate@v4.1.0
        with:
          gate-mode: 'private'
          context: 'automerge-gate/all-passed'
          poll-interval-seconds: '5' # was `interval: 5`
          ignore-checks: |
            [
              { "name": "optional-job" }
            ]
```

Input mapping:

- `interval` → `poll-interval-seconds`
- `timeout: 1200` → job `timeout-minutes: 20` (the action has no timeout input on purpose; the job timeout is the single source of truth)
- `token` → `token` (same default, `${{ github.token }}`)
- `permissions: statuses: read` → `statuses: write` in `private` mode (the action _writes_ the aggregated status, not just reads it); `public` mode needs only `checks: read`

### Step 3: Translate `ignored` → `ignore-checks`

This is where most of the manual work lives. Both actions match against the **check name** (`check_run.name` — the job name, not the `Workflow / Job` string the PR UI shows), so each comma-separated entry usually becomes one `{ "name": "..." }` rule:

```yaml
# merge-gatekeeper
ignored: |
  optional-job,
  flaky-scan
```

```yaml
# automerge-gate
ignore-checks: |
  [
    { "name": "optional-job" },
    { "name": "flaky-scan" }
  ]
```

Three things change in your favor, and one entry class disappears:

- **Globs.** `name` is a glob (`*` / `?`), so a family of jobs that needed one line each can collapse into one rule: `{ "name": "build-*" }`.
- **App scoping.** Add `app` (the GitHub App slug) to ignore everything from an external app in one rule: `{ "app": "dependabot" }`, `{ "app": "renovate" }`. merge-gatekeeper had to list each check name.
- **Workflow scoping.** When the same job `name` appears in multiple workflows (a monorepo pattern), disambiguate with `workflow` (the workflow file basename): `{ "workflow": "ci-go.yaml", "name": "lint" }`. This requires `actions: read`.
- **Drop legacy-commit-status entries.** Any entry in `ignored` that named a _legacy commit status_ (not a check_run) has no equivalent — automerge-gate never sees legacy statuses, so it never needs to ignore them. Remove those entries. If such a check must still gate merges, register it as its own required check in the ruleset.

To discover the exact `name` / `app` / `workflow` values on a real PR, use the inspection command in [Discovering what to ignore](../README.md#discovering-what-to-ignore) and paste the rows you want to silence.

### Step 4: Run both in parallel (recommended), avoiding deadlock

Keep merge-gatekeeper as the required check while you validate that automerge-gate produces the same verdict. But running both unmodified **deadlocks**: merge-gatekeeper waits for every check including automerge-gate's, and automerge-gate waits for every check_run including merge-gatekeeper's — each blocks on the other.

Break the cycle by having each ignore the other for the duration of the overlap. Add a rule to automerge-gate's `ignore-checks` that drops merge-gatekeeper's job (remove it once `merge-gatekeeper.yaml` is deleted):

```jsonc
[
  { "name": "merge-gatekeeper" } // remove after merge-gatekeeper.yaml is gone
]
```

And add automerge-gate's check name to merge-gatekeeper's `ignored` list (remove it once automerge-gate is the required check):

```
ignored: |
  automerge-gate/all-passed
```

Substitute the actual job/context names your workflows use.

### Step 5: Switch the required check, then remove merge-gatekeeper

1. Register `automerge-gate/all-passed` as a required check in the ruleset — see [Step 3: Register the required check](../README.md#step-3-register-the-required-check). Note the autocomplete is empty until the gate has run once; type the name by hand.
2. Enable **Allow auto-merge** in repository settings if it is not already on — see [Step 4: Allow auto-merge](../README.md#step-4-allow-auto-merge).
3. Confirm a real PR merges via Enable Auto Merge and the gate's verdict.
4. Remove `merge-gatekeeper` from the ruleset's required checks.
5. Delete the merge-gatekeeper workflow file, and remove the temporary cross-ignore entries from Step 4.

## Behavioral differences to expect

- **Merge is opt-in (private mode).** merge-gatekeeper gates every PR continuously. In `private` mode, automerge-gate stays at GitHub's `Expected — Waiting for status to be reported` until a maintainer clicks **Enable Auto Merge** or a write-access reviewer approves; only then does it poll and post a verdict. The merge happens through GitHub's native auto-merge, not the action. If your team treats Approve as "looks good" rather than "ready to merge", drop the `pull_request_review` trigger so only Enable Auto Merge starts the gate.
- **Re-evaluation on push.** With Auto Merge enabled, pushing a new commit re-runs the gate against the new SHA automatically — no disable→enable cycle.
- **Reviews and legacy statuses are not aggregated.** Signals that surface as PR reviews (e.g. Copilot Code Review) or as legacy commit statuses never appear in the check_run feed automerge-gate reads. Enforce those as their own required checks in the ruleset.
