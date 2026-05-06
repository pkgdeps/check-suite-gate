import { describe, it, expect, vi } from 'vitest'
import { hasActiveApproval } from '../src/review-status.js'
import type { OctokitLike, ReviewListItem } from '../src/api.js'

const buildOctokit = (reviews: ReviewListItem[]): OctokitLike => {
  const paginate = vi.fn().mockResolvedValue(reviews)
  const listReviews = vi.fn() // unused in tests; paginate stubs the result
  return {
    rest: {
      pulls: { listReviews },
      checks: {} as never
    },
    paginate
  } as unknown as OctokitLike
}

const review = (override: {
  user?: string
  state?: string
  submitted_at?: string
}): ReviewListItem => ({
  state: override.state ?? 'COMMENTED',
  submitted_at: override.submitted_at ?? '2026-01-01T00:00:00Z',
  user: override.user !== undefined ? { login: override.user } : null
})

describe('hasActiveApproval', () => {
  it('returns false when there are no reviews', async () => {
    const octokit = buildOctokit([])
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(false)
  })

  it('returns true when at least one user has an APPROVED review', async () => {
    const octokit = buildOctokit([review({ user: 'alice', state: 'APPROVED' })])
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(true)
  })

  it('returns false when the only approval was later DISMISSED', async () => {
    const octokit = buildOctokit([
      review({ user: 'alice', state: 'APPROVED' }),
      review({ user: 'alice', state: 'DISMISSED' })
    ])
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(false)
  })

  it('returns false when CHANGES_REQUESTED supersedes an earlier APPROVED from the same user', async () => {
    const octokit = buildOctokit([
      review({ user: 'alice', state: 'APPROVED' }),
      review({ user: 'alice', state: 'CHANGES_REQUESTED' })
    ])
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(false)
  })

  it('treats COMMENTED reviews as non-substantive (does not override APPROVED)', async () => {
    const octokit = buildOctokit([
      review({ user: 'alice', state: 'APPROVED' }),
      review({ user: 'alice', state: 'COMMENTED' })
    ])
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(true)
  })

  it('returns true when one user APPROVED even if another has CHANGES_REQUESTED', async () => {
    const octokit = buildOctokit([
      review({ user: 'alice', state: 'APPROVED' }),
      review({ user: 'bob', state: 'CHANGES_REQUESTED' })
    ])
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(true)
  })
})
