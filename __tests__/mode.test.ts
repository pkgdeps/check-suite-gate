import { describe, it, expect } from 'vitest'
import { determineMode, isHeadShaAction } from '../src/mode.js'

describe('isHeadShaAction', () => {
  it.each(['opened', 'synchronize', 'reopened'])(
    'recognises "%s" as a HEAD-SHA-changing action',
    (action) => {
      expect(isHeadShaAction(action)).toBe(true)
    }
  )

  it.each(['closed', 'auto_merge_enabled', 'submitted', ''])(
    'rejects "%s"',
    (action) => {
      expect(isHeadShaAction(action)).toBe(false)
    }
  )
})

describe('determineMode', () => {
  describe('pull_request event', () => {
    it('auto_merge_enabled → polling with the right reason', () => {
      const result = determineMode({
        eventName: 'pull_request',
        action: 'auto_merge_enabled',
        reviewState: null,
        isHeadShaEvent: false,
        isAutoMergeAlreadyEnabled: true
      })
      expect(result.mode).toBe('polling')
      expect(result.reason).toMatch(/Enable auto-merge/)
    })

    it('synchronize with auto-merge already enabled → polling', () => {
      const result = determineMode({
        eventName: 'pull_request',
        action: 'synchronize',
        reviewState: null,
        isHeadShaEvent: true,
        isAutoMergeAlreadyEnabled: true
      })
      expect(result.mode).toBe('polling')
      expect(result.reason).toMatch(/auto-merge is already enabled/)
    })

    it('synchronize without auto-merge → pending', () => {
      const result = determineMode({
        eventName: 'pull_request',
        action: 'synchronize',
        reviewState: null,
        isHeadShaEvent: true,
        isAutoMergeAlreadyEnabled: false
      })
      expect(result.mode).toBe('pending')
      expect(result.reason).toMatch(/waiting for merge intent/)
    })

    it('opened without auto-merge → pending', () => {
      const result = determineMode({
        eventName: 'pull_request',
        action: 'opened',
        reviewState: null,
        isHeadShaEvent: true,
        isAutoMergeAlreadyEnabled: false
      })
      expect(result.mode).toBe('pending')
    })

    it('unsupported activity → skip', () => {
      const result = determineMode({
        eventName: 'pull_request',
        action: 'closed',
        reviewState: null,
        isHeadShaEvent: false,
        isAutoMergeAlreadyEnabled: false
      })
      expect(result.mode).toBe('skip')
      expect(result.reason).toMatch(/unsupported activity/)
    })
  })

  describe('pull_request_review event', () => {
    it('submitted + approved → polling (Approve = merge intent)', () => {
      const result = determineMode({
        eventName: 'pull_request_review',
        action: 'submitted',
        reviewState: 'approved',
        isHeadShaEvent: false,
        isAutoMergeAlreadyEnabled: false
      })
      expect(result.mode).toBe('polling')
      expect(result.reason).toMatch(/reviewer Approved/)
    })

    it('submitted + changes_requested → skip', () => {
      const result = determineMode({
        eventName: 'pull_request_review',
        action: 'submitted',
        reviewState: 'changes_requested',
        isHeadShaEvent: false,
        isAutoMergeAlreadyEnabled: false
      })
      expect(result.mode).toBe('skip')
    })

    it('submitted + commented → skip (a comment-only review is not merge intent)', () => {
      const result = determineMode({
        eventName: 'pull_request_review',
        action: 'submitted',
        reviewState: 'commented',
        isHeadShaEvent: false,
        isAutoMergeAlreadyEnabled: false
      })
      expect(result.mode).toBe('skip')
    })

    it('non-submitted action (e.g. dismissed) → skip', () => {
      const result = determineMode({
        eventName: 'pull_request_review',
        action: 'dismissed',
        reviewState: 'approved',
        isHeadShaEvent: false,
        isAutoMergeAlreadyEnabled: false
      })
      expect(result.mode).toBe('skip')
    })
  })

  it('unsupported eventName falls through to the pull_request rules', () => {
    // Defensive: if a future caller forwards a different eventName, the
    // pull_request_review branch must not swallow it. The function
    // should drop to the pull_request rules and skip if nothing matches.
    const result = determineMode({
      eventName: 'issue_comment',
      action: 'created',
      reviewState: null,
      isHeadShaEvent: false,
      isAutoMergeAlreadyEnabled: false
    })
    expect(result.mode).toBe('skip')
  })
})
