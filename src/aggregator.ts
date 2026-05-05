import { classify } from './conclusion.js'
import type { AggregatedCheckRun } from './filter.js'

export type Mode = 'normal' | 'rescue'
export type State = 'pending' | 'success' | 'failure'

export type AggregateInput = {
  runs: AggregatedCheckRun[]
  mode: Mode
}

export type AggregateResult = {
  state: State
  mode: Mode
  total: number
  completed: number
}

// Aggregates the post-filter check_runs into a single state.
//
// normal mode (run_attempt == 1):
//   any pending run -> overall pending. all completed -> AND of conclusions.
//
// rescue mode (run_attempt > 1, maintainer pressed Re-run all jobs):
//   in_progress runs are treated as "stuck" and excluded; the verdict
//   is decided from the runs that did complete. If only in_progress runs
//   remain, success (vacuous) — the maintainer explicitly chose to rescue.
export const aggregate = (input: AggregateInput): AggregateResult => {
  const { runs, mode } = input
  const total = runs.length
  const completed = runs.filter((r) => r.status === 'completed').length

  if (mode === 'normal') {
    const anyPending = runs.some((r) => classify(r) === 'pending')
    if (anyPending) {
      return { state: 'pending', mode, total, completed }
    }
  }

  const consideredRuns =
    mode === 'rescue' ? runs.filter((r) => r.status === 'completed') : runs

  const anyRed = consideredRuns.some((r) => classify(r) === 'red')
  if (anyRed) return { state: 'failure', mode, total, completed }

  return { state: 'success', mode, total, completed }
}
