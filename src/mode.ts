// pull_request activity types that may bring a new HEAD SHA to the PR.
// The gate re-evaluates the SHA on these. Triggers pending mode by default,
// or polling mode when Auto Merge is already enabled.
const HEAD_SHA_ACTIONS = ['opened', 'synchronize', 'reopened'] as const
type HeadShaAction = (typeof HEAD_SHA_ACTIONS)[number]
export const isHeadShaAction = (a: string): a is HeadShaAction =>
  (HEAD_SHA_ACTIONS as readonly string[]).includes(a)

// Mutually exclusive modes the action can run in for a given event.
//   polling — poll the Checks API and write the aggregated verdict.
//   pending — write a queued check_run and exit, waiting for merge intent.
//   skip    — do nothing for unsupported activity types.
export type ActionMode = 'polling' | 'pending' | 'skip'

/**
 * Lowercase values GitHub uses for `pull_request_review.review.state`
 * in webhook payloads. Source:
 * https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review
 *
 * `approved` is the only one this action treats as merge intent; the
 * rest fall through to skip. The union is closed against the documented
 * states; callers must coerce unknown strings to `null` (we don't
 * extend it with `string` because that defeats the type-narrowing
 * benefit of literal comparison).
 */
export type ReviewState =
  | 'approved'
  | 'changes_requested'
  | 'commented'
  | 'dismissed'
  | 'pending'

const KNOWN_REVIEW_STATES = [
  'approved',
  'changes_requested',
  'commented',
  'dismissed',
  'pending'
] as const

/**
 * Coerces a raw `payload.review.state` (typed as `string | undefined`
 * by the webhook payload type) to a `ReviewState | null`. Unknown
 * values fall back to `null` — they are treated as "no signal", same
 * as if no review was attached.
 */
export const parseReviewState = (
  raw: string | undefined | null
): ReviewState | null => {
  if (raw === undefined || raw === null) return null
  return (KNOWN_REVIEW_STATES as readonly string[]).includes(raw)
    ? (raw as ReviewState)
    : null
}

export type DetermineModeInput = {
  /**
   * GitHub Actions `eventName` (e.g. `pull_request`,
   * `pull_request_review`). Determines which trigger family the action
   * was invoked from; review-only logic only fires when this is
   * `pull_request_review`.
   */
  eventName: string
  /**
   * Activity type within the event (e.g. `opened`, `synchronize`,
   * `auto_merge_enabled`, `submitted`). Comes from `payload.action`.
   */
  action: string
  /**
   * Review state when `eventName === 'pull_request_review'`,
   * otherwise `null`. Sourced from `payload.review.state` after
   * coercing through `parseReviewState`.
   */
  reviewState: ReviewState | null
  /**
   * `true` when `action` is one of the activity types that brings a
   * new HEAD SHA (`opened` / `synchronize` / `reopened`). Use
   * `isHeadShaAction` to compute it from the action string.
   */
  isHeadShaEvent: boolean
  /**
   * `true` when the PR's `auto_merge` field is non-null at the time
   * of the event (i.e. a maintainer has already pressed "Enable auto-
   * merge"). Used as a sticky merge-intent signal across pushes.
   */
  isAutoMergeAlreadyEnabled: boolean
  /**
   * `true` when the PR currently has at least one active Approve
   * review, determined by re-querying the PR's reviews on each HEAD
   * SHA event. Makes Approve a sticky merge-intent flag (the gate
   * stays polling on subsequent pushes), instead of only firing once
   * on the single `pull_request_review.submitted` event.
   */
  isApproved: boolean
}

export type DetermineModeResult = {
  mode: ActionMode
  /**
   * Human-readable explanation of why this mode was picked. Logged at
   * INFO so the workflow run page makes the decision auditable without
   * having to re-derive it from the trigger payload.
   */
  reason: string
}

// Polling fires whenever the maintainer signals merge intent. There are
// three signals today:
//
//   1. `pull_request.auto_merge_enabled` — explicit "merge when ready".
//   2. A new HEAD landed (opened / synchronize / reopened) on a PR
//      whose merge intent is still standing — i.e., Auto Merge is
//      enabled, OR the PR already has an active Approve review. The
//      Approve case is what makes the gate stay green across pushes
//      instead of dropping back to pending after each commit.
//   3. `pull_request_review` with `state: approved` — a reviewer
//      Approved, which the action interprets as merge intent. (Teams
//      whose Approve culture is "LGTM, but not necessarily merge now"
//      can drop `pull_request_review` from the workflow's `on:` to
//      opt out — the action input list intentionally has no toggle for
//      this; the workflow YAML is the toggle.)
//
// All three lead to the same `polling` mode; the trigger differs but
// the work is identical.
export const determineMode = (
  input: DetermineModeInput
): DetermineModeResult => {
  const {
    eventName,
    action,
    reviewState,
    isHeadShaEvent,
    isAutoMergeAlreadyEnabled,
    isApproved
  } = input
  if (eventName === 'pull_request_review') {
    if (action === 'submitted' && reviewState === 'approved') {
      return {
        mode: 'polling',
        reason:
          'reviewer Approved (interpreted as merge intent — pull_request_review.submitted with state=approved)'
      }
    }
    return {
      mode: 'skip',
      reason: `pull_request_review ignored (action=${action}, state=${reviewState ?? 'null'})`
    }
  }
  if (action === 'auto_merge_enabled') {
    return {
      mode: 'polling',
      reason: 'Enable auto-merge clicked (pull_request.auto_merge_enabled)'
    }
  }
  if (isHeadShaEvent) {
    if (isAutoMergeAlreadyEnabled) {
      return {
        mode: 'polling',
        reason: `new HEAD landed (action=${action}) while auto-merge is already enabled — re-evaluating`
      }
    }
    if (isApproved) {
      return {
        mode: 'polling',
        reason: `new HEAD landed (action=${action}) on a PR that already has an active Approve review — re-evaluating`
      }
    }
    return {
      mode: 'pending',
      reason: `new HEAD landed (action=${action}); waiting for merge intent (Enable auto-merge or an Approve review)`
    }
  }
  return {
    mode: 'skip',
    reason: `unsupported activity (eventName=${eventName}, action=${action})`
  }
}
