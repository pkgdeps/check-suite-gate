import path from 'node:path'

// Aggregated check_run shape used across the action.
// Carries the suite-level app.slug so filters can decide based on the
// originating GitHub App (e.g. "dependabot", "github-actions").
export type AggregatedCheckRun = {
  id: number
  name: string
  status: string
  conclusion: string | null
  details_url: string
  app: { slug: string }
  suite_id: number
}

export const parseList = (raw: string): string[] =>
  raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

const matchesAnyGlob = (value: string, patterns: string[]): boolean =>
  patterns.some((pattern) => path.matchesGlob(value, pattern))

export const applyFilters = (
  runs: AggregatedCheckRun[],
  ignoreApps: string[],
  ignoreChecks: string[]
): AggregatedCheckRun[] =>
  runs.filter((run) => {
    if (ignoreApps.includes(run.app.slug)) return false
    if (ignoreChecks.length > 0 && matchesAnyGlob(run.name, ignoreChecks)) {
      return false
    }
    return true
  })
