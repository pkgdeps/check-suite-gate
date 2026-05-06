import { describe, it, expect } from 'vitest'
import { parseInputs, type RawInputs } from '../src/inputs.js'

const raw = (override: Partial<RawInputs> = {}): RawInputs => ({
  context: 'automerge-gate/all-passed',
  ignoreApps: '',
  ignoreChecks: '',
  gateMode: 'private',
  token: 'tok',
  pollIntervalSeconds: '30',
  ...override
})

describe('parseInputs', () => {
  it('parses comma lists and trims values', () => {
    const result = parseInputs(
      raw({ ignoreApps: 'a, b ,c', ignoreChecks: '*foo, bar-* ' })
    )
    expect(result.ignoreApps).toEqual(['a', 'b', 'c'])
    expect(result.ignoreChecks).toEqual(['*foo', 'bar-*'])
  })

  it('parses newline-separated ignore lists', () => {
    const result = parseInputs(
      raw({ ignoreApps: 'a\nb\nc', ignoreChecks: '*foo\n bar-* ' })
    )
    expect(result.ignoreApps).toEqual(['a', 'b', 'c'])
    expect(result.ignoreChecks).toEqual(['*foo', 'bar-*'])
  })

  it('throws when token is empty or whitespace', () => {
    expect(() => parseInputs(raw({ token: '' }))).toThrow(/token/)
    expect(() => parseInputs(raw({ token: '   ' }))).toThrow(/token/)
  })

  it('parses positive integer poll-interval-seconds', () => {
    const result = parseInputs(raw({ pollIntervalSeconds: '15' }))
    expect(result.pollIntervalSeconds).toBe(15)
  })

  it('throws on non-numeric or non-positive interval', () => {
    expect(() => parseInputs(raw({ pollIntervalSeconds: 'abc' }))).toThrow(
      /poll-interval-seconds/
    )
    expect(() => parseInputs(raw({ pollIntervalSeconds: '0' }))).toThrow(
      /poll-interval-seconds/
    )
    expect(() => parseInputs(raw({ pollIntervalSeconds: '-5' }))).toThrow(
      /poll-interval-seconds/
    )
  })

  it("accepts gateMode = 'private' or 'public'", () => {
    expect(parseInputs(raw({ gateMode: 'private' })).gateMode).toBe('private')
    expect(parseInputs(raw({ gateMode: 'public' })).gateMode).toBe('public')
  })

  it('throws on invalid gateMode (legacy v2 values rejected with migration hint)', () => {
    expect(() => parseInputs(raw({ gateMode: 'main' }))).toThrow(
      /gate: main → gate-mode: private/
    )
    expect(() => parseInputs(raw({ gateMode: 'fork' }))).toThrow(
      /gate: fork → gate-mode: public/
    )
    expect(() => parseInputs(raw({ gateMode: 'maybe' }))).toThrow(/gate-mode/)
    expect(() => parseInputs(raw({ gateMode: '' }))).toThrow(/gate-mode/)
  })
})
