import * as core from '@actions/core'
import { withRetry, type OctokitLike } from './api.js'
import type { State } from './aggregator.js'

// Shape of the response returned by GitHub for check_run create / update.
// We only care about the diagnostic fields here; cast at the call site so
// the rest of the OctokitLike contract stays Promise<unknown>.
type CheckRunResponse = {
  data?: {
    id?: number
    name?: string
    conclusion?: string | null
    status?: string
    html_url?: string
    check_suite?: { id?: number }
  }
}

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
// pending → status: queued (non-terminal, no conclusion). See
// docs/lessons/2026-05-06-check-run-pending-state-mapping.md for the
// experiments behind this choice (action_required and status: waiting
// were both tried and rejected).
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

// Writes the aggregated verdict as a check_run on the HEAD SHA. Always
// POSTs a fresh check_run (no find-or-create / PATCH) because each
// workflow run gets its own check_suite, and a check_run only ever
// belongs to the suite it was created in.
//
// If we PATCHed an existing check_run from a different run, the updated
// row would stay in the *original* suite while the *latest* suite (the
// auto_merge_enabled run's, the one that actually polled and decided
// success) would not contain the required check. GitHub's required-
// check evaluation against the latest suite then sees the entry as
// "Expected — Waiting for status to be reported" and blocks merge,
// even though the status_check_rollup over all suites returns SUCCESS.
//
// Posting a new check_run per run keeps the latest suite populated; for
// duplicate-name evaluation GitHub picks the latest, so the verdict is
// correct. The cost is one extra row per run in the PR Commits tab.
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

  core.info(
    `writeCheckRun: POST check-runs name=${name} sha=${sha} status=${status} conclusion=${conclusion ?? '-'}`
  )
  const result = (await withRetry(
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
  )) as CheckRunResponse
  const data = result?.data
  if (data !== undefined) {
    core.info(
      `writeCheckRun: created check_run id=${data.id} suite_id=${data.check_suite?.id} status=${data.status} conclusion=${data.conclusion ?? '-'} url=${data.html_url ?? '-'}`
    )
  } else {
    core.warning(
      'writeCheckRun: API returned no data field — unable to confirm check_run id / suite assignment'
    )
  }
}

export type MarkCheckRunStaleInput = {
  owner: string
  repo: string
  sha: string
  name: string
}

// Marks all aggregated check_runs on a previous SHA as superseded so
// the PR's Commits tab no longer shows the SHA as a yellow-dot queued
// entry. Called on `pull_request.synchronize` with the payload's
// `before` SHA; no-ops silently if no matching check_run exists.
//
// Patches every check_run with our external_id (not just the first):
// since writeCheckRun creates a new check_run per workflow run, a SHA
// can carry multiple of our check_runs across multiple suites, and
// leaving any of them non-terminal would keep the SHA visually
// "in progress".
//
// Uses `conclusion: cancelled` because `conclusion: stale` — the
// semantically perfect fit — is reserved for GitHub's internal Actions
// service and the API rejects third-party callers with 422 ("stale is
// not a member of [success, failure, neutral, cancelled, timed_out,
// action_required, skipped]"). Among allowed values, cancelled is the
// closest match: implicitly "this run was cancelled (by being
// superseded)", renders grey in the PR Commits tab, and — unlike
// skipped/neutral — counts as not-passing so a force-push back to this
// SHA wouldn't accidentally satisfy the required check on stale data.
// See docs/lessons/2026-05-06-check-run-pending-state-mapping.md.
export const markCheckRunStale = async (
  octokit: OctokitLike,
  input: MarkCheckRunStaleInput,
  retryOptions: { retries: number; baseDelayMs: number } = {
    retries: 3,
    baseDelayMs: 500
  }
): Promise<void> => {
  const { owner, repo, sha, name } = input
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
  const ours = list.data.check_runs.filter(
    (r) => r.external_id === CHECK_RUN_EXTERNAL_ID
  )
  core.info(
    `markCheckRunStale: sha=${sha} found ${ours.length} matching check_run(s) with our external_id (out of ${list.data.check_runs.length} listed by name)`
  )

  for (const run of ours) {
    core.info(
      `markCheckRunStale: PATCH check_run id=${run.id} → conclusion: cancelled`
    )
    await withRetry(
      () =>
        octokit.rest.checks.update({
          owner,
          repo,
          check_run_id: run.id,
          status: 'completed',
          conclusion: 'cancelled'
        }) as Promise<unknown>,
      retryOptions
    )
  }
}
