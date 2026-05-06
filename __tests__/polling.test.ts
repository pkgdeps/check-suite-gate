import { describe, it, expect, vi } from 'vitest'
import { pollUntilComplete } from '../src/polling.js'
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

const opts = { intervalSeconds: 0.001 } // 1 ms — keep test fast

describe('pollUntilComplete', () => {
  it('exits success on the first iteration when all runs are completed green', async () => {
    const fetchRuns = vi
      .fn()
      .mockResolvedValue([make({ conclusion: 'success' })])
    const result = await pollUntilComplete(fetchRuns, opts)
    expect(result.state).toBe('success')
    expect(result.iterations).toBe(1)
    expect(fetchRuns).toHaveBeenCalledTimes(1)
  })

  it('exits failure when a completed red run is present', async () => {
    const fetchRuns = vi
      .fn()
      .mockResolvedValue([make({ conclusion: 'failure' })])
    const result = await pollUntilComplete(fetchRuns, opts)
    expect(result.state).toBe('failure')
  })

  it('keeps polling while pending, then exits when checks complete', async () => {
    const fetchRuns = vi
      .fn()
      .mockResolvedValueOnce([
        make({ status: 'in_progress', conclusion: null })
      ])
      .mockResolvedValueOnce([
        make({ status: 'in_progress', conclusion: null })
      ])
      .mockResolvedValueOnce([make({ conclusion: 'success' })])
    const result = await pollUntilComplete(fetchRuns, opts)
    expect(result.state).toBe('success')
    expect(result.iterations).toBe(3)
  })

  it('exposes evaluated count via the fetchRuns callback (caller-managed)', async () => {
    let capturedSize = 0
    const fetchRuns = async () => {
      const runs = [make({ conclusion: 'success' })]
      capturedSize = runs.length
      return runs
    }
    const result = await pollUntilComplete(fetchRuns, opts)
    expect(result.state).toBe('success')
    expect(capturedSize).toBe(1)
  })

  it('calls onIteration once per iteration with the right shape', async () => {
    const fetchRuns = vi
      .fn()
      .mockResolvedValueOnce([
        make({ status: 'in_progress', conclusion: null }),
        make({ id: 2, conclusion: 'success' })
      ])
      .mockResolvedValueOnce([
        make({ conclusion: 'success' }),
        make({ id: 2, conclusion: 'success' })
      ])
    const snapshots: Array<{
      iteration: number
      state: string
      total: number
      completed: number
    }> = []
    const result = await pollUntilComplete(fetchRuns, {
      ...opts,
      onIteration: (s) => {
        snapshots.push(s)
      }
    })
    expect(result.state).toBe('success')
    expect(result.iterations).toBe(2)
    expect(snapshots).toEqual([
      { iteration: 1, state: 'pending', total: 2, completed: 1 },
      { iteration: 2, state: 'success', total: 2, completed: 2 }
    ])
  })

  it('tolerates fetchRuns errors and continues polling', async () => {
    const fetchRuns = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient API error'))
      .mockResolvedValueOnce([
        make({ status: 'in_progress', conclusion: null })
      ])
      .mockRejectedValueOnce({ status: 503 })
      .mockResolvedValueOnce([make({ conclusion: 'success' })])
    const result = await pollUntilComplete(fetchRuns, opts)
    expect(result.state).toBe('success')
    expect(result.iterations).toBe(4)
    expect(fetchRuns).toHaveBeenCalledTimes(4)
  })
})
