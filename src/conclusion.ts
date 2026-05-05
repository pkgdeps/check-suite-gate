// Classifies a check_run's (status, conclusion) into the GitHub-standard
// verdicts used for required status checks: green, red, or pending.
// See: https://docs.github.com/en/articles/about-status-checks

export type Verdict = 'green' | 'red' | 'pending'

export type CheckRunLike = {
  status: string
  conclusion: string | null
}

const GREEN_CONCLUSIONS = new Set(['success', 'skipped', 'neutral'])
const RED_CONCLUSIONS = new Set([
  'failure',
  'cancelled',
  'timed_out',
  'action_required'
])

export const classify = (run: CheckRunLike): Verdict => {
  if (run.status !== 'completed') return 'pending'
  if (run.conclusion === null) return 'pending'
  if (GREEN_CONCLUSIONS.has(run.conclusion)) return 'green'
  if (RED_CONCLUSIONS.has(run.conclusion)) return 'red'
  return 'red'
}
