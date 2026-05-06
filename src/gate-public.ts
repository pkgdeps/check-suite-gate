import * as core from '@actions/core'
import type { ParsedInputs } from './inputs.js'
import type { RunDeps } from './run-deps.js'
import { fetchAllCheckRuns, createWorkflowPathLookup } from './api.js'
import { applyFilters } from './filter.js'
import {
  excludeOwnWorkflowRuns,
  parseCurrentWorkflowPath
} from './self-exclusion.js'
import { pollUntilComplete } from './polling.js'

export const runPublic = async (
  deps: RunDeps,
  inputs: ParsedInputs
): Promise<void> => {
  const { octokit, context, env } = deps
  const sha = context.pr.head.sha

  let lastTotal = 0
  let lastEvaluated = 0
  let lastCompleted = 0

  const currentWorkflowPath = parseCurrentWorkflowPath(env.workflowRef)
  const lookupWorkflowPath = createWorkflowPathLookup(
    octokit,
    context.owner,
    context.repo
  )

  const fetchRuns = async () => {
    try {
      const all = await fetchAllCheckRuns(
        octokit,
        context.owner,
        context.repo,
        sha
      )
      lastTotal = all.length
      const filtered = applyFilters(all, inputs.ignoreApps, inputs.ignoreChecks)
      const afterSelf = await excludeOwnWorkflowRuns(
        filtered,
        currentWorkflowPath,
        lookupWorkflowPath
      )
      lastEvaluated = afterSelf.length
      lastCompleted = afterSelf.filter((r) => r.status === 'completed').length
      return afterSelf
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      core.warning(`API fetch failed during polling (will retry): ${message}`)
      throw err
    }
  }

  core.startGroup('Polling')
  const result = await pollUntilComplete(fetchRuns, {
    intervalSeconds: inputs.pollIntervalSeconds,
    onIteration: (s) =>
      core.info(
        `Poll #${s.iteration}: state=${s.state}, ${s.completed}/${s.total} completed`
      )
  })
  core.endGroup()

  // Step summary mirrors gate-private's shape so users with mixed
  // private/public repos see consistent output in $GITHUB_STEP_SUMMARY.
  // Public mode has no skip path, so the state set here is exactly
  // what `pollUntilComplete` returned.
  const stateEmoji =
    result.state === 'success' ? '✅' : result.state === 'failure' ? '❌' : '🟡'
  await core.summary
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
    .write()

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
