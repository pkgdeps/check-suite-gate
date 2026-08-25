import { describe, it, expect } from 'vitest'
import { dedupToLatest } from '../src/dedup.js'
import { aggregate } from '../src/aggregator.js'
import type { AggregatedCheckRun } from '../src/filter.js'

// Unlike filter.test.ts's factory, ids and suites must vary here — the
// whole subject under test is "which of several same-named runs wins".
// Default: a completed+success github-actions run with a resolved
// workflow path; suite_id defaults to id so cross-suite duplicates just
// need distinct ids.
const make = (o: {
  id: number
  name: string
  app?: string
  suite?: number
  status?: string
  conclusion?: string | null
  workflowPath?: string | null
}): AggregatedCheckRun => ({
  id: o.id,
  name: o.name,
  status: o.status ?? 'completed',
  conclusion: o.conclusion === undefined ? 'success' : o.conclusion,
  details_url: '',
  app: { slug: o.app ?? 'github-actions' },
  suite_id: o.suite ?? o.id,
  workflow_path:
    o.workflowPath === undefined ? '.github/workflows/ci.yaml' : o.workflowPath
})

describe('dedupToLatest', () => {
  it('is a no-op when no rules are configured', () => {
    const runs = [
      make({ id: 1, name: 'build', conclusion: 'cancelled' }),
      make({ id: 2, name: 'build' })
    ]
    const result = dedupToLatest(runs, [])
    expect(result.kept).toBe(runs)
    expect(result.dropped).toEqual([])
  })

  it('keeps only the latest run of a matched cross-suite duplicate', () => {
    // The motivating cancel-in-progress shape: same workflow, same job
    // name, two suites on one SHA — the older run cancelled, the newer
    // one green.
    const cancelled = make({ id: 10, name: 'build', conclusion: 'cancelled' })
    const fresh = make({ id: 20, name: 'build' })
    const result = dedupToLatest([cancelled, fresh], [{ workflow: 'ci.yaml' }])
    expect(result.kept).toEqual([fresh])
    expect(result.dropped).toEqual([{ run: cancelled, supersededBy: fresh }])
  })

  it('keeps the max id out of a three-run group', () => {
    const runs = [
      make({ id: 5, name: 'build', conclusion: 'cancelled' }),
      make({ id: 9, name: 'build' }),
      make({ id: 7, name: 'build', conclusion: 'failure' })
    ]
    const result = dedupToLatest(runs, [{ workflow: 'ci.yaml' }])
    expect(result.kept.map((r) => r.id)).toEqual([9])
    expect(result.dropped.map((d) => d.run.id)).toEqual([5, 7])
    expect(result.dropped.map((d) => d.supersededBy.id)).toEqual([9, 9])
  })

  it('does not collapse same-named runs from different workflows', () => {
    // Monorepo pattern: two workflows each define a `lint` job. Both are
    // genuinely distinct checks and must both stay evaluated even when an
    // app-wide rule matches them.
    const goLint = make({
      id: 1,
      name: 'lint',
      workflowPath: '.github/workflows/ci-go.yaml'
    })
    const pyLint = make({
      id: 2,
      name: 'lint',
      conclusion: 'failure',
      workflowPath: '.github/workflows/ci-python.yaml'
    })
    const result = dedupToLatest([goLint, pyLint], [{ app: 'github-actions' }])
    expect(result.kept).toEqual([goLint, pyLint])
    expect(result.dropped).toEqual([])
  })

  it('leaves unmatched duplicates untouched', () => {
    const runs = [
      make({ id: 1, name: 'build', conclusion: 'cancelled' }),
      make({ id: 2, name: 'build' })
    ]
    const result = dedupToLatest(runs, [{ workflow: 'nightly.yaml' }])
    expect(result.kept).toEqual(runs)
    expect(result.dropped).toEqual([])
  })

  it('scopes dedup to the workflow named by the rule', () => {
    const ciOld = make({ id: 1, name: 'test', conclusion: 'cancelled' })
    const ciNew = make({ id: 2, name: 'test' })
    const nightlyOld = make({
      id: 3,
      name: 'test',
      conclusion: 'cancelled',
      workflowPath: '.github/workflows/nightly.yaml'
    })
    const nightlyNew = make({
      id: 4,
      name: 'test',
      workflowPath: '.github/workflows/nightly.yaml'
    })
    const result = dedupToLatest(
      [ciOld, ciNew, nightlyOld, nightlyNew],
      [{ workflow: 'ci.yaml' }]
    )
    expect(result.kept).toEqual([ciNew, nightlyOld, nightlyNew])
    expect(result.dropped).toEqual([{ run: ciOld, supersededBy: ciNew }])
  })

  it('dedups third-party app runs by (app, name)', () => {
    // Third-party Checks have no workflow file — a null path is genuinely
    // N/A rather than unresolved, so (app, name) grouping is correct.
    const old = make({
      id: 1,
      name: 'Build',
      app: 'xcode-cloud',
      conclusion: 'cancelled',
      workflowPath: null
    })
    const fresh = make({
      id: 2,
      name: 'Build',
      app: 'xcode-cloud',
      workflowPath: null
    })
    const result = dedupToLatest([old, fresh], [{ app: 'xcode-cloud' }])
    expect(result.kept).toEqual([fresh])
    expect(result.dropped).toEqual([{ run: old, supersededBy: fresh }])
  })

  it('never pools a github-actions run with an unresolvable (null) path', () => {
    // e.g. token lacks `actions: read`: grouping would degrade to
    // (app, name) and could collapse distinct same-named checks, so both
    // runs stay evaluated instead.
    const runs = [
      make({
        id: 1,
        name: 'build',
        conclusion: 'cancelled',
        workflowPath: null
      }),
      make({ id: 2, name: 'build', workflowPath: null })
    ]
    const result = dedupToLatest(runs, [{ app: 'github-actions' }])
    expect(result.kept).toEqual(runs)
    expect(result.dropped).toEqual([])
  })

  it('never pools a github-actions run with an unresolved (undefined) path', () => {
    const old = make({ id: 1, name: 'build', conclusion: 'cancelled' })
    const fresh = make({ id: 2, name: 'build' })
    delete old.workflow_path
    delete fresh.workflow_path
    const result = dedupToLatest([old, fresh], [{ app: 'github-actions' }])
    expect(result.kept).toEqual([old, fresh])
    expect(result.dropped).toEqual([])
  })

  it('keeps a pending latest run so the aggregate stays pending', () => {
    // The live cancel-in-progress race: the superseded run is already
    // cancelled while its replacement is still running. Dedup must keep
    // the replacement so polling continues instead of failing on the
    // cancellation.
    const cancelled = make({ id: 1, name: 'build', conclusion: 'cancelled' })
    const running = make({
      id: 2,
      name: 'build',
      status: 'in_progress',
      conclusion: null
    })
    const result = dedupToLatest(
      [cancelled, running],
      [{ workflow: 'ci.yaml' }]
    )
    expect(result.kept).toEqual([running])
    expect(aggregate(result.kept).state).toBe('pending')
  })

  it('preserves input order, with winners at their original positions', () => {
    const a = make({ id: 1, name: 'other' })
    const oldBuild = make({ id: 2, name: 'build', conclusion: 'cancelled' })
    const b = make({ id: 3, name: 'another' })
    const newBuild = make({ id: 4, name: 'build' })
    const result = dedupToLatest(
      [a, oldBuild, b, newBuild],
      [{ app: 'github-actions', name: 'build' }]
    )
    expect(result.kept).toEqual([a, b, newBuild])
  })

  it('AND-evaluates rule fields when selecting the pool', () => {
    // Only xcode-cloud's Build duplicates collapse; github-actions'
    // same-named duplicates don't match the rule and stay untouched.
    const xcodeOld = make({
      id: 1,
      name: 'Build',
      app: 'xcode-cloud',
      conclusion: 'cancelled',
      workflowPath: null
    })
    const xcodeNew = make({
      id: 2,
      name: 'Build',
      app: 'xcode-cloud',
      workflowPath: null
    })
    const actionsOld = make({ id: 3, name: 'Build', conclusion: 'cancelled' })
    const actionsNew = make({ id: 4, name: 'Build' })
    const result = dedupToLatest(
      [xcodeOld, xcodeNew, actionsOld, actionsNew],
      [{ app: 'xcode-cloud', name: 'Build' }]
    )
    expect(result.kept).toEqual([xcodeNew, actionsOld, actionsNew])
    expect(result.dropped).toEqual([{ run: xcodeOld, supersededBy: xcodeNew }])
  })
})
