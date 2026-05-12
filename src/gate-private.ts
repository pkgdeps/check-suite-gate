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
import { buildTargetUrl, writeCommitStatus } from './commit-status.js'
import { determineMode, isHeadShaAction } from './mode.js'
import { hasActiveApproval } from './review-status.js'
import {
  formatCheckResults,
  formatPollBody,
  formatPollTitle
} from './check-results.js'
import type { AggregatedCheckRun } from './filter.js'

type SummaryInput = {
  state: string
  mode: string
  total: number
  evaluated: number
  completed: number
  iterations: number
  checkResultsMarkdown?: string
}

const writeSummary = async (input: SummaryInput): Promise<void> => {
  const stateEmoji =
    input.state === 'success' ? '✅' : input.state === 'failure' ? '❌' : '🟡'
  let s = core.summary
    .addHeading(`${stateEmoji} automerge-gate: ${input.state}`)
    .addTable([
      [
        { data: 'Field', header: true },
        { data: 'Value', header: true }
      ],
      ['action mode', input.mode],
      ['state', input.state],
      ['total checks (pre-filter)', String(input.total)],
      ['evaluated checks (post-filter)', String(input.evaluated)],
      ['completed checks', String(input.completed)],
      ['polling iterations', String(input.iterations)]
    ])
  if (input.checkResultsMarkdown) {
    s = s.addRaw(input.checkResultsMarkdown)
  }
  await s.write()
}

export const runPrivate = async (
  deps: RunDeps,
  inputs: ParsedInputs
): Promise<void> => {
  const { octokit, context, env } = deps
  const { eventName, action, pr, reviewState, owner, repo } = context
  const { runId, runAttempt, serverUrl, repository, workflowRef } = env

  core.startGroup('Setup')
  core.info(`Event: ${eventName} (action=${action})`)
  core.info(`PR #${pr.number}, head SHA ${pr.head.sha}`)

  const sha = pr.head.sha
  const targetUrl = buildTargetUrl({
    serverUrl,
    repository,
    runId,
    runAttempt
  })

  // Approve is a sticky merge-intent signal: once a write-permission
  // reviewer Approves, every subsequent push should re-evaluate
  // (= polling), not fall through to skip. We query review state to
  // see if any Approve is still active. Two cases need this lookup:
  //
  //   - HEAD SHA event with auto-merge off — to detect a previously
  //     standing Approve and stay polling on new pushes.
  //   - pull_request_review.submitted — to verify the reviewer has
  //     write access. The webhook payload's author_association is
  //     not a reliable proxy: a read-only COLLABORATOR has the same
  //     association as a maintainer, so we re-check via API.
  //
  // auto_merge_enabled doesn't need this lookup (auto-merge is a
  // sufficient merge-intent signal on its own).
  const isHeadShaEvent = isHeadShaAction(action)
  const needsApprovalLookup =
    (isHeadShaEvent && pr.auto_merge === null) ||
    eventName === 'pull_request_review'
  const isApproved = needsApprovalLookup
    ? await hasActiveApproval(octokit, owner, repo, pr.number)
    : false

  const { mode, reason } = determineMode({
    eventName,
    action,
    reviewState,
    isHeadShaEvent,
    isAutoMergeAlreadyEnabled: pr.auto_merge !== null,
    isApproved
  })

  core.info(`Mode: ${mode} — ${reason}`)
  core.endGroup()

  if (mode === 'skip') {
    // The skip rationale is already logged at INFO above ("Mode: skip
    // — <reason>"). Don't double-log it as a warning: drive-by reviews
    // and other expected skips would otherwise raise yellow ⚠ icons in
    // the workflow run UI for a non-issue.
    await writeSummary({
      state: 'skipped',
      mode: 'skip',
      total: 0,
      evaluated: 0,
      completed: 0,
      iterations: 0
    })
    return
  }

  // mode === 'polling'

  let lastTotal = 0
  let lastEvaluated = 0
  let lastCompleted = 0
  let lastRuns: AggregatedCheckRun[] = []

  const currentWorkflowPath = parseCurrentWorkflowPath(workflowRef)
  const lookupWorkflowPath = createWorkflowPathLookup(octokit, owner, repo)

  const fetchRuns = async () => {
    try {
      const allRuns = await fetchAllCheckRuns(octokit, owner, repo, sha)
      lastTotal = allRuns.length
      const afterFilters = applyFilters(
        allRuns,
        inputs.ignoreApps,
        inputs.ignoreChecks
      )
      const afterSelf = await excludeOwnWorkflowRuns(
        afterFilters,
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

  // Polling has no internal timeout. The job's timeout-minutes will kill
  // this run if checks take too long; on timeout no aggregate commit
  // status gets written, and the required-check context is reported by
  // GitHub as the default `Expected — Waiting for status to be reported`
  // until the next push or `auto_merge_enabled` event re-triggers the
  // gate.
  const pollStartedAt = Date.now()
  const pollResult = await pollUntilComplete(fetchRuns, {
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

  // Defensive guard: `pollUntilComplete` is a `while(true)` that only
  // returns when the aggregated state is terminal (`success` / `failure`).
  // The `pending` branch is unreachable at runtime; this narrows the type
  // so the post-polling write below can pass `pollResult.state` to
  // `writeCommitStatus` (which expects `'success' | 'failure'`) without
  // a cast, and surfaces any future contract regression as an explicit
  // failure rather than an incoherent write.
  if (pollResult.state === 'pending') {
    core.warning(
      `automerge-gate: polling exited with pending state (unexpected) — iterations=${pollResult.iterations}`
    )
    core.setFailed(
      'automerge-gate: polling exited with pending state (unexpected)'
    )
    return
  }

  // Commit status `description` is shown inline in the PR Checks UI and
  // is capped at 140 characters by GitHub. Keep it short and slice
  // defensively in case future inputs blow past the limit.
  const description =
    pollResult.state === 'success'
      ? `${lastEvaluated} checks passed`
      : `${lastEvaluated} checks evaluated, at least one failed`

  await writeCommitStatus(octokit, {
    owner,
    repo,
    sha,
    state: pollResult.state,
    context: inputs.context,
    description: description.slice(0, 140),
    target_url: targetUrl
  })

  core.setOutput('state', pollResult.state)
  core.setOutput('total-checks', String(lastTotal))
  core.setOutput('evaluated-checks', String(lastEvaluated))
  core.setOutput('completed-checks', String(lastCompleted))
  core.setOutput('polled-iterations', String(pollResult.iterations))

  await writeSummary({
    state: pollResult.state,
    mode: 'polling',
    total: lastTotal,
    evaluated: lastEvaluated,
    completed: lastCompleted,
    iterations: pollResult.iterations,
    checkResultsMarkdown: formatted.summaryMarkdown
  })

  // Gating: the gate job's commit status conclusion is what GitHub's
  // required check evaluates. On aggregated failure, fail the job so the
  // workflow run is marked failed; the commit status itself is already
  // `failure` from the write above.
  if (pollResult.state === 'failure') {
    core.setFailed(
      `automerge-gate: aggregated state is failure (${lastEvaluated} checks evaluated)`
    )
  }
}
