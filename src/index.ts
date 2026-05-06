import * as core from '@actions/core'
import * as github from '@actions/github'
import { parseInputs } from './inputs.js'
import {
  fetchAllCheckRuns,
  createWorkflowPathLookup,
  type OctokitLike
} from './api.js'
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
import { determineMode, isHeadShaAction, parseReviewState } from './mode.js'
import { hasActiveApproval } from './review-status.js'

const ZERO_SHA = '0000000000000000000000000000000000000000'

// Output shown when the gate is waiting for any merge-intent signal.
// The title is what GitHub renders inline in the PR merge box (e.g.
// "Queued — Waiting for Approve or Enable auto-merge"), so it must be
// self-explanatory at a glance and reflect every signal that would
// unblock the gate. The `reason` from determineMode is appended verbatim
// so the maintainer can see exactly which event/state put the gate
// here, without cross-referencing workflow logs.
const buildPendingOutput = (reason: string): CheckRunOutput => ({
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

const buildPollingOutput = (
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

const run = async (): Promise<void> => {
  const inputs = parseInputs({
    context: core.getInput('context'),
    ignoreApps: core.getInput('ignore-apps'),
    ignoreChecks: core.getInput('ignore-checks'),
    gate: core.getInput('gate'),
    token: core.getInput('token'),
    pollIntervalSeconds: core.getInput('poll-interval-seconds')
  })

  const ctx = github.context
  const SUPPORTED_EVENTS = ['pull_request', 'pull_request_review'] as const
  if (!(SUPPORTED_EVENTS as readonly string[]).includes(ctx.eventName)) {
    core.warning(
      `automerge-gate only handles pull_request / pull_request_review events; got "${ctx.eventName}". Skipping.`
    )
    return
  }

  const action = (ctx.payload as { action?: string }).action ?? ''
  // Both pull_request and pull_request_review payloads carry a
  // `pull_request` object with the same shape we need here.
  const pr = ctx.payload.pull_request as
    | {
        number: number
        head: { sha: string }
        auto_merge: { enabled_by: { login: string } } | null
      }
    | undefined
  if (pr === undefined) {
    core.setFailed('pull_request payload is missing')
    return
  }
  const reviewState =
    ctx.eventName === 'pull_request_review'
      ? parseReviewState(
          (ctx.payload as { review?: { state?: string } }).review?.state
        )
      : null

  core.startGroup('Setup')
  core.info(`Event: ${ctx.eventName} (action=${action})`)
  core.info(`PR #${pr.number}, head SHA ${pr.head.sha}`)

  const sha = pr.head.sha
  const runId = Number.parseInt(process.env.GITHUB_RUN_ID ?? '0', 10)
  const runAttempt = Number.parseInt(process.env.GITHUB_RUN_ATTEMPT ?? '1', 10)
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const repository =
    process.env.GITHUB_REPOSITORY ?? `${ctx.repo.owner}/${ctx.repo.repo}`
  const targetUrl = buildTargetUrl({
    serverUrl,
    repository,
    runId,
    runAttempt
  })

  const octokit = github.getOctokit(inputs.token) as unknown as OctokitLike

  // Approve is a sticky merge-intent signal: once a write-permission
  // reviewer Approves, every subsequent push should re-evaluate
  // (= polling), not drop back to pending. We query review state to
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
    ctx.eventName === 'pull_request_review'
  const isApproved = needsApprovalLookup
    ? await hasActiveApproval(octokit, ctx.repo.owner, ctx.repo.repo, pr.number)
    : false

  const { mode, reason } = determineMode({
    eventName: ctx.eventName,
    action,
    reviewState,
    isHeadShaEvent,
    isAutoMergeAlreadyEnabled: pr.auto_merge !== null,
    isApproved
  })

  core.info(`Mode: ${mode} — ${reason}`)
  core.endGroup()

  if (mode === 'skip') {
    core.warning(`Skipping unsupported pull_request action: "${action}"`)
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
  if (inputs.gate === 'main' && action === 'synchronize') {
    const before = (ctx.payload as { before?: string }).before
    if (before !== undefined && before !== ZERO_SHA && before !== sha) {
      await markCheckRunStale(octokit, {
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        sha: before,
        name: inputs.context
      })
    }
  }

  if (mode === 'pending') {
    if (inputs.gate === 'main') {
      await writeCheckRun(octokit, {
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        sha,
        state: 'pending',
        name: inputs.context,
        output: buildPendingOutput(reason),
        details_url: targetUrl
      })
    }
    core.setOutput('state', 'pending')
    core.setOutput('total-checks', '0')
    core.setOutput('evaluated-checks', '0')
    core.setOutput('completed-checks', '0')
    core.setOutput('polled-iterations', '0')
    await writeSummary({
      state: 'pending',
      mode: 'pending',
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

  const currentWorkflowPath = parseCurrentWorkflowPath(
    process.env.GITHUB_WORKFLOW_REF
  )
  const lookupWorkflowPath = createWorkflowPathLookup(
    octokit,
    ctx.repo.owner,
    ctx.repo.repo
  )

  const fetchRuns = async () => {
    try {
      const allRuns = await fetchAllCheckRuns(
        octokit,
        ctx.repo.owner,
        ctx.repo.repo,
        sha
      )
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
  // last written (= the queued one we set in pending mode).
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

  if (inputs.gate === 'main') {
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
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      sha,
      state: pollResult.state,
      name: inputs.context,
      output: pollingOutput,
      details_url: targetUrl
    })
  }

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

run().catch((err: unknown) => {
  if (err instanceof Error) {
    core.setFailed(err.message)
  } else {
    core.setFailed(String(err))
  }
})
