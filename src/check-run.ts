import { withRetry, type OctokitLike } from './api.js'
import type { State } from './aggregator.js'

export type TargetUrlInput = {
  serverUrl: string
  repository: string
  runId: number
  runAttempt: number
}

// Builds the URL to the gate workflow's specific run page. Embedding this
// as the check_run's details_url means a maintainer who clicks the
// aggregated check in the PR Checks UI lands directly on the page where
// "Re-run all jobs" is one click away — the manual escape hatch for stuck
// aggregations.
export const buildTargetUrl = (input: TargetUrlInput): string =>
  `${input.serverUrl}/${input.repository}/actions/runs/${input.runId}/attempts/${input.runAttempt}`

// Marker stored in check_run.external_id so find-or-create can identify
// our check_run on a SHA without colliding with any unrelated check_run
// that happens to share the configured name.
export const CHECK_RUN_EXTERNAL_ID = 'automerge-gate'

export type CheckRunOutput = {
  title: string
  summary: string
}

export type WriteCheckRunInput = {
  owner: string
  repo: string
  sha: string
  state: State
  name: string
  output?: CheckRunOutput
  details_url?: string
}

// State → check_run (status, conclusion) mapping.
//
// pending → status: waiting (non-terminal, no conclusion). The Checks
// API docs say "Only GitHub Actions can set a status of waiting,
// pending, or requested" — it's unclear whether that means GitHub's
// internal Actions service or any caller authenticated as the
// github-actions[bot] (i.e. any workflow). Trying the latter
// experimentally; if the API rejects it (typically 422), fall back to
// status: queued.
//
// success / failure → status: completed with the same-named conclusion.
const stateToCheckRunFields = (
  state: State
): {
  status: 'waiting' | 'queued' | 'completed'
  conclusion?: 'success' | 'failure'
} => {
  if (state === 'pending') return { status: 'waiting' }
  return { status: 'completed', conclusion: state }
}

// Writes the aggregated verdict as a check_run on the HEAD SHA. Replaces
// the v1 commit-status write: check_runs allow PATCH-by-id, so the same
// SHA's pending → success/failure transition is a single logical row in
// the PR UI rather than two append-only status entries.
//
// Find-or-create: each pull_request event triggers a fresh workflow run,
// so pending mode and polling mode call this on the same SHA in two
// different runs. We list existing check_runs by name + our external_id
// marker, PATCH if found, POST otherwise.
export const writeCheckRun = async (
  octokit: OctokitLike,
  input: WriteCheckRunInput,
  retryOptions: { retries: number; baseDelayMs: number } = {
    retries: 3,
    baseDelayMs: 500
  }
): Promise<void> => {
  const { owner, repo, sha, state, name, output, details_url } = input
  const { status, conclusion } = stateToCheckRunFields(state)

  const list = await withRetry(
    () =>
      octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: sha,
        check_name: name,
        per_page: 100
      }),
    retryOptions
  )
  const existing = list.data.check_runs.find(
    (r) => r.external_id === CHECK_RUN_EXTERNAL_ID
  )

  if (existing !== undefined) {
    await withRetry(
      () =>
        octokit.rest.checks.update({
          owner,
          repo,
          check_run_id: existing.id,
          status,
          conclusion,
          output,
          details_url
        }) as Promise<unknown>,
      retryOptions
    )
    return
  }

  await withRetry(
    () =>
      octokit.rest.checks.create({
        owner,
        repo,
        name,
        head_sha: sha,
        status,
        conclusion,
        external_id: CHECK_RUN_EXTERNAL_ID,
        output,
        details_url
      }) as Promise<unknown>,
    retryOptions
  )
}
