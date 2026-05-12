import { describe, it, expect } from 'vitest'
import {
  formatElapsed,
  formatPollTitle,
  formatPollBody,
  formatCheckResults
} from '../src/check-results.js'
import type { AggregatedCheckRun } from '../src/filter.js'

const make = (
  override: Partial<AggregatedCheckRun> = {}
): AggregatedCheckRun => ({
  id: 1,
  name: 'x',
  status: 'completed',
  conclusion: 'success',
  details_url: '',
  app: { slug: 'github-actions' },
  suite_id: 1,
  ...override
})

describe('formatElapsed', () => {
  it('formats 0 ms as 00:00', () => {
    expect(formatElapsed(0)).toBe('00:00')
  })

  it('formats sub-minute as 00:SS', () => {
    expect(formatElapsed(1_000)).toBe('00:01')
    expect(formatElapsed(59_000)).toBe('00:59')
  })

  it('formats minutes as MM:SS', () => {
    expect(formatElapsed(60_000)).toBe('01:00')
    expect(formatElapsed(125_000)).toBe('02:05')
    expect(formatElapsed(600_000)).toBe('10:00')
  })

  it('keeps growing past one hour (no hour rollover)', () => {
    expect(formatElapsed(3_600_000)).toBe('60:00')
    expect(formatElapsed(3_661_000)).toBe('61:01')
  })

  it('rounds down sub-second fractions', () => {
    expect(formatElapsed(1_999)).toBe('00:01')
  })
})

describe('formatPollTitle', () => {
  it('renders pending state with completed/total', () => {
    const title = formatPollTitle({
      elapsedMs: 5_000,
      iteration: 1,
      state: 'pending',
      completed: 8,
      total: 11
    })
    expect(title).toBe('[00:05] Poll #1 — pending, 8/11 completed')
  })

  it('renders success state', () => {
    const title = formatPollTitle({
      elapsedMs: 25_000,
      iteration: 3,
      state: 'success',
      completed: 11,
      total: 11
    })
    expect(title).toBe('[00:25] Poll #3 — success, 11/11 completed')
  })

  it('renders failure state', () => {
    const title = formatPollTitle({
      elapsedMs: 125_000,
      iteration: 7,
      state: 'failure',
      completed: 11,
      total: 11
    })
    expect(title).toBe('[02:05] Poll #7 — failure, 11/11 completed')
  })
})

describe('formatPollBody', () => {
  it('returns empty array for empty runs', () => {
    expect(formatPollBody([])).toEqual([])
  })

  it('uses green icon for success/skipped/neutral with conclusion text', () => {
    const lines = formatPollBody([
      make({ name: 'a', conclusion: 'success' }),
      make({ name: 'b', conclusion: 'skipped' }),
      make({ name: 'c', conclusion: 'neutral' })
    ])
    expect(lines).toEqual([
      '  ✅ a (success)',
      '  ✅ b (skipped)',
      '  ✅ c (neutral)'
    ])
  })

  it('uses red icon for failure/cancelled/timed_out with conclusion text', () => {
    const lines = formatPollBody([
      make({ name: 'a', conclusion: 'failure' }),
      make({ name: 'b', conclusion: 'cancelled' }),
      make({ name: 'c', conclusion: 'timed_out' })
    ])
    expect(lines).toEqual([
      '  ❌ a (failure)',
      '  ❌ b (cancelled)',
      '  ❌ c (timed_out)'
    ])
  })

  it('uses pending icon with status text for non-completed runs', () => {
    const lines = formatPollBody([
      make({ name: 'a', status: 'in_progress', conclusion: null }),
      make({ name: 'b', status: 'queued', conclusion: null })
    ])
    expect(lines).toEqual(['  🟡 a (in_progress)', '  🟡 b (queued)'])
  })

  it('uses pending icon when conclusion is null even if status is completed', () => {
    const lines = formatPollBody([
      make({ name: 'a', status: 'completed', conclusion: null })
    ])
    expect(lines).toEqual(['  🟡 a (completed)'])
  })

  it('sorts by name ascending', () => {
    const lines = formatPollBody([
      make({ name: 'zeta', conclusion: 'success' }),
      make({ name: 'alpha', conclusion: 'failure' }),
      make({ name: 'mu', status: 'queued', conclusion: null })
    ])
    expect(lines).toEqual([
      '  ❌ alpha (failure)',
      '  🟡 mu (queued)',
      '  ✅ zeta (success)'
    ])
  })
})

describe('formatCheckResults', () => {
  it('returns empty output for empty input', () => {
    const out = formatCheckResults([])
    expect(out.logLines).toEqual([])
    expect(out.summaryMarkdown).toBe('')
    expect(out.pendingCount).toBe(0)
  })

  it('outputs Failed section only when no passes', () => {
    const out = formatCheckResults([
      make({ name: 'a', conclusion: 'failure' }),
      make({ name: 'b', conclusion: 'cancelled' })
    ])
    expect(out.logLines).toEqual([
      '❌ Failed (2):',
      '  - a (failure)',
      '  - b (cancelled)'
    ])
    expect(out.summaryMarkdown).toContain('#### ❌ Failed (2)')
    expect(out.summaryMarkdown).not.toContain('Passed')
    expect(out.pendingCount).toBe(0)
  })

  it('outputs Passed section only when no failures', () => {
    const out = formatCheckResults([
      make({ name: 'a', conclusion: 'success' }),
      make({ name: 'b', conclusion: 'skipped' })
    ])
    expect(out.logLines).toEqual([
      '✅ Passed (2):',
      '  - a (success)',
      '  - b (skipped)'
    ])
    expect(out.summaryMarkdown).toContain('#### ✅ Passed (2)')
    expect(out.summaryMarkdown).not.toContain('Failed')
    expect(out.pendingCount).toBe(0)
  })

  it('outputs Failed before Passed when both present', () => {
    const out = formatCheckResults([
      make({ name: 'a', conclusion: 'success' }),
      make({ name: 'b', conclusion: 'failure' }),
      make({ name: 'c', conclusion: 'skipped' })
    ])
    expect(out.logLines).toEqual([
      '❌ Failed (1):',
      '  - b (failure)',
      '✅ Passed (2):',
      '  - a (success)',
      '  - c (skipped)'
    ])
  })

  it('sorts each section by name', () => {
    const out = formatCheckResults([
      make({ name: 'zeta', conclusion: 'success' }),
      make({ name: 'alpha', conclusion: 'success' }),
      make({ name: 'mu', conclusion: 'failure' }),
      make({ name: 'beta', conclusion: 'cancelled' })
    ])
    expect(out.logLines).toEqual([
      '❌ Failed (2):',
      '  - beta (cancelled)',
      '  - mu (failure)',
      '✅ Passed (2):',
      '  - alpha (success)',
      '  - zeta (success)'
    ])
  })

  it('counts pending runs but excludes them from sections', () => {
    const out = formatCheckResults([
      make({ name: 'a', conclusion: 'success' }),
      make({ name: 'b', status: 'in_progress', conclusion: null }),
      make({ name: 'c', status: 'queued', conclusion: null })
    ])
    expect(out.pendingCount).toBe(2)
    expect(out.logLines).toEqual(['✅ Passed (1):', '  - a (success)'])
  })

  it('writes summaryMarkdown as expected', () => {
    const out = formatCheckResults([
      make({ name: 'a', conclusion: 'success' }),
      make({ name: 'b', conclusion: 'failure' })
    ])
    expect(out.summaryMarkdown).toBe(
      [
        '### Check results',
        '',
        '#### ❌ Failed (1)',
        '- `b` — failure',
        '',
        '#### ✅ Passed (1)',
        '- `a` — success',
        ''
      ].join('\n')
    )
  })
})
