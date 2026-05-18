import * as core from '@actions/core'
import * as github from '@actions/github'
import { parseInputs } from './inputs.js'
import type { OctokitLike } from './api.js'
import { runPrivate } from './gate-private.js'
import { runPublic } from './gate-public.js'
import { parseReviewState } from './mode.js'
import type { RunContext, RunDeps, RunEnv } from './run-deps.js'

const SUPPORTED_EVENTS = ['pull_request', 'pull_request_review'] as const

const buildContext = (): RunContext | null => {
  const ctx = github.context
  if (!(SUPPORTED_EVENTS as readonly string[]).includes(ctx.eventName)) {
    core.warning(
      `automerge-gate only handles pull_request / pull_request_review events; got "${ctx.eventName}". Skipping.`
    )
    return null
  }
  const action = (ctx.payload as { action?: string }).action ?? ''
  // Both pull_request and pull_request_review payloads carry a
  // `pull_request` object with the same shape we need here.
  const pr = ctx.payload.pull_request as RunContext['pr'] | undefined
  if (pr === undefined) {
    core.setFailed('pull_request payload is missing')
    return null
  }
  const reviewState =
    ctx.eventName === 'pull_request_review'
      ? parseReviewState(
          (ctx.payload as { review?: { state?: string } }).review?.state
        )
      : null
  const before = (ctx.payload as { before?: string }).before
  return {
    eventName: ctx.eventName,
    action,
    pr,
    reviewState,
    before,
    owner: ctx.repo.owner,
    repo: ctx.repo.repo
  }
}

const buildEnv = (): RunEnv => ({
  runId: Number.parseInt(process.env.GITHUB_RUN_ID ?? '0', 10),
  runAttempt: Number.parseInt(process.env.GITHUB_RUN_ATTEMPT ?? '1', 10),
  serverUrl: process.env.GITHUB_SERVER_URL ?? 'https://github.com',
  repository:
    process.env.GITHUB_REPOSITORY ??
    `${github.context.repo.owner}/${github.context.repo.repo}`,
  workflowRef: process.env.GITHUB_WORKFLOW_REF
})

const run = async (): Promise<void> => {
  const inputs = parseInputs({
    context: core.getInput('context'),
    ignoreChecks: core.getInput('ignore-checks'),
    gateMode: core.getInput('gate-mode'),
    token: core.getInput('token'),
    pollIntervalSeconds: core.getInput('poll-interval-seconds')
  })

  const context = buildContext()
  if (context === null) return
  const env = buildEnv()

  const octokit = github.getOctokit(inputs.token) as unknown as OctokitLike
  const deps: RunDeps = { octokit, context, env }

  if (inputs.gateMode === 'private') {
    await runPrivate(deps, inputs)
  } else {
    await runPublic(deps, inputs)
  }
}

run().catch((err: unknown) => {
  if (err instanceof Error) {
    core.setFailed(err.message)
  } else {
    core.setFailed(String(err))
  }
})
