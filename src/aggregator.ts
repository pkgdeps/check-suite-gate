import { classify } from './conclusion.js'
import type { AggregatedCheckRun } from './filter.js'

export type State = 'pending' | 'success' | 'failure'

export type AggregateResult = {
  state: State
  total: number
  completed: number
}

// Aggregates the post-filter check_runs into a single state.
// Pure function — no I/O, no mode flags. The polling loop calls this
// repeatedly with the latest fetched runs and decides whether to keep
// polling (state === "pending") or finish (state === "success" | "failure").
export const aggregate = (runs: AggregatedCheckRun[]): AggregateResult => {
  const total = runs.length
  const completed = runs.filter((r) => r.status === 'completed').length

  const anyPending = runs.some((r) => classify(r) === 'pending')
  if (anyPending) {
    return { state: 'pending', total, completed }
  }

  const anyRed = runs.some((r) => classify(r) === 'red')
  if (anyRed) return { state: 'failure', total, completed }

  return { state: 'success', total, completed }
}
