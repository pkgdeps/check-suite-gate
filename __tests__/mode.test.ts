import { describe, it, expect } from 'vitest'
import {
  determineMode,
  isHeadShaAction,
  type DetermineModeInput
} from '../src/mode.js'

const input = (
  override: Partial<DetermineModeInput> = {}
): DetermineModeInput => ({
  eventName: 'pull_request',
  action: 'opened',
  reviewState: null,
  isHeadShaEvent: false,
  isAutoMergeAlreadyEnabled: false,
  isApproved: false,
  ...override
})

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
      const result = determineMode(
        input({ action: 'auto_merge_enabled', isAutoMergeAlreadyEnabled: true })
      )
      expect(result.mode).toBe('polling')
      expect(result.reason).toMatch(/Enable auto-merge/)
    })

    it('synchronize with auto-merge already enabled → polling', () => {
      const result = determineMode(
        input({
          action: 'synchronize',
          isHeadShaEvent: true,
          isAutoMergeAlreadyEnabled: true
        })
      )
      expect(result.mode).toBe('polling')
      expect(result.reason).toMatch(/auto-merge is already enabled/)
    })

    it('synchronize on an already-Approved PR → polling (sticky Approve)', () => {
      const result = determineMode(
        input({
          action: 'synchronize',
          isHeadShaEvent: true,
          isApproved: true
        })
      )
      expect(result.mode).toBe('polling')
      expect(result.reason).toMatch(/active Approve review/)
    })

    it('synchronize without auto-merge or approval → skip', () => {
      const result = determineMode(
        input({ action: 'synchronize', isHeadShaEvent: true })
      )
      expect(result.mode).toBe('skip')
      expect(result.reason).toMatch(/no merge intent/)
    })

    it('opened without auto-merge or approval → skip', () => {
      const result = determineMode(
        input({ action: 'opened', isHeadShaEvent: true })
      )
      expect(result.mode).toBe('skip')
    })

    it('unsupported activity → skip', () => {
      const result = determineMode(input({ action: 'closed' }))
      expect(result.mode).toBe('skip')
      expect(result.reason).toMatch(/unsupported activity/)
    })
  })

  describe('pull_request_review event', () => {
    it('submitted + approved + isApproved=true → polling', () => {
      const result = determineMode(
        input({
          eventName: 'pull_request_review',
          action: 'submitted',
          reviewState: 'approved',
          isApproved: true
        })
      )
      expect(result.mode).toBe('polling')
      expect(result.reason).toMatch(/reviewer Approved with write access/)
    })

    it('submitted + approved + isApproved=false → skip (drive-by Approve)', () => {
      // Anyone can submit an Approve on a public PR; if hasActiveApproval
      // says no write-permission reviewer's Approve is active, treat the
      // event as a drive-by and don't fire polling.
      const result = determineMode(
        input({
          eventName: 'pull_request_review',
          action: 'submitted',
          reviewState: 'approved',
          isApproved: false
        })
      )
      expect(result.mode).toBe('skip')
      expect(result.reason).toMatch(/drive-by review/)
    })

    it('submitted + changes_requested → skip', () => {
      const result = determineMode(
        input({
          eventName: 'pull_request_review',
          action: 'submitted',
          reviewState: 'changes_requested',
          isApproved: false
        })
      )
      expect(result.mode).toBe('skip')
    })

    it('submitted + commented → skip', () => {
      const result = determineMode(
        input({
          eventName: 'pull_request_review',
          action: 'submitted',
          reviewState: 'commented',
          isApproved: false
        })
      )
      expect(result.mode).toBe('skip')
    })

    it('non-submitted action (e.g. dismissed) → skip', () => {
      const result = determineMode(
        input({
          eventName: 'pull_request_review',
          action: 'dismissed',
          reviewState: 'approved',
          isApproved: true
        })
      )
      expect(result.mode).toBe('skip')
    })
  })

  it('unsupported eventName → skip', () => {
    const result = determineMode(
      input({ eventName: 'issue_comment', action: 'created' })
    )
    expect(result.mode).toBe('skip')
  })
})
