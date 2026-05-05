import { describe, it, expect, vi } from 'vitest'
import {
  fetchAllCheckRuns,
  withRetry,
  waitForTriggerSuiteCompleted,
  type OctokitLike
} from '../src/api.js'

describe('fetchAllCheckRuns', () => {
  it('fetches suites and flattens runs across pages', async () => {
    const listSuites = vi.fn()
    const listForSuite = vi.fn(
      async ({ check_suite_id }: { check_suite_id: number }) => ({
        data: {
          check_runs: [
            {
              id: check_suite_id * 10,
              name: `suite-${check_suite_id}-run`,
              status: 'completed',
              conclusion: 'success',
              details_url: ''
            }
          ]
        }
      })
    )

    const octokit: OctokitLike = {
      rest: {
        checks: {
          listSuitesForRef: listSuites,
          listForSuite
        },
        repos: {
          createCommitStatus: vi.fn()
        }
      },
      paginate: async (fn: unknown, params: unknown) => {
        const res = await (fn as (p: unknown) => Promise<{ data: unknown }>)(
          params
        )
        const data = (
          res as {
            data: { check_suites?: unknown[]; check_runs?: unknown[] }
          }
        ).data
        if (data.check_suites !== undefined) return data.check_suites
        if (data.check_runs !== undefined) return data.check_runs
        return []
      }
    } as unknown as OctokitLike

    listSuites.mockResolvedValueOnce({
      data: {
        check_suites: [
          { id: 1, app: { slug: 'github-actions' }, status: 'completed' },
          { id: 2, app: { slug: 'cloudflare-pages' }, status: 'completed' }
        ]
      }
    })

    const result = await fetchAllCheckRuns(octokit, 'owner', 'repo', 'abc')
    expect(result).toHaveLength(2)
    expect(result[0].suite_id).toBe(1)
    expect(result[1].suite_id).toBe(2)
    expect(result[0].app.slug).toBe('github-actions')
    expect(result[1].app.slug).toBe('cloudflare-pages')
  })

  it('treats null suite app as "unknown" slug', async () => {
    const octokit: OctokitLike = {
      rest: {
        checks: {
          listSuitesForRef: vi.fn().mockResolvedValueOnce({
            data: { check_suites: [{ id: 1, app: null, status: 'completed' }] }
          }),
          listForSuite: vi.fn().mockResolvedValueOnce({
            data: {
              check_runs: [
                {
                  id: 10,
                  name: 'r',
                  status: 'completed',
                  conclusion: 'success',
                  details_url: ''
                }
              ]
            }
          })
        },
        repos: { createCommitStatus: vi.fn() }
      },
      paginate: async (fn: unknown, params: unknown) => {
        const res = await (fn as (p: unknown) => Promise<{ data: unknown }>)(
          params
        )
        const d = (
          res as { data: { check_suites?: unknown[]; check_runs?: unknown[] } }
        ).data
        return (d.check_suites ?? d.check_runs ?? []) as unknown[]
      }
    } as unknown as OctokitLike

    const result = await fetchAllCheckRuns(octokit, 'o', 'r', 'sha')
    expect(result[0].app.slug).toBe('unknown')
  })
})

describe('withRetry', () => {
  it('returns the value on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok')
    expect(await withRetry(fn, { retries: 3, baseDelayMs: 1 })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on 5xx errors', async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockRejectedValueOnce({ status: 502 })
      .mockResolvedValue('ok')
    expect(await withRetry(fn, { retries: 3, baseDelayMs: 1 })).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does not retry on 4xx errors', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 404 })
    await expect(withRetry(fn, { retries: 3, baseDelayMs: 1 })).rejects.toEqual(
      { status: 404 }
    )
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('gives up after the retry budget', async () => {
    const fn = vi.fn().mockRejectedValue({ status: 503 })
    await expect(withRetry(fn, { retries: 2, baseDelayMs: 1 })).rejects.toEqual(
      { status: 503 }
    )
    expect(fn).toHaveBeenCalledTimes(3)
  })
})

describe('waitForTriggerSuiteCompleted', () => {
  it('returns true once the trigger suite is completed', async () => {
    const listSuites = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          check_suites: [{ id: 1, app: { slug: 'x' }, status: 'in_progress' }]
        }
      })
      .mockResolvedValueOnce({
        data: {
          check_suites: [{ id: 1, app: { slug: 'x' }, status: 'completed' }]
        }
      })
    const octokit = {
      rest: { checks: { listSuitesForRef: listSuites } }
    } as unknown as OctokitLike
    const ok = await waitForTriggerSuiteCompleted(octokit, 'o', 'r', 'sha', 1, {
      attempts: 3,
      delayMs: 1
    })
    expect(ok).toBe(true)
    expect(listSuites).toHaveBeenCalledTimes(2)
  })

  it('returns false if it never completes within the budget', async () => {
    const listSuites = vi.fn().mockResolvedValue({
      data: {
        check_suites: [{ id: 1, app: { slug: 'x' }, status: 'in_progress' }]
      }
    })
    const octokit = {
      rest: { checks: { listSuitesForRef: listSuites } }
    } as unknown as OctokitLike
    const ok = await waitForTriggerSuiteCompleted(octokit, 'o', 'r', 'sha', 1, {
      attempts: 2,
      delayMs: 1
    })
    expect(ok).toBe(false)
    expect(listSuites).toHaveBeenCalledTimes(2)
  })
})
