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

// Parses GITHUB_WORKFLOW_REF like
//   "owner/repo/.github/workflows/foo.yml@refs/heads/main"
// into ".github/workflows/foo.yml" (the path part).
// Returns null if the env var is missing or doesn't match the expected shape.
export const parseCurrentWorkflowPath = (
  workflowRef: string | undefined
): string | null => {
  if (workflowRef === undefined || workflowRef.length === 0) return null
  const atIndex = workflowRef.indexOf('@')
  const beforeAt = atIndex === -1 ? workflowRef : workflowRef.slice(0, atIndex)
  // Strip leading "owner/repo/"
  const parts = beforeAt.split('/')
  if (parts.length < 3) return null
  return parts.slice(2).join('/')
}

// True iff the check_run was produced by the same workflow file as the
// currently executing run. Used to filter out:
//   1. The current run's own check_runs (the in-progress self-job).
//   2. Past runs of the same workflow that completed earlier on this SHA
//      (e.g. cancelled by cancel-in-progress concurrency).
// Both must be excluded so the aggregator doesn't pick up stale or
// self-referencing results.
export type WorkflowPathLookup = (runId: number) => Promise<string | null>

export const isFromSameWorkflow = async (
  run: AggregatedCheckRun,
  currentWorkflowPath: string | null,
  lookupWorkflowPath: WorkflowPathLookup
): Promise<boolean> => {
  if (run.app.slug !== 'github-actions') return false
  if (currentWorkflowPath === null) return false
  const runId = extractRunId(run.details_url)
  if (runId === null) return false
  const path = await lookupWorkflowPath(runId)
  return path === currentWorkflowPath
}

export const excludeOwnWorkflowRuns = async (
  runs: AggregatedCheckRun[],
  currentWorkflowPath: string | null,
  lookupWorkflowPath: WorkflowPathLookup
): Promise<AggregatedCheckRun[]> => {
  const keep: AggregatedCheckRun[] = []
  for (const r of runs) {
    const own = await isFromSameWorkflow(
      r,
      currentWorkflowPath,
      lookupWorkflowPath
    )
    if (!own) keep.push(r)
  }
  return keep
}

// Populates `workflow_path` on each check_run by looking up the originating
// workflow file path via the actions API. Only runs from the `github-actions`
// app have a workflow_path; for everything else (third-party Checks, missing
// run_id) the value is set to `null`. Used by applyFilters when ignore-checks
// contains any rule that references the `workflow` field.
//
// Unique run_ids are looked up in parallel so total latency is the slowest
// single call rather than the sum. `createWorkflowPathLookup` memoizes per
// run_id, so duplicate check_runs from the same workflow run share one call.
export const resolveWorkflowPaths = async (
  runs: AggregatedCheckRun[],
  lookupWorkflowPath: WorkflowPathLookup
): Promise<AggregatedCheckRun[]> => {
  const uniqueRunIds = new Set<number>()
  for (const r of runs) {
    if (r.app.slug !== 'github-actions') continue
    const runId = extractRunId(r.details_url)
    if (runId !== null) uniqueRunIds.add(runId)
  }
  const entries = await Promise.all(
    Array.from(
      uniqueRunIds,
      async (id) => [id, await lookupWorkflowPath(id)] as const
    )
  )
  const pathByRunId = new Map(entries)
  return runs.map((r) => {
    if (r.app.slug !== 'github-actions') return { ...r, workflow_path: null }
    const runId = extractRunId(r.details_url)
    if (runId === null) return { ...r, workflow_path: null }
    return { ...r, workflow_path: pathByRunId.get(runId) ?? null }
  })
}
