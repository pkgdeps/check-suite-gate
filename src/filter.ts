import path from 'node:path'

// Aggregated check_run shape used across the action.
// Carries the suite-level app.slug so filters can decide based on the
// originating GitHub App (e.g. "dependabot", "github-actions").
// `workflow_path` is the path of the workflow file (e.g.
// ".github/workflows/ci-go.yaml"), populated lazily when ignore-checks
// contains a workflow-qualified pattern. `undefined` means "not resolved",
// `null` means "resolved but not applicable" (e.g. third-party app).
export type AggregatedCheckRun = {
  id: number
  name: string
  status: string
  conclusion: string | null
  details_url: string
  app: { slug: string }
  suite_id: number
  workflow_path?: string | null
}

export const parseList = (raw: string): string[] =>
  raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

// Detects whether a pattern is workflow-qualified.
// The qualifier is `.yaml::` or `.yml::` so unqualified patterns (today's
// behavior) keep working, and the chance of false-positive collision with
// a literal check_run.name is effectively zero — a check_run.name would
// have to embed a workflow-file-shaped substring like "ci.yaml::lint",
// which doesn't occur in practice.
const QUALIFIER_REGEX = /^(.*?\.ya?ml)::(.*)$/

export const isWorkflowQualifiedPattern = (pattern: string): boolean =>
  /\.ya?ml::/.test(pattern)

export const hasWorkflowQualifiedPattern = (patterns: string[]): boolean =>
  patterns.some((p) => isWorkflowQualifiedPattern(p))

type SplitPattern = { workflow: string; name: string }

const splitQualifiedPattern = (pattern: string): SplitPattern | null => {
  const match = pattern.match(QUALIFIER_REGEX)
  if (match === null) return null
  return { workflow: match[1], name: match[2] }
}

const matchesAnyGlob = (value: string, patterns: string[]): boolean => {
  // path.matchesGlob is path-segment aware: '*' does not cross '/'.
  // Check_run names from reusable workflows / matrix jobs often contain '/'
  // (e.g. 'ci / lint'), and users expect 'ci*' to match those.
  // Flatten by substituting '/' with a sentinel char absent from both
  // names and glob patterns, on both the value and each pattern.
  const SENTINEL = ''
  const flat = value.replaceAll('/', SENTINEL)
  return patterns.some((pattern) =>
    path.matchesGlob(flat, pattern.replaceAll('/', SENTINEL))
  )
}

// Matches a single ignore-checks pattern against a check_run.
// - Unqualified pattern: glob-match against run.name (existing behavior,
//   matches across all workflows that produce a check_run with that name).
// - Qualified pattern (`<workflow>.ya?ml::<name>`): glob-match the workflow
//   file's basename AND the check_run name. Runs without a known
//   workflow_path (third-party apps, unresolved) never match a qualified
//   pattern.
const matchesIgnorePattern = (
  run: AggregatedCheckRun,
  pattern: string
): boolean => {
  const qualified = splitQualifiedPattern(pattern)
  if (qualified === null) {
    return matchesAnyGlob(run.name, [pattern])
  }
  if (run.workflow_path === undefined || run.workflow_path === null) {
    return false
  }
  const basename = path.basename(run.workflow_path)
  return (
    matchesAnyGlob(basename, [qualified.workflow]) &&
    matchesAnyGlob(run.name, [qualified.name])
  )
}

export const applyFilters = (
  runs: AggregatedCheckRun[],
  ignoreApps: string[],
  ignoreChecks: string[]
): AggregatedCheckRun[] =>
  runs.filter((run) => {
    if (ignoreApps.includes(run.app.slug)) return false
    if (ignoreChecks.some((p) => matchesIgnorePattern(run, p))) return false
    return true
  })
