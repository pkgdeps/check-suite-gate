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

describe('aggregate (normal mode)', () => {
  it('writes pending if any check_run is not completed', () => {
    const result = aggregate({
      runs: [make(), make({ status: 'in_progress', conclusion: null })],
      mode: 'normal'
    })
    expect(result.state).toBe('pending')
    expect(result.mode).toBe('normal')
  })

  it('writes success if all check_runs are green', () => {
    const result = aggregate({
      runs: [
        make({ conclusion: 'success' }),
        make({ conclusion: 'skipped' }),
        make({ conclusion: 'neutral' })
      ],
      mode: 'normal'
    })
    expect(result.state).toBe('success')
  })

  it('writes failure if any check_run is red', () => {
    const result = aggregate({
      runs: [make({ conclusion: 'success' }), make({ conclusion: 'failure' })],
      mode: 'normal'
    })
    expect(result.state).toBe('failure')
  })

  it('writes success when there are zero runs (vacuous)', () => {
    const result = aggregate({ runs: [], mode: 'normal' })
    expect(result.state).toBe('success')
  })
})

describe('aggregate (rescue mode)', () => {
  it('ignores in_progress runs and evaluates the rest', () => {
    const result = aggregate({
      runs: [
        make({ conclusion: 'success' }),
        make({ status: 'in_progress', conclusion: null })
      ],
      mode: 'rescue'
    })
    expect(result.state).toBe('success')
    expect(result.mode).toBe('rescue')
  })

  it('still fails if any completed run is red', () => {
    const result = aggregate({
      runs: [
        make({ conclusion: 'failure' }),
        make({ status: 'in_progress', conclusion: null })
      ],
      mode: 'rescue'
    })
    expect(result.state).toBe('failure')
  })

  it('writes success when only in_progress runs remain', () => {
    const result = aggregate({
      runs: [make({ status: 'in_progress', conclusion: null })],
      mode: 'rescue'
    })
    expect(result.state).toBe('success')
  })
})

describe('aggregate counts', () => {
  it('reports total / completed counts', () => {
    const result: AggregateResult = aggregate({
      runs: [
        make({ conclusion: 'success' }),
        make({ status: 'in_progress', conclusion: null })
      ],
      mode: 'normal'
    })
    expect(result.total).toBe(2)
    expect(result.completed).toBe(1)
  })
})
