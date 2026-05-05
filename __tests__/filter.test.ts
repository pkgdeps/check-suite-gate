import { describe, it, expect } from 'vitest'
import {
  applyFilters,
  parseList,
  type AggregatedCheckRun
} from '../src/filter.js'

const make = (appSlug: string, name: string): AggregatedCheckRun => ({
  id: 1,
  name,
  status: 'completed',
  conclusion: 'success',
  details_url: '',
  app: { slug: appSlug },
  suite_id: 1
})

describe('parseList', () => {
  it('splits and trims comma-separated values', () => {
    expect(parseList('a, b,c ,')).toEqual(['a', 'b', 'c'])
  })
  it('returns an empty array for empty / whitespace-only input', () => {
    expect(parseList('')).toEqual([])
    expect(parseList('   ')).toEqual([])
  })
})

describe('applyFilters', () => {
  const runs = [
    make('github-actions', 'build'),
    make('dependabot', 'dependabot-check'),
    make('github-actions', 'optional-flaky'),
    make('github-actions', 'docs-only')
  ]

  it('filters by app slug (exact match)', () => {
    const result = applyFilters(runs, ['dependabot'], [])
    expect(result.map((r) => r.name)).toEqual([
      'build',
      'optional-flaky',
      'docs-only'
    ])
  })

  it('filters by check name with glob', () => {
    const result = applyFilters(runs, [], ['optional-*', 'docs-only'])
    expect(result.map((r) => r.name)).toEqual(['build', 'dependabot-check'])
  })

  it('filters by app and check together (union of exclusions)', () => {
    const result = applyFilters(runs, ['dependabot'], ['optional-*'])
    expect(result.map((r) => r.name)).toEqual(['build', 'docs-only'])
  })

  it('returns all runs when both filters are empty', () => {
    expect(applyFilters(runs, [], []).length).toBe(4)
  })
})
