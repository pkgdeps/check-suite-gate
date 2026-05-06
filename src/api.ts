import type { AggregatedCheckRun } from './filter.js'

type CheckSuiteData = {
  id: number
  app: { slug: string } | null
  status: string
}

type CheckRunData = {
  id: number
  name: string
  status: string
  conclusion: string | null
  details_url: string
}

export type CheckRunListItem = {
  id: number
  name: string
  status: string
  conclusion: string | null
  external_id: string | null
  app: { slug: string } | null
}

export type CheckRunOutput = {
  title: string
  summary: string
}

export type CheckRunCreateParams = {
  owner: string
  repo: string
  name: string
  head_sha: string
  status?: 'queued' | 'in_progress' | 'completed'
  conclusion?:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'stale'
  external_id?: string
  details_url?: string
  output?: CheckRunOutput
}

export type CheckRunUpdateParams = {
  owner: string
  repo: string
  check_run_id: number
  status?: 'queued' | 'in_progress' | 'completed'
  conclusion?:
    | 'success'
    | 'failure'
    | 'neutral'
    | 'cancelled'
    | 'skipped'
    | 'timed_out'
    | 'action_required'
    | 'stale'
  details_url?: string
  output?: CheckRunOutput
}

export type CheckRunListForRefParams = {
  owner: string
  repo: string
  ref: string
  check_name?: string
  filter?: 'latest' | 'all'
  per_page?: number
}

export type ReviewListItem = {
  state: string
  submitted_at: string | null
  user: { login: string } | null
  // GitHub's classification of the reviewer's relationship to the
  // repository. Used to skip reviews from drive-by users (CONTRIBUTOR /
  // NONE / FIRST_TIME_CONTRIBUTOR / MANNEQUIN) so a non-authorized
  // Approve doesn't satisfy the merge-intent gate.
  author_association: string
}

export type OctokitLike = {
  rest: {
    checks: {
      listSuitesForRef: (params: {
        owner: string
        repo: string
        ref: string
        per_page?: number
      }) => Promise<{ data: { check_suites: CheckSuiteData[] } }>
      listForSuite: (params: {
        owner: string
        repo: string
        check_suite_id: number
        per_page?: number
      }) => Promise<{ data: { check_runs: CheckRunData[] } }>
      listForRef: (
        params: CheckRunListForRefParams
      ) => Promise<{ data: { check_runs: CheckRunListItem[] } }>
      create: (params: CheckRunCreateParams) => Promise<unknown>
      update: (params: CheckRunUpdateParams) => Promise<unknown>
    }
    pulls: {
      listReviews: (params: {
        owner: string
        repo: string
        pull_number: number
        per_page?: number
      }) => Promise<{ data: ReviewListItem[] }>
    }
  }
  paginate: <T>(
    fn: (params: Record<string, unknown>) => Promise<{ data: T[] }>,
    params: Record<string, unknown>
  ) => Promise<T[]>
}

// Lists every check_suite for the given SHA and expands their check_runs into
// a flat AggregatedCheckRun[]. The suite-level app.slug is propagated onto
// each run so downstream filters (filter.ts) can decide based on the
// originating GitHub App.
export const fetchAllCheckRuns = async (
  octokit: OctokitLike,
  owner: string,
  repo: string,
  sha: string
): Promise<AggregatedCheckRun[]> => {
  const suites = await withRetry(
    () =>
      octokit.paginate<CheckSuiteData>(
        octokit.rest.checks.listSuitesForRef as never,
        { owner, repo, ref: sha, per_page: 100 }
      ),
    { retries: 3, baseDelayMs: 500 }
  )

  const runs: AggregatedCheckRun[] = []
  for (const suite of suites) {
    const slug = suite.app?.slug ?? 'unknown'
    const suiteRuns = await withRetry(
      () =>
        octokit.paginate<CheckRunData>(
          octokit.rest.checks.listForSuite as never,
          { owner, repo, check_suite_id: suite.id, per_page: 100 }
        ),
      { retries: 3, baseDelayMs: 500 }
    )
    for (const r of suiteRuns) {
      runs.push({
        id: r.id,
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        details_url: r.details_url,
        app: { slug },
        suite_id: suite.id
      })
    }
  }
  return runs
}

// Returns a memoizing lookup for an actions run's workflow path. Used by
// self-exclusion to drop check_runs that belong to the same workflow file
// as the currently executing run (covers cancelled siblings etc.).
export const createWorkflowPathLookup = (
  octokit: OctokitLike,
  owner: string,
  repo: string
): ((runId: number) => Promise<string | null>) => {
  const cache = new Map<number, string | null>()
  return async (runId: number) => {
    if (cache.has(runId)) {
      return cache.get(runId) ?? null
    }
    try {
      const result = await withRetry(
        () =>
          (
            octokit as unknown as {
              rest: {
                actions: {
                  getWorkflowRun: (params: {
                    owner: string
                    repo: string
                    run_id: number
                  }) => Promise<{ data: { path: string } }>
                }
              }
            }
          ).rest.actions.getWorkflowRun({ owner, repo, run_id: runId }),
        { retries: 3, baseDelayMs: 500 }
      )
      const path = result.data.path
      cache.set(runId, path)
      return path
    } catch {
      cache.set(runId, null)
      return null
    }
  }
}

// Exponential backoff retry. Retries only on 5xx errors (or errors with
// no `status` property, treated as transient). 4xx errors throw immediately.
export const withRetry = async <T>(
  fn: () => Promise<T>,
  options: { retries: number; baseDelayMs: number }
): Promise<T> => {
  let lastErr: unknown
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      const status = (err as { status?: number }).status
      if (status !== undefined && status < 500) throw err
      if (attempt === options.retries) throw err
      const delay = options.baseDelayMs * 2 ** attempt
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
