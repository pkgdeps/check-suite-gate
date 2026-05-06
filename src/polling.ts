import { aggregate, type State } from './aggregator.js'
import type { AggregatedCheckRun } from './filter.js'

export type PollOptions = {
  intervalSeconds: number
}

export type PollResult = {
  state: State
  iterations: number
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

// Polls fetchRuns until aggregate(...) returns a terminal state (success
// or failure). The loop has no internal timeout — the caller is expected
// to bound execution via the workflow job's `timeout-minutes`. On runner
// kill, the commit status remains as it was last written.
//
// fetchRuns provides the (already-filtered, already-self-excluded) runs
// to aggregate; the caller can capture per-iteration bookkeeping via
// closure on the callback.
export const pollUntilComplete = async (
  fetchRuns: () => Promise<AggregatedCheckRun[]>,
  options: PollOptions
): Promise<PollResult> => {
  const intervalMs = options.intervalSeconds * 1000

  let iterations = 0
  while (true) {
    iterations++
    const runs = await fetchRuns()
    const result = aggregate(runs)

    if (result.state !== 'pending') {
      return { state: result.state, iterations }
    }

    await sleep(intervalMs)
  }
}
