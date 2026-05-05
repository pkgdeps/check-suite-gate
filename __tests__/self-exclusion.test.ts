import { describe, it, expect } from 'vitest'
import {
  RUN_ID_REGEX,
  extractRunId,
  isOwnRun,
  excludeOwnRuns
} from '../src/self-exclusion.js'
import type { AggregatedCheckRun } from '../src/filter.js'

const make = (appSlug: string, detailsUrl: string): AggregatedCheckRun => ({
  id: 1,
  name: 'test',
  status: 'completed',
  conclusion: 'success',
  details_url: detailsUrl,
  app: { slug: appSlug },
  suite_id: 1
})

describe('RUN_ID_REGEX', () => {
  it('matches the documented details_url shape and asserts on extraction', () => {
    const url = 'https://github.com/owner/repo/actions/runs/12345/job/67890'
    const match = url.match(RUN_ID_REGEX)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe('12345')
  })

  it('does NOT match unrelated URLs (guards against silent format change)', () => {
    expect(
      'https://github.com/owner/repo/pull/1'.match(RUN_ID_REGEX)
    ).toBeNull()
    expect('https://example.com'.match(RUN_ID_REGEX)).toBeNull()
  })
})

describe('extractRunId', () => {
  it('returns the numeric run_id from a valid details_url', () => {
    expect(
      extractRunId('https://github.com/owner/repo/actions/runs/42/job/100')
    ).toBe(42)
  })
  it('returns null for non-matching URLs', () => {
    expect(extractRunId('https://example.com')).toBeNull()
  })
})

describe('isOwnRun', () => {
  it('flags github-actions check_runs whose run_id matches GITHUB_RUN_ID', () => {
    const run = make(
      'github-actions',
      'https://github.com/owner/repo/actions/runs/9999/job/1'
    )
    expect(isOwnRun(run, 9999)).toBe(true)
  })

  it('does not flag check_runs from other apps even with the same run_id', () => {
    const run = make(
      'cloudflare-pages',
      'https://github.com/owner/repo/actions/runs/9999/job/1'
    )
    expect(isOwnRun(run, 9999)).toBe(false)
  })

  it('does not flag check_runs with a different run_id', () => {
    const run = make(
      'github-actions',
      'https://github.com/owner/repo/actions/runs/1/job/1'
    )
    expect(isOwnRun(run, 9999)).toBe(false)
  })

  it('does not flag check_runs with a malformed details_url', () => {
    const run = make('github-actions', 'https://example.com')
    expect(isOwnRun(run, 9999)).toBe(false)
  })
})

describe('excludeOwnRuns', () => {
  it('removes only own runs and preserves order of others', () => {
    const runs = [
      make('github-actions', 'https://github.com/o/r/actions/runs/1/job/1'),
      make('github-actions', 'https://github.com/o/r/actions/runs/9999/job/1'),
      make(
        'cloudflare-pages',
        'https://github.com/o/r/actions/runs/9999/job/1'
      ),
      make('github-actions', 'https://github.com/o/r/actions/runs/9999/job/2')
    ]
    const result = excludeOwnRuns(runs, 9999)
    expect(result).toHaveLength(2)
    expect(result[0].details_url).toContain('runs/1/')
    expect(result[1].app.slug).toBe('cloudflare-pages')
  })
})
