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

const TITLE = 'automerge-gate'

export type WriteCheckRunInput = {
  owner: string
  repo: string
  sha: string
  state: State
  name: string
  description?: string
  details_url?: string
}

// State → check_run (status, conclusion) mapping.
//
// pending → status: queued (non-terminal, no conclusion). Renders as a
// neutral yellow dot in the PR Checks UI. action_required was tried but
// rejected: it renders as a red exclamation, indistinguishable from a
// failure to a maintainer scanning the PR. queued matches the visual
// affordance of the v1 commit-status pending while still blocking merge
// (any non-completed check_run is not-passing for required check
// evaluation).
//
// success / failure → status: completed with the same-named conclusion.
const stateToCheckRunFields = (
  state: State
): {
  status: 'queued' | 'completed'
  conclusion?: 'success' | 'failure'
} => {
  if (state === 'pending') return { status: 'queued' }
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
  const { owner, repo, sha, state, name, description, details_url } = input
  const { status, conclusion } = stateToCheckRunFields(state)
  const output: { title: string; summary: string } | undefined =
    description !== undefined
      ? { title: TITLE, summary: description }
      : undefined

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
