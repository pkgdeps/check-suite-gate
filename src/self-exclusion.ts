import type { AggregatedCheckRun } from './filter.js'

// GitHub renders job-level check_runs with details_url of the form
//   https://github.com/{owner}/{repo}/actions/runs/{run_id}/job/{job_id}
// This shape is conventional but not formally guaranteed by the API.
// Tests assert on the regex match so a silent format change is caught
// in CI rather than producing wrong aggregations in production.
export const RUN_ID_REGEX = /\/actions\/runs\/(\d+)\/job\/\d+/

export const extractRunId = (detailsUrl: string): number | null => {
  const match = detailsUrl.match(RUN_ID_REGEX)
  if (match === null) return null
  return Number.parseInt(match[1], 10)
}

// A check_run is "ours" iff it was created by the GitHub Actions app
// for the very workflow run executing this code (matched by GITHUB_RUN_ID).
// Other apps that happen to embed the same number must NOT be filtered.
export const isOwnRun = (
  run: AggregatedCheckRun,
  ownRunId: number
): boolean => {
  if (run.app.slug !== 'github-actions') return false
  const runId = extractRunId(run.details_url)
  return runId === ownRunId
}

export const excludeOwnRuns = (
  runs: AggregatedCheckRun[],
  ownRunId: number
): AggregatedCheckRun[] => runs.filter((r) => !isOwnRun(r, ownRunId))
