import { withRetry, type OctokitLike, type ReviewListItem } from './api.js'

// Decides whether the PR currently has at least one active Approve
// review. "Active" means the reviewer's latest non-COMMENTED review is
// `APPROVED` — COMMENTED reviews are skipped because GitHub treats them
// as non-substantive (they don't override an earlier approval). DISMISSED
// reviews count as superseding (so an approval that was later dismissed
// no longer counts).
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
    const login = r.user?.login ?? '<unknown>'
    latestPerUser.set(login, r)
  }
  for (const r of latestPerUser.values()) {
    if (r.state === 'APPROVED') return true
  }
  return false
}
