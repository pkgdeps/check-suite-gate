import { describe, it, expect } from 'vitest'
import {
  applyFilters,
  hasWorkflowQualifiedPattern,
  isWorkflowQualifiedPattern,
  parseList,
  type AggregatedCheckRun
} from '../src/filter.js'

const make = (
  appSlug: string,
  name: string,
  workflowPath?: string | null
): AggregatedCheckRun => ({
  id: 1,
  name,
  status: 'completed',
  conclusion: 'success',
  details_url: '',
  app: { slug: appSlug },
  suite_id: 1,
  workflow_path: workflowPath
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

  describe('workflow-qualified pattern (`<workflow>.ya?ml::<name>`)', () => {
    // Two same-named "lint" check_runs from different workflows. The whole
    // point of qualifying is to be able to ignore one without the other.
    const goLint = make(
      'github-actions',
      'lint',
      '.github/workflows/ci-go.yaml'
    )
    const pyLint = make(
      'github-actions',
      'lint',
      '.github/workflows/ci-python.yaml'
    )

    it('targets only the matching workflow file (basename)', () => {
      const result = applyFilters([goLint, pyLint], [], ['ci-go.yaml::lint'])
      expect(result.map((r) => r.workflow_path)).toEqual([
        '.github/workflows/ci-python.yaml'
      ])
    })

    it('supports .yml extension', () => {
      const goLintYml = make(
        'github-actions',
        'lint',
        '.github/workflows/ci-go.yml'
      )
      const result = applyFilters([goLintYml, pyLint], [], ['ci-go.yml::lint'])
      expect(result.map((r) => r.workflow_path)).toEqual([
        '.github/workflows/ci-python.yaml'
      ])
    })

    it('supports glob on the workflow side', () => {
      const result = applyFilters([goLint, pyLint], [], ['ci-*.yaml::lint'])
      expect(result).toEqual([])
    })

    it('supports glob on the name side', () => {
      const goTest = make(
        'github-actions',
        'test',
        '.github/workflows/ci-go.yaml'
      )
      const result = applyFilters(
        [goLint, goTest, pyLint],
        [],
        ['ci-go.yaml::*']
      )
      expect(result.map((r) => r.name)).toEqual(['lint'])
    })

    it('does not match runs without a resolved workflow_path', () => {
      // Third-party app (e.g. Codecov) — workflow_path is null.
      const codecov = make('codecov', 'lint', null)
      const result = applyFilters([goLint, codecov], [], ['ci-go.yaml::lint'])
      expect(result.map((r) => r.app.slug)).toEqual(['codecov'])
    })

    it('does not match runs with undefined workflow_path (pre-resolve skipped)', () => {
      // Field missing entirely — caller did not pre-resolve workflow paths.
      // A qualified pattern must not silently match in this case.
      const run = make('github-actions', 'lint')
      delete run.workflow_path
      const result = applyFilters([run], [], ['ci-go.yaml::lint'])
      expect(result.length).toBe(1)
    })

    it('unqualified pattern still matches across all workflows', () => {
      const result = applyFilters([goLint, pyLint], [], ['lint'])
      expect(result).toEqual([])
    })

    it('mixed qualified and unqualified patterns combine (union)', () => {
      const docs = make('github-actions', 'docs', '.github/workflows/docs.yaml')
      const result = applyFilters(
        [goLint, pyLint, docs],
        [],
        ['ci-go.yaml::lint', 'docs']
      )
      expect(result.map((r) => r.workflow_path)).toEqual([
        '.github/workflows/ci-python.yaml'
      ])
    })

    it('treats `::` without .ya?ml extension as a literal pattern (no collision)', () => {
      // `build::release` is a regular pattern, not workflow-qualified.
      // It should match check_run.name === "build::release" literally,
      // not split on `::`.
      const literal = make(
        'github-actions',
        'build::release',
        '.github/workflows/ci.yaml'
      )
      const result = applyFilters([literal], [], ['build::release'])
      expect(result).toEqual([])
    })
  })
})

describe('isWorkflowQualifiedPattern', () => {
  it('returns true for `.yaml::` patterns', () => {
    expect(isWorkflowQualifiedPattern('ci-go.yaml::lint')).toBe(true)
  })

  it('returns true for `.yml::` patterns', () => {
    expect(isWorkflowQualifiedPattern('ci.yml::test')).toBe(true)
  })

  it('returns false for unqualified patterns', () => {
    expect(isWorkflowQualifiedPattern('lint')).toBe(false)
    expect(isWorkflowQualifiedPattern('build::release')).toBe(false)
    expect(isWorkflowQualifiedPattern('optional-*')).toBe(false)
  })
})

describe('hasWorkflowQualifiedPattern', () => {
  it('returns true if any pattern is qualified', () => {
    expect(hasWorkflowQualifiedPattern(['lint', 'ci.yaml::test'])).toBe(true)
  })

  it('returns false if all patterns are unqualified', () => {
    expect(hasWorkflowQualifiedPattern(['lint', 'optional-*'])).toBe(false)
  })

  it('returns false for an empty list', () => {
    expect(hasWorkflowQualifiedPattern([])).toBe(false)
  })
})
