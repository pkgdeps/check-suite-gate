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

  it('splits on newlines (yaml `|` block scalar)', () => {
    expect(parseList('a\nb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('mixes commas and newlines', () => {
    expect(parseList('a, b\nc,d ')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('trims whitespace and blank lines', () => {
    expect(parseList('  a \n\n  b  \n\n')).toEqual(['a', 'b'])
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

  it('matches exact pattern with no glob metacharacters', () => {
    const result = applyFilters(runs, [], ['build'])
    expect(result.map((r) => r.name)).toEqual([
      'dependabot-check',
      'optional-flaky',
      'docs-only'
    ])
  })

  it('supports ? as a single-char wildcard', () => {
    const r = [make('x', 'build-1'), make('x', 'build-12')]
    expect(applyFilters(r, [], ['build-?']).map((x) => x.name)).toEqual([
      'build-12'
    ])
  })

  it('supports leading wildcards', () => {
    const r = [
      make('x', 'foo-build'),
      make('x', 'bar-build'),
      make('x', 'unrelated')
    ]
    expect(applyFilters(r, [], ['*-build']).map((x) => x.name)).toEqual([
      'unrelated'
    ])
  })

  it('matches across "/" (e.g. reusable-workflow names like "ci / lint")', () => {
    const r = [
      make('x', 'ci / lint'),
      make('x', 'ci / build'),
      make('x', 'unrelated')
    ]
    expect(applyFilters(r, [], ['ci*']).map((x) => x.name)).toEqual([
      'unrelated'
    ])
  })
})
