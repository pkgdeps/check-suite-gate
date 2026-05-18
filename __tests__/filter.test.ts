import { describe, it, expect } from 'vitest'
import {
  applyFilters,
  hasWorkflowRule,
  type AggregatedCheckRun
} from '../src/filter.js'
import type { IgnoreRule } from '../src/inputs.js'

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

describe('applyFilters', () => {
  const runs = [
    make('github-actions', 'build'),
    make('dependabot', 'dependabot-check'),
    make('github-actions', 'optional-flaky'),
    make('github-actions', 'docs-only')
  ]

  it('returns all runs when no rules are provided', () => {
    expect(applyFilters(runs, []).length).toBe(4)
  })

  it('excludes by app exact match', () => {
    const result = applyFilters(runs, [{ app: 'dependabot' }])
    expect(result.map((r) => r.name)).toEqual([
      'build',
      'optional-flaky',
      'docs-only'
    ])
  })

  it('excludes by name exact match', () => {
    const result = applyFilters(runs, [{ name: 'build' }])
    expect(result.map((r) => r.name)).toEqual([
      'dependabot-check',
      'optional-flaky',
      'docs-only'
    ])
  })

  it('excludes by name glob', () => {
    const result = applyFilters(runs, [
      { name: 'optional-*' },
      { name: 'docs-only' }
    ])
    expect(result.map((r) => r.name)).toEqual(['build', 'dependabot-check'])
  })

  it('combines multiple rules as a union (any matching rule excludes)', () => {
    const result = applyFilters(runs, [
      { app: 'dependabot' },
      { name: 'optional-*' }
    ])
    expect(result.map((r) => r.name)).toEqual(['build', 'docs-only'])
  })

  it('AND-evaluates app + name within a single rule', () => {
    // app=github-actions AND name=build → only 'build' (the dependabot run
    // is not github-actions, so it is kept even though name="dependabot-check"
    // does not match `build` either).
    const result = applyFilters(runs, [
      { app: 'github-actions', name: 'build' }
    ])
    expect(result.map((r) => r.name)).toEqual([
      'dependabot-check',
      'optional-flaky',
      'docs-only'
    ])
  })

  it('supports ? as a single-char wildcard', () => {
    const r = [make('x', 'build-1'), make('x', 'build-12')]
    expect(applyFilters(r, [{ name: 'build-?' }]).map((x) => x.name)).toEqual([
      'build-12'
    ])
  })

  it('supports leading wildcards on name', () => {
    const r = [
      make('x', 'foo-build'),
      make('x', 'bar-build'),
      make('x', 'unrelated')
    ]
    expect(applyFilters(r, [{ name: '*-build' }]).map((x) => x.name)).toEqual([
      'unrelated'
    ])
  })

  it('matches names containing "/" (reusable-workflow style)', () => {
    const r = [
      make('x', 'ci / lint'),
      make('x', 'ci / build'),
      make('x', 'unrelated')
    ]
    expect(applyFilters(r, [{ name: 'ci*' }]).map((x) => x.name)).toEqual([
      'unrelated'
    ])
  })

  it('supports glob on app slug', () => {
    const r = [
      make('codecov', 'coverage'),
      make('codecov-staging', 'staging-cov'),
      make('github-actions', 'lint')
    ]
    expect(
      applyFilters(r, [{ app: 'codecov*' }]).map((x) => x.app.slug)
    ).toEqual(['github-actions'])
  })

  describe('workflow field', () => {
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

    it('targets the matching workflow file (basename)', () => {
      const result = applyFilters(
        [goLint, pyLint],
        [{ workflow: 'ci-go.yaml', name: 'lint' }]
      )
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
      const result = applyFilters(
        [goLintYml, pyLint],
        [{ workflow: 'ci-go.yml', name: 'lint' }]
      )
      expect(result.map((r) => r.workflow_path)).toEqual([
        '.github/workflows/ci-python.yaml'
      ])
    })

    it('supports glob on the workflow side', () => {
      const result = applyFilters(
        [goLint, pyLint],
        [{ workflow: 'ci-*.yaml', name: 'lint' }]
      )
      expect(result).toEqual([])
    })

    it('does not match runs with null workflow_path (third-party app)', () => {
      const codecov = make('codecov', 'lint', null)
      const result = applyFilters(
        [goLint, codecov],
        [{ workflow: 'ci-go.yaml', name: 'lint' }]
      )
      expect(result.map((r) => r.app.slug)).toEqual(['codecov'])
    })

    it('does not match runs with undefined workflow_path (pre-resolve skipped)', () => {
      const run = make('github-actions', 'lint')
      delete run.workflow_path
      const result = applyFilters(
        [run],
        [{ workflow: 'ci-go.yaml', name: 'lint' }]
      )
      expect(result.length).toBe(1)
    })

    it('matches when only workflow is set (any name within that workflow)', () => {
      const goTest = make(
        'github-actions',
        'test',
        '.github/workflows/ci-go.yaml'
      )
      const result = applyFilters(
        [goLint, goTest, pyLint],
        [{ workflow: 'ci-go.yaml' }]
      )
      expect(result.map((r) => r.workflow_path)).toEqual([
        '.github/workflows/ci-python.yaml'
      ])
    })
  })

  describe('app + name combination', () => {
    // The motivating Xcode Cloud scenario: two apps both produce a check
    // whose name is "Build". ignore-checks must be able to target one
    // without the other.
    const xcodeBuild = make('xcode-cloud', 'Build')
    const actionsBuild = make('github-actions', 'Build')

    it('targets only the matching app', () => {
      const result = applyFilters(
        [xcodeBuild, actionsBuild],
        [{ app: 'xcode-cloud', name: 'Build' }]
      )
      expect(result.map((r) => r.app.slug)).toEqual(['github-actions'])
    })

    it('supports glob on both app and name', () => {
      const result = applyFilters(
        [
          xcodeBuild,
          make('xcode-cloud', 'Build (release)'),
          make('xcode-cloud', 'Test'),
          actionsBuild
        ],
        [{ app: 'xcode-cloud', name: 'Build*' }]
      )
      expect(result.map((r) => r.name)).toEqual(['Test', 'Build'])
    })
  })
})

describe('hasWorkflowRule', () => {
  it('returns true if any rule has a `workflow` field', () => {
    const rules: IgnoreRule[] = [
      { app: 'dependabot' },
      { workflow: 'ci.yaml', name: 'lint' }
    ]
    expect(hasWorkflowRule(rules)).toBe(true)
  })

  it('returns false if no rule has a `workflow` field', () => {
    const rules: IgnoreRule[] = [{ app: 'dependabot' }, { name: 'optional-*' }]
    expect(hasWorkflowRule(rules)).toBe(false)
  })

  it('returns false for an empty list', () => {
    expect(hasWorkflowRule([])).toBe(false)
  })
})
