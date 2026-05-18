import { describe, it, expect, vi } from 'vitest'
import {
  RUN_ID_REGEX,
  extractRunId,
  parseCurrentWorkflowPath,
  isFromSameWorkflow,
  excludeOwnWorkflowRuns,
  resolveWorkflowPaths
} from '../src/self-exclusion.js'
import type { AggregatedCheckRun } from '../src/filter.js'

const make = (
  appSlug: string,
  detailsUrl: string,
  override: Partial<AggregatedCheckRun> = {}
): AggregatedCheckRun => ({
  id: 1,
  name: 'gate',
  status: 'completed',
  conclusion: 'cancelled',
  details_url: detailsUrl,
  app: { slug: appSlug },
  suite_id: 1,
  ...override
})

describe('RUN_ID_REGEX', () => {
  it('matches the documented details_url shape', () => {
    const url = 'https://github.com/owner/repo/actions/runs/12345/job/67890'
    const match = url.match(RUN_ID_REGEX)
    expect(match).not.toBeNull()
    expect(match?.[1]).toBe('12345')
  })

  it('does not match unrelated URLs', () => {
    expect(
      'https://github.com/owner/repo/pull/1'.match(RUN_ID_REGEX)
    ).toBeNull()
    expect('https://example.com'.match(RUN_ID_REGEX)).toBeNull()
  })
})

describe('extractRunId', () => {
  it('returns the numeric run_id', () => {
    expect(extractRunId('https://github.com/o/r/actions/runs/42/job/100')).toBe(
      42
    )
  })

  it('returns null for non-matching URLs', () => {
    expect(extractRunId('https://example.com')).toBeNull()
  })
})

describe('parseCurrentWorkflowPath', () => {
  it('parses GITHUB_WORKFLOW_REF format', () => {
    expect(
      parseCurrentWorkflowPath(
        'owner/repo/.github/workflows/test-self.yml@refs/heads/main'
      )
    ).toBe('.github/workflows/test-self.yml')
  })

  it('handles refs containing extra slashes (e.g. branch with /)', () => {
    expect(
      parseCurrentWorkflowPath(
        'owner/repo/.github/workflows/foo.yml@refs/heads/feat/fork-policy'
      )
    ).toBe('.github/workflows/foo.yml')
  })

  it('returns null for empty / undefined input', () => {
    expect(parseCurrentWorkflowPath(undefined)).toBeNull()
    expect(parseCurrentWorkflowPath('')).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(parseCurrentWorkflowPath('owner/repo')).toBeNull()
  })
})

describe('isFromSameWorkflow', () => {
  it('returns true when app=github-actions and workflow path matches', async () => {
    const lookup = vi.fn().mockResolvedValue('.github/workflows/test-self.yml')
    const run = make(
      'github-actions',
      'https://github.com/o/r/actions/runs/9999/job/1'
    )
    expect(
      await isFromSameWorkflow(run, '.github/workflows/test-self.yml', lookup)
    ).toBe(true)
    expect(lookup).toHaveBeenCalledWith(9999)
  })

  it('returns false for different app slug', async () => {
    const lookup = vi.fn()
    const run = make(
      'cloudflare-pages',
      'https://github.com/o/r/actions/runs/9999/job/1'
    )
    expect(
      await isFromSameWorkflow(run, '.github/workflows/test-self.yml', lookup)
    ).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('returns false when workflow path differs', async () => {
    const lookup = vi.fn().mockResolvedValue('.github/workflows/other.yml')
    const run = make(
      'github-actions',
      'https://github.com/o/r/actions/runs/1/job/1'
    )
    expect(
      await isFromSameWorkflow(run, '.github/workflows/test-self.yml', lookup)
    ).toBe(false)
  })

  it('returns false when current workflow path is null', async () => {
    const lookup = vi.fn()
    const run = make(
      'github-actions',
      'https://github.com/o/r/actions/runs/1/job/1'
    )
    expect(await isFromSameWorkflow(run, null, lookup)).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('returns false when details_url is malformed', async () => {
    const lookup = vi.fn()
    const run = make('github-actions', 'https://example.com')
    expect(
      await isFromSameWorkflow(run, '.github/workflows/test-self.yml', lookup)
    ).toBe(false)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('returns false when lookup returns null (run not found / api error)', async () => {
    const lookup = vi.fn().mockResolvedValue(null)
    const run = make(
      'github-actions',
      'https://github.com/o/r/actions/runs/1/job/1'
    )
    expect(
      await isFromSameWorkflow(run, '.github/workflows/test-self.yml', lookup)
    ).toBe(false)
  })
})

describe('excludeOwnWorkflowRuns', () => {
  it('removes only own-workflow runs and preserves order of others', async () => {
    const lookup = vi.fn(async (runId: number) => {
      if (runId === 1 || runId === 2) return '.github/workflows/test-self.yml'
      return '.github/workflows/other.yml'
    })
    const runs = [
      make('github-actions', 'https://github.com/o/r/actions/runs/1/job/1'),
      make('github-actions', 'https://github.com/o/r/actions/runs/9999/job/1'),
      make(
        'cloudflare-pages',
        'https://github.com/o/r/actions/runs/9999/job/2'
      ),
      make('github-actions', 'https://github.com/o/r/actions/runs/2/job/3')
    ]
    const result = await excludeOwnWorkflowRuns(
      runs,
      '.github/workflows/test-self.yml',
      lookup
    )
    expect(result).toHaveLength(2)
    expect(result[0].details_url).toContain('runs/9999/')
    expect(result[1].details_url).toContain('runs/9999/')
    expect(result[1].app.slug).toBe('cloudflare-pages')
  })

  it('keeps all runs when current workflow path is null', async () => {
    const lookup = vi.fn()
    const runs = [
      make('github-actions', 'https://github.com/o/r/actions/runs/1/job/1'),
      make('github-actions', 'https://github.com/o/r/actions/runs/2/job/1')
    ]
    const result = await excludeOwnWorkflowRuns(runs, null, lookup)
    expect(result).toHaveLength(2)
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('resolveWorkflowPaths', () => {
  it('populates workflow_path for github-actions runs', async () => {
    const lookup = vi.fn(async (runId: number) =>
      runId === 1
        ? '.github/workflows/ci-go.yaml'
        : '.github/workflows/ci-python.yaml'
    )
    const runs = [
      make('github-actions', 'https://github.com/o/r/actions/runs/1/job/1'),
      make('github-actions', 'https://github.com/o/r/actions/runs/2/job/1')
    ]
    const result = await resolveWorkflowPaths(runs, lookup)
    expect(result.map((r) => r.workflow_path)).toEqual([
      '.github/workflows/ci-go.yaml',
      '.github/workflows/ci-python.yaml'
    ])
  })

  it('sets workflow_path to null for non-github-actions apps', async () => {
    const lookup = vi.fn()
    const runs = [
      make('codecov', 'https://github.com/o/r/actions/runs/1/job/1'),
      make('cloudflare-pages', 'https://example.com')
    ]
    const result = await resolveWorkflowPaths(runs, lookup)
    expect(result.map((r) => r.workflow_path)).toEqual([null, null])
    expect(lookup).not.toHaveBeenCalled()
  })

  it('sets workflow_path to null when details_url has no run_id', async () => {
    const lookup = vi.fn()
    const runs = [make('github-actions', 'https://example.com')]
    const result = await resolveWorkflowPaths(runs, lookup)
    expect(result[0].workflow_path).toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('propagates null from the lookup (API error / run not found)', async () => {
    const lookup = vi.fn().mockResolvedValue(null)
    const runs = [
      make('github-actions', 'https://github.com/o/r/actions/runs/1/job/1')
    ]
    const result = await resolveWorkflowPaths(runs, lookup)
    expect(result[0].workflow_path).toBeNull()
  })
})
