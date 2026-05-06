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
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

const matchesAnyGlob = (value: string, patterns: string[]): boolean => {
  // path.matchesGlob is path-segment aware: '*' does not cross '/'.
  // Check_run names from reusable workflows / matrix jobs often contain '/'
  // (e.g. 'ci / lint'), and users expect 'ci*' to match those.
  // Flatten by substituting '/' with a sentinel char absent from both
  // names and glob patterns, on both the value and each pattern.
  const SENTINEL = '\u0001'
  const flat = value.replaceAll('/', SENTINEL)
  return patterns.some((pattern) =>
    path.matchesGlob(flat, pattern.replaceAll('/', SENTINEL))
  )
}

export const applyFilters = (
  runs: AggregatedCheckRun[],
  ignoreApps: string[],
  ignoreChecks: string[]
): AggregatedCheckRun[] =>
  runs.filter((run) => {
    if (ignoreApps.includes(run.app.slug)) return false
    if (matchesAnyGlob(run.name, ignoreChecks)) return false
    return true
  })
