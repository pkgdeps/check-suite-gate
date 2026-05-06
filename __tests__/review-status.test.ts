import { describe, it, expect, vi } from 'vitest'
import { hasActiveApproval } from '../src/review-status.js'
import type { OctokitLike, ReviewListItem } from '../src/api.js'

type PermResponse = { permission: string; role_name?: string }

const buildOctokit = (
  reviews: ReviewListItem[],
  permissions: Record<string, PermResponse | { status: number }> = {}
): OctokitLike => {
  const paginate = vi.fn().mockResolvedValue(reviews)
  const listReviews = vi.fn() // unused; paginate stubs the result
  const getCollaboratorPermissionLevel = vi.fn(
    async ({ username }: { username: string }) => {
      const entry = permissions[username]
      if (entry === undefined) {
        // Default: no permission record → treat as 404 (not a collaborator).
        const err = Object.assign(new Error('Not Found'), { status: 404 })
        throw err
      }
      if ('status' in entry) {
        const err = Object.assign(new Error('Error'), { status: entry.status })
        throw err
      }
      return { data: entry }
    }
  )
  return {
    rest: {
      pulls: { listReviews },
      repos: { getCollaboratorPermissionLevel },
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
  author_association: override.author_association ?? 'MEMBER'
})

describe('hasActiveApproval', () => {
  it('returns false when there are no reviews', async () => {
    const octokit = buildOctokit([])
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(false)
  })

  it('returns true when an APPROVED review is from a write-permission user', async () => {
    const octokit = buildOctokit(
      [review({ user: 'alice', state: 'APPROVED' })],
      { alice: { permission: 'write' } }
    )
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(true)
  })

  it('returns true for an admin reviewer', async () => {
    const octokit = buildOctokit(
      [review({ user: 'alice', state: 'APPROVED' })],
      { alice: { permission: 'admin' } }
    )
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(true)
  })

  it("returns true when role_name='maintain' even if permission collapsed to 'write'", async () => {
    const octokit = buildOctokit(
      [review({ user: 'alice', state: 'APPROVED' })],
      { alice: { permission: 'read', role_name: 'maintain' } }
    )
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(true)
  })

  it('returns false when the only approver has read-only permission (read-only COLLABORATOR)', async () => {
    // Reproduces the bot-user case: author_association is COLLABORATOR
    // but actual permission is read. GitHub's own UI says "No applicable
    // reviews submitted by reviewers with write access" in this case.
    const octokit = buildOctokit(
      [
        review({
          user: 'bot-user',
          state: 'APPROVED',
          author_association: 'COLLABORATOR'
        })
      ],
      { 'bot-user': { permission: 'read' } }
    )
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(false)
  })

  it('returns false when the approver is not a collaborator (404)', async () => {
    const octokit = buildOctokit(
      [
        review({
          user: 'eve',
          state: 'APPROVED',
          author_association: 'CONTRIBUTOR'
        })
      ],
      { eve: { status: 404 } }
    )
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(false)
  })

  it('returns false when the only approval was later DISMISSED', async () => {
    const octokit = buildOctokit(
      [
        review({ user: 'alice', state: 'APPROVED' }),
        review({ user: 'alice', state: 'DISMISSED' })
      ],
      { alice: { permission: 'write' } }
    )
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(false)
  })

  it('returns false when CHANGES_REQUESTED supersedes an earlier APPROVED from the same user', async () => {
    const octokit = buildOctokit(
      [
        review({ user: 'alice', state: 'APPROVED' }),
        review({ user: 'alice', state: 'CHANGES_REQUESTED' })
      ],
      { alice: { permission: 'write' } }
    )
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(false)
  })

  it('treats COMMENTED reviews as non-substantive (does not override APPROVED)', async () => {
    const octokit = buildOctokit(
      [
        review({ user: 'alice', state: 'APPROVED' }),
        review({ user: 'alice', state: 'COMMENTED' })
      ],
      { alice: { permission: 'write' } }
    )
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(true)
  })

  it('returns true when an authorized Approve coexists with a drive-by Approve', async () => {
    const octokit = buildOctokit(
      [
        review({ user: 'eve', state: 'APPROVED' }),
        review({ user: 'alice', state: 'APPROVED' })
      ],
      {
        eve: { status: 404 },
        alice: { permission: 'admin' }
      }
    )
    expect(await hasActiveApproval(octokit, 'o', 'r', 1)).toBe(true)
  })
})
