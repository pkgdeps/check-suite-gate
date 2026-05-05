import { withRetry, type OctokitLike } from './api.js'
import type { State } from './aggregator.js'

export type TargetUrlInput = {
  serverUrl: string
  repository: string
  runId: number
  runAttempt: number
}

// Builds the URL to the gate workflow's specific run page. Embedding this
// as the commit status's target_url means a maintainer who clicks the
// aggregated status in the PR Checks UI lands directly on the page where
// "Re-run all jobs" is one click away — the manual escape hatch for stuck
// aggregations.
export const buildTargetUrl = (input: TargetUrlInput): string =>
  `${input.serverUrl}/${input.repository}/actions/runs/${input.runId}/attempts/${input.runAttempt}`

export type WriteCommitStatusInput = {
  owner: string
  repo: string
  sha: string
  state: State
  context: string
  description?: string
  target_url?: string
}

export const writeCommitStatus = async (
  octokit: OctokitLike,
  input: WriteCommitStatusInput,
  retryOptions: { retries: number; baseDelayMs: number } = {
    retries: 3,
    baseDelayMs: 500
  }
): Promise<void> => {
  await withRetry(
    () => octokit.rest.repos.createCommitStatus(input) as Promise<unknown>,
    retryOptions
  )
}
