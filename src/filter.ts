import path from 'node:path'
import type { IgnoreRule } from './inputs.js'

// Aggregated check_run shape used across the action.
// Carries the suite-level app.slug so filters can decide based on the
// originating GitHub App (e.g. "dependabot", "github-actions").
// `workflow_path` is the path of the workflow file (e.g.
// ".github/workflows/ci-go.yaml"), populated lazily when any IgnoreRule
// declares a `workflow` field. `undefined` means "not resolved",
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

// path.matchesGlob is path-segment aware: '*' does not cross '/'.
// Check_run names from reusable workflows / matrix jobs often contain '/'
// (e.g. 'ci / lint'), and users expect 'ci*' to match those.
// Flatten by substituting '/' with a sentinel char absent from both
// names and glob patterns, on both the value and each pattern.
const SENTINEL = '\u0001'

const globMatches = (value: string, pattern: string): boolean => {
  const flat = value.replaceAll('/', SENTINEL)
  return path.matchesGlob(flat, pattern.replaceAll('/', SENTINEL))
}

// Workflow rules match against the *basename* of the workflow file path
// (e.g. "ci-go.yaml" out of ".github/workflows/ci-go.yaml"), because the
// basename is what users write in their config and what jq output shows.
// Workflow paths from the GitHub API always use forward slashes, so use
// `path.posix.basename` to stay correct on Windows runners (where the
// platform-default `path.basename` treats '/' as a regular character).
const workflowBasename = (workflowPath: string): string =>
  path.posix.basename(workflowPath)

// True if a single IgnoreRule matches a check_run. All present fields
// must match (AND); absent fields are wildcards. Rules with a `workflow`
// field never match runs without a resolved `workflow_path` — covers
// third-party Checks (null) and the "caller forgot to pre-resolve"
// case (undefined), keeping such rules conservative-by-default.
const ruleMatches = (rule: IgnoreRule, run: AggregatedCheckRun): boolean => {
  if (rule.app !== undefined && !globMatches(run.app.slug, rule.app)) {
    return false
  }
  if (rule.workflow !== undefined) {
    if (run.workflow_path === undefined || run.workflow_path === null) {
      return false
    }
    if (!globMatches(workflowBasename(run.workflow_path), rule.workflow)) {
      return false
    }
  }
  if (rule.name !== undefined && !globMatches(run.name, rule.name)) {
    return false
  }
  return true
}

// True if any rule in the list references the `workflow` field.
// Used by the gate to decide whether to pre-resolve workflow paths
// (an extra round of API calls) before applying filters.
export const hasWorkflowRule = (rules: IgnoreRule[]): boolean =>
  rules.some((r) => r.workflow !== undefined)

export const applyFilters = (
  runs: AggregatedCheckRun[],
  ignoreChecks: IgnoreRule[]
): AggregatedCheckRun[] =>
  runs.filter((run) => !ignoreChecks.some((rule) => ruleMatches(rule, run)))
