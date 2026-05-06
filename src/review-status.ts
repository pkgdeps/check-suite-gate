import { withRetry, type OctokitLike, type ReviewListItem } from './api.js'

// Permission levels that imply write access — admin / maintain / write.
// `permission` from getCollaboratorPermissionLevel is documented as
// 'admin' | 'write' | 'read' | 'none'; `role_name` is the more granular
// label and can be 'maintain' / 'triage' even when permission collapses
// to 'write' / 'read'. We accept either path so a Maintain role isn't
// silently treated as read-only.
const WRITE_PERMISSIONS = new Set(['admin', 'write'])
const WRITE_ROLE_NAMES = new Set(['admin', 'maintain', 'write'])

// `author_association` is NOT a substitute for actual write permission:
// a read-only COLLABORATOR still has `author_association: COLLABORATOR`,
// which is why GitHub's own UI says "No applicable reviews submitted by
// reviewers with write access" in that case. We re-check each approver's
// permission via the API before treating their Approve as merge intent.
const hasWritePermission = async (
  octokit: OctokitLike,
  owner: string,
  repo: string,
  username: string,
  cache: Map<string, boolean>,
  retryOptions: { retries: number; baseDelayMs: number }
): Promise<boolean> => {
  const cached = cache.get(username)
  if (cached !== undefined) return cached
  try {
    const result = await withRetry(
      () =>
        octokit.rest.repos.getCollaboratorPermissionLevel({
          owner,
          repo,
          username
        }),
      retryOptions
    )
    const ok =
      WRITE_PERMISSIONS.has(result.data.permission) ||
      (result.data.role_name !== undefined &&
        WRITE_ROLE_NAMES.has(result.data.role_name))
    cache.set(username, ok)
    return ok
  } catch (err) {
    // 404 = not a collaborator on this repo = no write access. Cache
    // the negative result so a noisy review listing doesn't burn quota
    // re-asking about the same user.
    if ((err as { status?: number }).status === 404) {
      cache.set(username, false)
      return false
    }
    throw err
  }
}

// Decides whether the PR currently has at least one active Approve
// review from a reviewer with actual write access. "Active" means the
// reviewer's latest non-COMMENTED review is `APPROVED` — COMMENTED
// reviews are skipped because GitHub treats them as non-substantive
// (they don't override an earlier approval). DISMISSED reviews count
// as superseding (so an approval that was later dismissed no longer
// counts).
//
// Used to keep the gate green across new pushes after Approve: without
// this, polling fires once on `pull_request_review.submitted` but the
// next `synchronize` event sees no live signal and would drop back to
// pending. Querying review state on each HEAD SHA event makes Approve
// behave like a sticky merge-intent flag, mirroring how auto-merge
// behaves.
export const hasActiveApproval = async (
  octokit: OctokitLike,
  owner: string,
  repo: string,
  pullNumber: number,
  retryOptions: { retries: number; baseDelayMs: number } = {
    retries: 3,
    baseDelayMs: 500
  }
): Promise<boolean> => {
  const reviews = await withRetry(
    () =>
      octokit.paginate<ReviewListItem>(
        octokit.rest.pulls.listReviews as never,
        { owner, repo, pull_number: pullNumber, per_page: 100 }
      ),
    retryOptions
  )

  const latestPerUser = new Map<string, ReviewListItem>()
  for (const r of reviews) {
    if (r.state === 'COMMENTED') continue
    const login = r.user?.login
    if (login === undefined || login === null) continue
    latestPerUser.set(login, r)
  }

  const permCache = new Map<string, boolean>()
  for (const [login, r] of latestPerUser) {
    if (r.state !== 'APPROVED') continue
    if (
      await hasWritePermission(
        octokit,
        owner,
        repo,
        login,
        permCache,
        retryOptions
      )
    ) {
      return true
    }
  }
  return false
}
