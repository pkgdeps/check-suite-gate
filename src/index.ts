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

const ZERO_SHA = '0000000000000000000000000000000000000000'

// Output shown when the gate is waiting for the maintainer to click
// "Enable auto-merge". The title is what GitHub renders inline in the PR
// merge box (e.g. "Queued — Waiting for Enable auto-merge"), so it must
// be self-explanatory at a glance.
const buildPendingOutput = (): CheckRunOutput => ({
  title: 'Waiting for Enable auto-merge',
  summary: [
    'This required check is waiting for the maintainer to click **Enable auto-merge** on this PR.',
    '',
    "Once enabled, the gate polls every other check on the PR and turns green or red based on the aggregated result. The maintainer doesn't need to wait — auto-merge will trigger as soon as the gate turns green."
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
  stats: PollingStats
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
    `| Polling iterations | ${stats.iterations} |`
  ].join('\n')
  return { title, summary }
}

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

  // Mark the aggregated check_run on the previous HEAD SHA as stale, so
  // the PR's Commits tab doesn't accumulate yellow-dot queued entries
  // for every superseded push. Only synchronize carries `before`; opened
  // / reopened / auto_merge_enabled don't bring a previous SHA we'd
  // need to clean up.
  if (inputs.mode === 'main-gate' && action === 'synchronize') {
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
    if (inputs.mode === 'main-gate') {
      await writeCheckRun(octokit, {
        owner: ctx.repo.owner,
        repo: ctx.repo.repo,
        sha,
        state: 'pending',
        name: inputs.context,
        output: buildPendingOutput(),
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

  if (inputs.mode === 'main-gate') {
    const pollingOutput =
      pollResult.state === 'pending'
        ? buildPendingOutput()
        : buildPollingOutput(pollResult.state, {
            total: lastTotal,
            evaluated: lastEvaluated,
            completed: lastCompleted,
            iterations: pollResult.iterations
          })
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
