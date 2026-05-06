import * as core from '@actions/core'
import * as github from '@actions/github'
import { parseInputs } from './inputs.js'
import { fetchAllCheckRuns, type OctokitLike } from './api.js'
import { applyFilters } from './filter.js'
import { excludeOwnRuns } from './self-exclusion.js'
import { pollUntilComplete } from './polling.js'
import { buildTargetUrl, writeCommitStatus } from './status.js'

const PENDING_DESCRIPTION = 'Awaiting Auto Merge enable'

const run = async (): Promise<void> => {
  const inputs = parseInputs({
    context: core.getInput('context'),
    ignoreApps: core.getInput('ignore-apps'),
    ignoreChecks: core.getInput('ignore-checks'),
    token: core.getInput('token'),
    pollIntervalSeconds: core.getInput('poll-interval-seconds'),
    forkPolicy: core.getInput('fork-policy')
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
    | { number: number; head: { sha: string } }
    | undefined
  if (pr === undefined) {
    core.setFailed('pull_request payload is missing')
    return
  }

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

  // Detect fork PR: head_repo and base_repo differ.
  // pr.head.repo can be null if the fork repo was deleted; treat as fork.
  // Compare by id (immutable) rather than full_name (renames possible).
  const baseRepoId = (pr as unknown as { base: { repo: { id: number } } }).base
    .repo.id
  const headRepo = (pr as unknown as { head: { repo: { id: number } | null } })
    .head.repo
  const isFork = headRepo == null || headRepo.id !== baseRepoId

  if (isFork) {
    if (inputs.forkPolicy === 'skip') {
      core.info(
        'Fork PR detected; skipping (no status written) per fork-policy=skip.'
      )
      core.setOutput('state', 'skipped')
      core.setOutput('total-checks', '0')
      core.setOutput('evaluated-checks', '0')
      core.setOutput('completed-checks', '0')
      core.setOutput('polled-iterations', '0')
      return
    }
    // forkPolicy === 'success'
    core.info(
      'Fork PR detected; writing success status per fork-policy=success.'
    )
    await writeCommitStatus(octokit, {
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      sha,
      state: 'success',
      context: inputs.context,
      description: 'Fork PR: gating delegated to other required checks',
      target_url: targetUrl
    })
    core.setOutput('state', 'success')
    core.setOutput('total-checks', '0')
    core.setOutput('evaluated-checks', '0')
    core.setOutput('completed-checks', '0')
    core.setOutput('polled-iterations', '0')
    return
  }

  // Pending mode: PR was opened / synchronized / reopened.
  // Write a pending status with an action-item description and exit.
  if (
    action === 'opened' ||
    action === 'synchronize' ||
    action === 'reopened'
  ) {
    await writeCommitStatus(octokit, {
      owner: ctx.repo.owner,
      repo: ctx.repo.repo,
      sha,
      state: 'pending',
      context: inputs.context,
      description: PENDING_DESCRIPTION,
      target_url: targetUrl
    })
    core.setOutput('state', 'pending')
    core.setOutput('total-checks', '0')
    core.setOutput('evaluated-checks', '0')
    core.setOutput('completed-checks', '0')
    core.setOutput('polled-iterations', '0')
    return
  }

  // Polling mode: maintainer pressed "Enable Auto Merge".
  if (action !== 'auto_merge_enabled') {
    core.warning(`Skipping unsupported pull_request action: "${action}"`)
    return
  }

  let lastTotal = 0
  let lastEvaluated = 0
  let lastCompleted = 0

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
      const afterSelf = excludeOwnRuns(afterFilters, runId)
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
  const pollResult = await pollUntilComplete(fetchRuns, {
    intervalSeconds: inputs.pollIntervalSeconds
  })

  const description = `${pollResult.state}: ${lastEvaluated} checks evaluated`

  await writeCommitStatus(octokit, {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
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
}

run().catch((err: unknown) => {
  if (err instanceof Error) {
    core.setFailed(err.message)
  } else {
    core.setFailed(String(err))
  }
})
