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

export type DetermineModeInput = {
  eventName: string
  action: string
  reviewState: string | null
  isHeadShaEvent: boolean
  isAutoMergeAlreadyEnabled: boolean
}

export type DetermineModeResult = {
  mode: ActionMode
  // Human-readable explanation of why this mode was picked. Logged at
  // INFO so the workflow run page makes the decision auditable without
  // having to re-derive it from the trigger payload.
  reason: string
}

// Polling fires whenever the maintainer signals merge intent. There are
// three signals today:
//
//   1. `pull_request.auto_merge_enabled` — explicit "merge when ready".
//   2. A new HEAD landed (opened / synchronize / reopened) on a PR that
//      already has Auto Merge enabled — i.e., merge intent was signalled
//      earlier and is still standing.
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
    isAutoMergeAlreadyEnabled
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
