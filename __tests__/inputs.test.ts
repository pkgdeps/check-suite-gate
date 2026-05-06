import { describe, it, expect } from 'vitest'
import { parseInputs, type RawInputs } from '../src/inputs.js'

const raw = (override: Partial<RawInputs> = {}): RawInputs => ({
  context: 'automerge-gate/all-passed',
  ignoreApps: '',
  ignoreChecks: '',
  gate: 'main',
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

  it("accepts gate = 'main' or 'fork'", () => {
    expect(parseInputs(raw({ gate: 'main' })).gate).toBe('main')
    expect(parseInputs(raw({ gate: 'fork' })).gate).toBe('fork')
  })

  it('throws on invalid gate', () => {
    expect(() => parseInputs(raw({ gate: 'main-gate' }))).toThrow(/gate/)
    expect(() => parseInputs(raw({ gate: 'maybe' }))).toThrow(/gate/)
    expect(() => parseInputs(raw({ gate: '' }))).toThrow(/gate/)
  })
})
