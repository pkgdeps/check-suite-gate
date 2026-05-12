import { classify } from './conclusion.js'
import type { AggregatedCheckRun } from './filter.js'

export type CheckResultsFormatted = {
  logLines: string[]
  summaryMarkdown: string
  pendingCount: number
}

const pad2 = (n: number): string => n.toString().padStart(2, '0')

export const formatElapsed = (elapsedMs: number): string => {
  const totalSeconds = Math.floor(elapsedMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${pad2(minutes)}:${pad2(seconds)}`
}

export const formatPollTitle = (input: {
  elapsedMs: number
  iteration: number
  state: 'pending' | 'success' | 'failure'
  completed: number
  total: number
}): string => {
  const elapsed = formatElapsed(input.elapsedMs)
  return `[${elapsed}] Poll #${input.iteration} — ${input.state}, ${input.completed}/${input.total} completed`
}

const iconFor = (run: AggregatedCheckRun): string => {
  const v = classify(run)
  if (v === 'green') return '✅'
  if (v === 'red') return '❌'
  return '🟡'
}

// completed なら conclusion、未完了なら status を表示。
// conclusion === null + status === 'completed' というレアケースは status をそのまま出す。
const labelFor = (run: AggregatedCheckRun): string =>
  run.conclusion ?? run.status

export const formatPollBody = (runs: AggregatedCheckRun[]): string[] => {
  const sorted = [...runs].sort((a, b) => a.name.localeCompare(b.name))
  return sorted.map((r) => `  ${iconFor(r)} ${r.name} (${labelFor(r)})`)
}

export const formatCheckResults = (
  runs: AggregatedCheckRun[]
): CheckResultsFormatted => {
  const failed: AggregatedCheckRun[] = []
  const passed: AggregatedCheckRun[] = []
  let pendingCount = 0

  for (const run of runs) {
    const v = classify(run)
    if (v === 'green') passed.push(run)
    else if (v === 'red') failed.push(run)
    else pendingCount++
  }

  const byName = (a: AggregatedCheckRun, b: AggregatedCheckRun): number =>
    a.name.localeCompare(b.name)
  failed.sort(byName)
  passed.sort(byName)

  const logLines: string[] = []
  if (failed.length > 0) {
    logLines.push(`❌ Failed (${failed.length}):`)
    for (const r of failed) logLines.push(`  - ${r.name} (${labelFor(r)})`)
  }
  if (passed.length > 0) {
    logLines.push(`✅ Passed (${passed.length}):`)
    for (const r of passed) logLines.push(`  - ${r.name} (${labelFor(r)})`)
  }

  const summaryLines: string[] = []
  if (failed.length > 0 || passed.length > 0) {
    summaryLines.push('### Check results', '')
  }
  if (failed.length > 0) {
    summaryLines.push(`#### ❌ Failed (${failed.length})`)
    for (const r of failed)
      summaryLines.push(`- \`${r.name}\` — ${labelFor(r)}`)
    summaryLines.push('')
  }
  if (passed.length > 0) {
    summaryLines.push(`#### ✅ Passed (${passed.length})`)
    for (const r of passed)
      summaryLines.push(`- \`${r.name}\` — ${labelFor(r)}`)
    summaryLines.push('')
  }

  return {
    logLines,
    summaryMarkdown: summaryLines.join('\n'),
    pendingCount
  }
}
