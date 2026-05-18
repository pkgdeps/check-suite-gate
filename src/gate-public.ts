import * as core from '@actions/core'
import type { ParsedInputs } from './inputs.js'
import type { RunDeps } from './run-deps.js'
import { fetchAllCheckRuns, createWorkflowPathLookup } from './api.js'
import {
  applyFilters,
  hasWorkflowQualifiedPattern,
  type AggregatedCheckRun
} from './filter.js'
import {
  excludeOwnWorkflowRuns,
  parseCurrentWorkflowPath,
  resolveWorkflowPaths
} from './self-exclusion.js'
import { pollUntilComplete } from './polling.js'
import {
  formatCheckResults,
  formatPollBody,
  formatPollTitle
} from './check-results.js'

export const runPublic = async (
  deps: RunDeps,
  inputs: ParsedInputs
): Promise<void> => {
  const { octokit, context, env } = deps
  const sha = context.pr.head.sha

  let lastTotal = 0
  let lastEvaluated = 0
  let lastCompleted = 0
  let lastRuns: AggregatedCheckRun[] = []

  const currentWorkflowPath = parseCurrentWorkflowPath(env.workflowRef)
  const lookupWorkflowPath = createWorkflowPathLookup(
    octokit,
    context.owner,
    context.repo
  )

  const needsWorkflowPath = hasWorkflowQualifiedPattern(inputs.ignoreChecks)

  const fetchRuns = async () => {
    try {
      const all = await fetchAllCheckRuns(
        octokit,
        context.owner,
        context.repo,
        sha
      )
      lastTotal = all.length
      const enriched = needsWorkflowPath
        ? await resolveWorkflowPaths(all, lookupWorkflowPath)
        : all
      const filtered = applyFilters(
        enriched,
        inputs.ignoreApps,
        inputs.ignoreChecks
      )
      const afterSelf = await excludeOwnWorkflowRuns(
        filtered,
        currentWorkflowPath,
        lookupWorkflowPath
      )
      lastEvaluated = afterSelf.length
      lastCompleted = afterSelf.filter((r) => r.status === 'completed').length
      lastRuns = afterSelf
      return afterSelf
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      core.warning(`API fetch failed during polling (will retry): ${message}`)
      throw err
    }
  }

  const pollStartedAt = Date.now()
  const result = await pollUntilComplete(fetchRuns, {
    intervalSeconds: inputs.pollIntervalSeconds,
    onIteration: async (s) => {
      const title = formatPollTitle({
        elapsedMs: Date.now() - pollStartedAt,
        iteration: s.iteration,
        state: s.state,
        completed: s.completed,
        total: s.total
      })
      const body = formatPollBody(lastRuns)
      await core.group(title, async () => {
        for (const line of body) core.info(line)
      })
    }
  })

  const formatted = formatCheckResults(lastRuns)
  for (const line of formatted.logLines) core.info(line)
  if (formatted.pendingCount > 0) {
    core.warning(`pending check(s) at result time: ${formatted.pendingCount}`)
  }

  // Step summary mirrors gate-private's shape so users with mixed
  // private/public repos see consistent output in $GITHUB_STEP_SUMMARY.
  // Public mode has no skip path, so the state set here is exactly
  // what `pollUntilComplete` returned.
  const stateEmoji =
    result.state === 'success' ? '✅' : result.state === 'failure' ? '❌' : '🟡'
  let s = core.summary
    .addHeading(`${stateEmoji} automerge-gate: ${result.state}`)
    .addTable([
      [
        { data: 'Field', header: true },
        { data: 'Value', header: true }
      ],
      ['gate-mode', 'public'],
      ['state', result.state],
      ['total checks (pre-filter)', String(lastTotal)],
      ['evaluated checks (post-filter)', String(lastEvaluated)],
      ['completed checks', String(lastCompleted)],
      ['polling iterations', String(result.iterations)]
    ])
  if (formatted.summaryMarkdown) {
    s = s.addRaw(formatted.summaryMarkdown)
  }
  await s.write()

  core.setOutput('state', result.state)
  core.setOutput('total-checks', String(lastTotal))
  core.setOutput('evaluated-checks', String(lastEvaluated))
  core.setOutput('completed-checks', String(lastCompleted))
  core.setOutput('polled-iterations', String(result.iterations))

  if (result.state === 'failure') {
    core.setFailed(
      `aggregated state is failure (${lastEvaluated} checks evaluated)`
    )
  } else if (result.state === 'pending') {
    core.setFailed('polling exited with pending state — unexpected')
  }
}
