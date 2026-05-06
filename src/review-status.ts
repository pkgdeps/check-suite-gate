import { withRetry, type OctokitLike, type ReviewListItem } from './api.js'

// `author_association` values that indicate the reviewer has, or had
// at the time of review, write access to the repository — i.e. they
// are someone whose Approve carries merge weight. Drive-by reviews
// from CONTRIBUTOR / NONE / FIRST_TIME_CONTRIBUTOR / MANNEQUIN do not
// count as merge intent: anyone can submit an Approve on a public PR,
// but only authorized reviewers should be able to satisfy the gate.
//
// See https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request
const AUTHORIZED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR'])

// Decides whether the PR currently has at least one active Approve
// review from an authorized reviewer. "Active" means the reviewer's
// latest non-COMMENTED review is `APPROVED` — COMMENTED reviews are
// skipped because GitHub treats them as non-substantive (they don't
// override an earlier approval). DISMISSED reviews count as superseding
// (so an approval that was later dismissed no longer counts).
// "Authorized" means `author_association` is OWNER / MEMBER /
// COLLABORATOR; other associations are treated as drive-by and
// ignored.
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
    if (!AUTHORIZED_ASSOCIATIONS.has(r.author_association)) continue
    const login = r.user?.login ?? '<unknown>'
    latestPerUser.set(login, r)
  }
  for (const r of latestPerUser.values()) {
    if (r.state === 'APPROVED') return true
  }
  return false
}
