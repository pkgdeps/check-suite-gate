import { describe, it, expect } from 'vitest'
import { classify, type CheckRunLike } from '../src/conclusion.js'

const make = (status: string, conclusion: string | null): CheckRunLike =>
  ({ status, conclusion }) as CheckRunLike

describe('classify', () => {
  it('treats success / skipped / neutral as green', () => {
    expect(classify(make('completed', 'success'))).toBe('green')
    expect(classify(make('completed', 'skipped'))).toBe('green')
    expect(classify(make('completed', 'neutral'))).toBe('green')
  })

  it('treats failure / cancelled / timed_out / action_required as red', () => {
    expect(classify(make('completed', 'failure'))).toBe('red')
    expect(classify(make('completed', 'cancelled'))).toBe('red')
    expect(classify(make('completed', 'timed_out'))).toBe('red')
    expect(classify(make('completed', 'action_required'))).toBe('red')
  })

  it('treats null conclusion as pending', () => {
    expect(classify(make('completed', null))).toBe('pending')
  })

  it('treats non-completed status as pending', () => {
    expect(classify(make('queued', null))).toBe('pending')
    expect(classify(make('in_progress', null))).toBe('pending')
  })

  it('treats unknown conclusion as red (safe default)', () => {
    expect(classify(make('completed', 'stale' as never))).toBe('red')
  })
})
