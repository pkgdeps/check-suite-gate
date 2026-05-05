import * as core from '@actions/core'
import * as github from '@actions/github'
import { parseInputs } from './inputs.js'
import {
  fetchAllCheckRuns,
  waitForTriggerSuiteCompleted,
  type OctokitLike
} from './api.js'
import { applyFilters } from './filter.js'
import { excludeOwnRuns } from './self-exclusion.js'
import { aggregate, type Mode } from './aggregator.js'
import { buildTargetUrl, writeCommitStatus } from './status.js'

const run = async (): Promise<void> => {
  const inputs = parseInputs({
    context: core.getInput('context'),
    ignoreApps: core.getInput('ignore-apps'),
    ignoreChecks: core.getInput('ignore-checks'),
    token: core.getInput('token')
  })

  const octokit = github.getOctokit(inputs.token) as unknown as OctokitLike
  const ctx = github.context
  const eventName = ctx.eventName
  const runAttempt = Number.parseInt(process.env.GITHUB_RUN_ATTEMPT ?? '1', 10)
  const runId = Number.parseInt(process.env.GITHUB_RUN_ID ?? '0', 10)
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const repository =
    process.env.GITHUB_REPOSITORY ?? `${ctx.repo.owner}/${ctx.repo.repo}`

  const sha =
    eventName === 'check_suite'
      ? (ctx.payload.check_suite as { head_sha: string }).head_sha
      : ctx.sha

  const triggerSuiteId =
    eventName === 'check_suite'
      ? (ctx.payload.check_suite as { id: number }).id
      : null

  if (triggerSuiteId !== null) {
    await waitForTriggerSuiteCompleted(
      octokit,
      ctx.repo.owner,
      ctx.repo.repo,
      sha,
      triggerSuiteId
    )
  }

  const allRuns = await fetchAllCheckRuns(
    octokit,
    ctx.repo.owner,
    ctx.repo.repo,
    sha
  )
  const afterFilters = applyFilters(
    allRuns,
    inputs.ignoreApps,
    inputs.ignoreChecks
  )
  const afterSelf = excludeOwnRuns(afterFilters, runId)

  const mode: Mode = runAttempt > 1 ? 'rescue' : 'normal'
  const result = aggregate({ runs: afterSelf, mode })

  const targetUrl = buildTargetUrl({
    serverUrl,
    repository,
    runId,
    runAttempt
  })

  const incomplete = afterSelf.length - result.completed
  const description =
    result.state === 'pending'
      ? `Waiting on ${incomplete} of ${afterSelf.length} checks`
      : `${result.state}: ${afterSelf.length} checks evaluated (mode=${mode})`

  await writeCommitStatus(octokit, {
    owner: ctx.repo.owner,
    repo: ctx.repo.repo,
    sha,
    state: result.state,
    context: inputs.context,
    description: description.slice(0, 140),
    target_url: targetUrl
  })

  core.setOutput('state', result.state)
  core.setOutput('total-checks', String(allRuns.length))
  core.setOutput('evaluated-checks', String(afterSelf.length))
  core.setOutput('completed-checks', String(result.completed))
  core.setOutput('mode', mode)
}

run().catch((err: unknown) => {
  if (err instanceof Error) {
    core.setFailed(err.message)
  } else {
    core.setFailed(String(err))
  }
})
