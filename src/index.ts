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
  writeCommitStatus,
  type WriteCommitStatusInput
} from './status.js'

const PENDING_DESCRIPTION = 'Awaiting Auto Merge enable'

// pull_request activity types that may bring a new HEAD SHA to the PR.
// The gate re-evaluates the SHA on these. Triggers pending mode by default,
// or polling mode when Auto Merge is already enabled.
const HEAD_SHA_ACTIONS = ['opened', 'synchronize', 'reopened'] as const
type HeadShaAction = (typeof HEAD_SHA_ACTIONS)[number]
const isHeadShaAction = (a: string): a is HeadShaAction =>
  (HEAD_SHA_ACTIONS as readonly string[]).includes(a)

// Mutually exclusive modes the action can run in for a given pull_request event.
//   polling — poll the Checks API and (try to) write the aggregated status when done.
//   pending — write a pending status with "Awaiting Auto Merge enable" and exit.
//   skip    — do nothing for unsupported activity types.
type ActionMode = 'polling' | 'pending' | 'skip'

type DetermineModeInput = {
  action: string
  isHeadShaEvent: boolean
  isAutoMergeAlreadyEnabled: boolean
}

const determineMode = (input: DetermineModeInput): ActionMode => {
  const { action, isHeadShaEvent, isAutoMergeAlreadyEnabled } = input
  if (action === 'auto_merge_enabled') return 'polling'
  if (isHeadShaEvent) {
    return isAutoMergeAlreadyEnabled ? 'polling' : 'pending'
  }
  return 'skip'
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
      ['mode', input.mode],
      ['state', input.state],
      ['total checks (pre-filter)', String(input.total)],
      ['evaluated checks (post-filter)', String(input.evaluated)],
      ['completed checks', String(input.completed)],
      ['polling iterations', String(input.iterations)]
    ])
    .write()
}

// Status write is a courtesy in v2: gating is done via the gate job's exit
// code (the check_run conclusion). When the token is read-only (the default
// on fork PRs), the API returns 403 — log a warning and continue. The
// polling verdict still drives the job's exit code.
const tryWriteCommitStatus = async (
  octokit: OctokitLike,
  input: WriteCommitStatusInput
): Promise<void> => {
  try {
    await writeCommitStatus(octokit, input)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const isPermissionError =
      /\b403\b/.test(message) ||
      /Resource not accessible by integration/i.test(message)
    if (isPermissionError) {
      core.warning(
        'Status write skipped (token lacks statuses:write — common on fork PRs). Falling back to job exit-code gating.'
      )
      return
    }
    throw err
  }
}

const run = async (): Promise<void> => {
  const inputs = parseInputs({
    context: core.getInput('context'),
    ignoreApps: core.getInput('ignore-apps'),
    ignoreChecks: core.getInput('ignore-checks'),
    mode: core.getInput('mode'),
    token: core.getInput('token'),
    pollIntervalSeconds: core.getInput('poll-interval-seconds')
  })

  const ctx = github.context
  if (ctx.eventName !== 'pull_request') {
    core.warning(
      `automerge-gate only handles pull_request events; got "${ctx.eventName}". Skipping.`
    )
    return
  }

  const action = (ctx.payload as { action?: string }).action ?? ''
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

  // Decide which mode to run.
  // Polling mode: maintainer pressed "Enable Auto Merge" (auto_merge_enabled
  // activity), OR Auto Merge is already enabled and a new SHA landed on
  // the PR (e.g. a Renovate-style auto-merge-on-creation PR).
  // Pending mode: a new SHA landed but Auto Merge is not yet enabled. We
  // just mark the required check pending so the merge stays blocked.
  const mode: ActionMode = determineMode({
    action,
    isHeadShaEvent: isHeadShaAction(action),
    isAutoMergeAlreadyEnabled: pr.auto_merge !== null
  })

  core.info(`Mode: ${mode}`)
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

  if (mode === 'pending') {
    if (inputs.mode === 'main-gate') {
      await tryWriteCommitStatus(octokit, {
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        sha,
        state: 'pending',
        context: inputs.context,
        description: PENDING_DESCRIPTION,
        target_url: targetUrl
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
  // this run if checks take too long; commit status remains as last
  // written (= the pending we set in pending mode).
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

  const description = `${pollResult.state}: ${lastEvaluated} checks evaluated`

  if (inputs.mode === 'main-gate') {
    await tryWriteCommitStatus(octokit, {
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      sha,
      state: pollResult.state,
      context: inputs.context,
      description: description.slice(0, 140),
      target_url: targetUrl
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
