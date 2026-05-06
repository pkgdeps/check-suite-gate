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
import {
  buildTargetUrl,
  writeCheckRun,
  markCheckRunStale,
  type CheckRunOutput
} from './check-run.js'
import { determineMode, isHeadShaAction } from './mode.js'
import { hasActiveApproval } from './review-status.js'

const ZERO_SHA = '0000000000000000000000000000000000000000'

// Output shown when the gate's aggregated check_run is in a non-terminal
// (queued / pending) state. Used in two places in the private-mode
// polling path:
//
//   1. The queued pre-write before polling starts. Polling can take
//      minutes, and without this write the required-check context is
//      unreported on the head SHA — GitHub renders "Expected — Waiting
//      for status to be reported" with no indication the gate is
//      actively running. The pre-write inserts a `Queued —
//      automerge-gate` row in the PR Checks list so the maintainer
//      sees the gate is in progress; the post-polling write replaces
//      it with the actual verdict.
//   2. A type-defensive fallback for the post-polling write when
//      `pollResult.state === 'pending'`. `pollUntilComplete` is typed
//      to return `success | failure | pending`, but in the current
//      code path it only ever exits as terminal — pending here would
//      only occur if the contract changed.
//
// The title is what GitHub renders inline in the PR merge box (e.g.
// "Queued — Waiting for Approve or Enable auto-merge"), so it must be
// self-explanatory at a glance and reflect every signal that would
// unblock the gate. The `reason` from determineMode is appended verbatim
// so the maintainer can see exactly which event/state put the gate
// here, without cross-referencing workflow logs.
export const buildPendingOutput = (reason: string): CheckRunOutput => ({
  title: 'Waiting for Approve or Enable auto-merge',
  summary: [
    'This required check is waiting for any of the following merge-intent signals:',
    '',
    '- A reviewer submits an **Approve** review, or',
    '- A maintainer clicks **Enable auto-merge**',
    '',
    'Once either lands, the gate polls every other check on the PR and turns green or red based on the aggregated result.',
    '',
    `**Trigger:** ${reason}`
  ].join('\n')
})

type PollingStats = {
  total: number
  evaluated: number
  completed: number
  iterations: number
}

export const buildPollingOutput = (
  state: 'success' | 'failure',
  stats: PollingStats,
  reason: string
): CheckRunOutput => {
  const title =
    state === 'success' ? 'All checks passed' : 'At least one check failed'
  const headline =
    state === 'success'
      ? `All ${stats.evaluated} evaluated checks passed.`
      : `${stats.evaluated} evaluated checks include at least one failure.`
  const summary = [
    headline,
    '',
    '| Field | Value |',
    '|---|---|',
    `| Total (pre-filter) | ${stats.total} |`,
    `| Evaluated (post-filter) | ${stats.evaluated} |`,
    `| Completed | ${stats.completed} |`,
    `| Polling iterations | ${stats.iterations} |`,
    '',
    `**Trigger:** ${reason}`
  ].join('\n')
  return { title, summary }
}

type SummaryInput = {
  state: string
  mode: string
  total: number
  evaluated: number
  completed: number
  iterations: number
}

const writeSummary = async (input: SummaryInput): Promise<void> => {
  const stateEmoji =
    input.state === 'success' ? '✅' : input.state === 'failure' ? '❌' : '🟡'
  await core.summary
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
    .write()
}

export const runPrivate = async (
  deps: RunDeps,
  inputs: ParsedInputs
): Promise<void> => {
  const { octokit, context, env } = deps
  const { eventName, action, pr, reviewState, before, owner, repo } = context
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

  // Mark the aggregated check_run on the previous HEAD SHA as stale, so
  // the PR's Commits tab doesn't accumulate yellow-dot queued entries
  // for every superseded push. Only synchronize carries `before`; opened
  // / reopened / auto_merge_enabled don't bring a previous SHA we'd
  // need to clean up.
  if (action === 'synchronize') {
    if (before !== undefined && before !== ZERO_SHA && before !== sha) {
      await markCheckRunStale(octokit, {
        owner,
        repo,
        sha: before,
        name: inputs.context
      })
    }
  }

  // mode === 'polling'

  // Pre-write a queued check_run BEFORE polling starts.
  //
  // Polling can take minutes (it has no internal timeout — it waits
  // for every check on the PR to reach a terminal state). Without this
  // pre-write, the required-check context is unreported on the head
  // SHA during the entire polling window, and GitHub renders
  // "Expected — Waiting for status to be reported" — visually
  // indistinguishable from a state where the gate workflow never
  // triggered. The maintainer can't tell whether the gate is running
  // or stuck.
  //
  // The pre-write inserts a `Queued — automerge-gate` row in the PR
  // Checks list so the maintainer sees the gate is actively in
  // progress. `status: queued` is non-terminal, so GitHub keeps merge
  // blocked until the post-polling write below replaces it with the
  // actual `success` / `failure` verdict.
  //
  // (Historically — see lessons/2026-05-06-check-run-pending-state-mapping.md
  // §4 — the pre-write also closed a v2-era race where a sibling job's
  // skipped check_run could land first as "latest" in the suite. That
  // race is structurally gone in v3's single-job pattern, but the
  // UX-during-polling reason above keeps the pre-write in place.)
  await writeCheckRun(octokit, {
    owner,
    repo,
    sha,
    state: 'pending',
    name: inputs.context,
    output: buildPendingOutput(reason),
    details_url: targetUrl
  })

  let lastTotal = 0
  let lastEvaluated = 0
  let lastCompleted = 0

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
      return afterSelf
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      core.warning(`API fetch failed during polling (will retry): ${message}`)
      throw err
    }
  }

  // Polling has no internal timeout. The job's timeout-minutes will kill
  // this run if checks take too long; the aggregate check_run remains as
  // last written (= the queued check_run we pre-wrote before polling).
  core.startGroup('Polling')
  const pollResult = await pollUntilComplete(fetchRuns, {
    intervalSeconds: inputs.pollIntervalSeconds,
    onIteration: (s) => {
      core.info(
        `Poll #${s.iteration}: state=${s.state}, ${s.completed}/${s.total} completed`
      )
    }
  })
  core.endGroup()

  core.startGroup('Result')
  core.info(
    `Polling finished: state=${pollResult.state}, iterations=${pollResult.iterations}`
  )
  core.info(
    `Checks: total=${lastTotal}, evaluated=${lastEvaluated}, completed=${lastCompleted}`
  )
  core.endGroup()

  const pollingOutput =
    pollResult.state === 'pending'
      ? buildPendingOutput(reason)
      : buildPollingOutput(
          pollResult.state,
          {
            total: lastTotal,
            evaluated: lastEvaluated,
            completed: lastCompleted,
            iterations: pollResult.iterations
          },
          reason
        )
  await writeCheckRun(octokit, {
    owner,
    repo,
    sha,
    state: pollResult.state,
    name: inputs.context,
    output: pollingOutput,
    details_url: targetUrl
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
    iterations: pollResult.iterations
  })

  // Gating: the gate job's check_run conclusion is what GitHub's required
  // check evaluates (when the workflow's job is named to match the
  // required check context). On aggregated failure, fail the job so the
  // check_run becomes "failure"; on success, return normally so the
  // check_run becomes "success".
  if (pollResult.state === 'failure') {
    core.setFailed(
      `automerge-gate: aggregated state is failure (${lastEvaluated} checks evaluated)`
    )
  }
}
