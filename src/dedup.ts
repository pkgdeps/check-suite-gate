import { matchesAnyRule, type AggregatedCheckRun } from './filter.js'
import type { CheckRule } from './inputs.js'

// Deduplicates check_runs to the latest run per check, for runs matching
// the `dedup-checks` rules. Workflows using `cancel-in-progress: true`
// can leave a cancelled check_run on the head SHA next to a fresh
// same-named run in a different check_suite (e.g. a workflow triggered
// by both `push` and `pull_request`). The Checks API's `filter=latest`
// default only collapses duplicates within one suite; this module covers
// the cross-suite case, which would otherwise turn the aggregate red on
// a superseded cancellation.
//
// Pure function — no I/O. Logging of dropped runs happens in the gates.

export type DedupDrop = {
  run: AggregatedCheckRun
  supersededBy: AggregatedCheckRun
}

export type DedupResult = {
  // Input order preserved: winners stay at their original positions.
  kept: AggregatedCheckRun[]
  dropped: DedupDrop[]
}

// Runs are grouped per (app, workflow file, check name). The workflow
// path is part of the key because the same job name can legitimately
// exist in several workflows on one SHA (the monorepo pattern documented
// in README "Discovering what to ignore") — grouping by name alone would
// collapse those distinct checks and could discard a genuine failure.
// JSON.stringify of a tuple is collision-free regardless of what
// characters appear in slugs, paths, or names.
const groupKey = (run: AggregatedCheckRun): string =>
  JSON.stringify([run.app.slug, run.workflow_path ?? null, run.name])

// A run only enters the dedup pool when a rule matches it AND its group
// key is trustworthy. For github-actions runs that requires a resolved
// `workflow_path` (a string) — with the path unresolved (undefined) or
// unresolvable (null, e.g. token lacks `actions: read`), grouping would
// degrade to (app, name) and risk the cross-workflow collapse described
// above. Mirroring ruleMatches' conservative-by-default stance, such
// runs pass through untouched. Third-party Checks have no workflow file,
// so their `null` path is genuinely N/A and (app, name) grouping is
// correct for them.
const isPoolEligible = (
  run: AggregatedCheckRun,
  rules: CheckRule[]
): boolean => {
  if (!matchesAnyRule(rules, run)) return false
  if (run.app.slug === 'github-actions') {
    return typeof run.workflow_path === 'string'
  }
  return true
}

// Keeps the run with the highest check_run id per group. GitHub's own
// required-check evaluation resolves duplicate-named check_runs the same
// way (see docs/lessons/2026-05-06-check-run-pending-state-mapping.md
// §2–§3): ids are assigned monotonically at creation, and re-runs create
// new rows with higher ids, so max-id is "most recently created" even
// when an older suite is re-run after a newer one started.
export const dedupToLatest = (
  runs: AggregatedCheckRun[],
  rules: CheckRule[]
): DedupResult => {
  if (rules.length === 0) return { kept: runs, dropped: [] }

  const winners = new Map<string, AggregatedCheckRun>()
  for (const run of runs) {
    if (!isPoolEligible(run, rules)) continue
    const key = groupKey(run)
    const current = winners.get(key)
    if (current === undefined || run.id > current.id) {
      winners.set(key, run)
    }
  }

  const kept: AggregatedCheckRun[] = []
  const dropped: DedupDrop[] = []
  for (const run of runs) {
    if (!isPoolEligible(run, rules)) {
      kept.push(run)
      continue
    }
    const winner = winners.get(groupKey(run))
    if (winner === undefined || winner === run) {
      kept.push(run)
    } else {
      dropped.push({ run, supersededBy: winner })
    }
  }
  return { kept, dropped }
}
