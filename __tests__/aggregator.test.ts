import { describe, it, expect } from 'vitest'
import { aggregate, type AggregateResult } from '../src/aggregator.js'
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

describe('aggregate', () => {
  it('returns pending if any check_run is not completed', () => {
    const result = aggregate([
      make(),
      make({ status: 'in_progress', conclusion: null })
    ])
    expect(result.state).toBe('pending')
  })

  it('returns success if all check_runs are green', () => {
    const result = aggregate([
      make({ conclusion: 'success' }),
      make({ conclusion: 'skipped' }),
      make({ conclusion: 'neutral' })
    ])
    expect(result.state).toBe('success')
  })

  it('returns failure if any completed check_run is red', () => {
    const result = aggregate([
      make({ conclusion: 'success' }),
      make({ conclusion: 'failure' })
    ])
    expect(result.state).toBe('failure')
  })

  it('returns success when there are zero runs (vacuous)', () => {
    const result: AggregateResult = aggregate([])
    expect(result.state).toBe('success')
    expect(result.total).toBe(0)
    expect(result.completed).toBe(0)
  })

  it('reports total / completed counts', () => {
    const result = aggregate([
      make({ conclusion: 'success' }),
      make({ status: 'in_progress', conclusion: null })
    ])
    expect(result.total).toBe(2)
    expect(result.completed).toBe(1)
  })
})
