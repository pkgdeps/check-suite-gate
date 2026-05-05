import { describe, it, expect } from 'vitest'
import { parseInputs, type RawInputs } from '../src/inputs.js'

const raw = (override: Partial<RawInputs> = {}): RawInputs => ({
  context: 'check-suite-gate/all-passed',
  ignoreApps: '',
  ignoreChecks: '',
  token: 'tok',
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

  it('uses provided context name', () => {
    expect(parseInputs(raw({ context: 'custom/ctx' })).context).toBe(
      'custom/ctx'
    )
  })

  it('passes token through', () => {
    expect(parseInputs(raw({ token: 'ghs_xyz' })).token).toBe('ghs_xyz')
  })

  it('throws when token is empty or whitespace', () => {
    expect(() => parseInputs(raw({ token: '' }))).toThrow(/token/)
    expect(() => parseInputs(raw({ token: '   ' }))).toThrow(/token/)
  })

  it('returns empty arrays for empty ignore inputs', () => {
    const result = parseInputs(raw())
    expect(result.ignoreApps).toEqual([])
    expect(result.ignoreChecks).toEqual([])
  })
})
