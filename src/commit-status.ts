import * as core from '@actions/core'
import { withRetry, type OctokitLike } from './api.js'

export type TargetUrlInput = {
  serverUrl: string
  repository: string
  runId: number
  runAttempt: number
}

// Builds the URL to the gate workflow's specific run page. Embedding this
// as the commit status's target_url means a maintainer who clicks the
// status row in the PR Checks UI lands directly on the page where
// "Re-run all jobs" is one click away — the manual escape hatch for stuck
// aggregations.
export const buildTargetUrl = (input: TargetUrlInput): string =>
  `${input.serverUrl}/${input.repository}/actions/runs/${input.runId}/attempts/${input.runAttempt}`

export type WriteCommitStatusInput = {
  owner: string
  repo: string
  sha: string
  state: 'success' | 'failure'
  context: string
  description: string
  target_url: string
}

// Writes the aggregated verdict as a commit status on the HEAD SHA via the
// legacy Commit Status API. A commit status is keyed by `(SHA, context)`
// with no check_suite concept, so unlike the Checks API it cannot be
// assigned to a non-current suite. v4 reverted the gate signal from
// `check_run` (v2/v3) back to commit status to structurally eliminate the
// suite-mismatch race observed in automerge-gate-example PR #28, where
// `octokit.rest.checks.create` could attach the gate's check_run to a
// non-current GitHub Actions check_suite.
//
// The action only writes terminal verdicts (`success` / `failure`); no
// pending pre-write happens here. Each new POST overwrites the visible
// status for `(SHA, context)`, so old SHAs never need cleanup (no
// equivalent of markCheckRunStale is required).
export const writeCommitStatus = async (
  octokit: OctokitLike,
  input: WriteCommitStatusInput,
  retryOptions: { retries: number; baseDelayMs: number } = {
    retries: 3,
    baseDelayMs: 500
  }
): Promise<void> => {
  const { owner, repo, sha, state, context, description, target_url } = input
  core.info(
    `writeCommitStatus: POST statuses sha=${sha} state=${state} context=${context}`
  )
  await withRetry(
    () =>
      octokit.rest.repos.createCommitStatus({
        owner,
        repo,
        sha,
        state,
        context,
        description,
        target_url
      }) as Promise<unknown>,
    retryOptions
  )
}
