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
  author_association?: string
}): ReviewListItem => ({
  state: override.state ?? 'COMMENTED',
  submitted_at: override.submitted_at ?? '2026-01-01T00:00:00Z',
  user: override.user !== undefined ? { login: override.user } : null,
  // Default to MEMBER so most tests don't need to specify it; specific
  // tests below override with CONTRIBUTOR/NONE to cover the auth path.
  author_association: override.author_association ?? 'MEMBER'
})

describe('hasActiveApproval', () => {
  it('returns false when there are no reviews', async () => {
    const octokit = buildOctokit([])
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(false)
  })

  it('returns true when at least one MEMBER has an APPROVED review', async () => {
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

  it('ignores Approves from drive-by reviewers (CONTRIBUTOR / NONE)', async () => {
    // Anyone can submit a review on a public PR. Only OWNER / MEMBER /
    // COLLABORATOR have merge weight; treat the rest as no-signal so a
    // random user's "Approve" can't satisfy the gate.
    const octokit = buildOctokit([
      review({
        user: 'eve',
        state: 'APPROVED',
        author_association: 'CONTRIBUTOR'
      }),
      review({
        user: 'mallory',
        state: 'APPROVED',
        author_association: 'NONE'
      })
    ])
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(false)
  })

  it('counts OWNER / COLLABORATOR / MEMBER approvals', async () => {
    for (const association of ['OWNER', 'COLLABORATOR', 'MEMBER']) {
      const octokit = buildOctokit([
        review({
          user: 'alice',
          state: 'APPROVED',
          author_association: association
        })
      ])
      expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(true)
    }
  })

  it('returns true when an authorized Approve coexists with a drive-by Approve', async () => {
    const octokit = buildOctokit([
      review({
        user: 'eve',
        state: 'APPROVED',
        author_association: 'NONE'
      }),
      review({
        user: 'alice',
        state: 'APPROVED',
        author_association: 'MEMBER'
      })
    ])
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(true)
  })
})
