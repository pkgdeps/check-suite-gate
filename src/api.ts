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
    }
    repos: {
      createCommitStatus: (params: {
        owner: string
        repo: string
        sha: string
        state: 'pending' | 'success' | 'failure'
        context: string
        description?: string
        target_url?: string
      }) => Promise<unknown>
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
  const suites = await octokit.paginate<CheckSuiteData>(
    octokit.rest.checks.listSuitesForRef as never,
    { owner, repo, ref: sha, per_page: 100 }
  )

  const runs: AggregatedCheckRun[] = []
  for (const suite of suites) {
    const slug = suite.app?.slug ?? 'unknown'
    const suiteRuns = await octokit.paginate<CheckRunData>(
      octokit.rest.checks.listForSuite as never,
      { owner, repo, check_suite_id: suite.id, per_page: 100 }
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

// Polls listSuitesForRef until the trigger check_suite (the one whose
// completed event invoked the action) is reported as completed. Mitigates
// the eventual-consistency window where the trigger suite still appears
// in_progress in the API response right after the event fires.
export const waitForTriggerSuiteCompleted = async (
  octokit: OctokitLike,
  owner: string,
  repo: string,
  sha: string,
  triggerSuiteId: number,
  options: { attempts: number; delayMs: number } = {
    attempts: 5,
    delayMs: 2000
  }
): Promise<boolean> => {
  for (let i = 0; i < options.attempts; i++) {
    const { data } = await octokit.rest.checks.listSuitesForRef({
      owner,
      repo,
      ref: sha,
      per_page: 100
    })
    const trigger = data.check_suites.find((s) => s.id === triggerSuiteId)
    if (trigger !== undefined && trigger.status === 'completed') return true
    if (i < options.attempts - 1) {
      await new Promise((r) => setTimeout(r, options.delayMs))
    }
  }
  return false
}
