import { describe, it, expect } from 'vitest'
import {
  parseInputs,
  parseIgnoreChecks,
  type RawInputs
} from '../src/inputs.js'

const raw = (override: Partial<RawInputs> = {}): RawInputs => ({
  context: 'automerge-gate/all-passed',
  ignoreChecks: '[]',
  gateMode: 'private',
  token: 'tok',
  pollIntervalSeconds: '30',
  ...override
})

describe('parseInputs', () => {
  it('parses an empty ignore-checks array', () => {
    const result = parseInputs(raw({ ignoreChecks: '[]' }))
    expect(result.ignoreChecks).toEqual([])
  })

  it('treats whitespace-only ignore-checks as an empty list', () => {
    const result = parseInputs(raw({ ignoreChecks: '   \n  ' }))
    expect(result.ignoreChecks).toEqual([])
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

describe('parseIgnoreChecks', () => {
  it('parses a strict JSON array of rules', () => {
    expect(
      parseIgnoreChecks(
        '[{"app":"dependabot"},{"workflow":"ci.yaml","name":"lint"}]'
      )
    ).toEqual([{ app: 'dependabot' }, { workflow: 'ci.yaml', name: 'lint' }])
  })

  it('accepts trailing commas (JSONC)', () => {
    expect(
      parseIgnoreChecks(`[
        { "app": "dependabot" },
        { "name": "optional-*" },
      ]`)
    ).toEqual([{ app: 'dependabot' }, { name: 'optional-*' }])
  })

  it('accepts line and block comments (JSONC)', () => {
    expect(
      parseIgnoreChecks(`[
        // ignore all dependabot checks
        { "app": "dependabot" },
        /* flaky job, revisit before v6 */
        { "name": "flaky-test" }
      ]`)
    ).toEqual([{ app: 'dependabot' }, { name: 'flaky-test' }])
  })

  it('treats empty string as an empty array', () => {
    expect(parseIgnoreChecks('')).toEqual([])
    expect(parseIgnoreChecks('   ')).toEqual([])
  })

  it('rejects a non-array top-level value', () => {
    expect(() => parseIgnoreChecks('{"app":"dependabot"}')).toThrow(
      /must be an array/
    )
    expect(() => parseIgnoreChecks('"dependabot"')).toThrow(/must be an array/)
    expect(() => parseIgnoreChecks('null')).toThrow(/must be an array/)
  })

  it('rejects an entry that is not an object', () => {
    expect(() => parseIgnoreChecks('["dependabot"]')).toThrow(
      /entry \[0\] must be an object/
    )
    expect(() => parseIgnoreChecks('[[]]')).toThrow(/must be an object/)
  })

  it('rejects an entry with an unknown field', () => {
    expect(() => parseIgnoreChecks('[{"conclusion":"failure"}]')).toThrow(
      /unknown field "conclusion"/
    )
  })

  it('rejects an entry whose field value is not a non-empty string', () => {
    expect(() => parseIgnoreChecks('[{"app":123}]')).toThrow(
      /\.app must be a non-empty string/
    )
    expect(() => parseIgnoreChecks('[{"app":""}]')).toThrow(
      /\.app must be a non-empty string/
    )
  })

  it('rejects an entry with no fields set', () => {
    expect(() => parseIgnoreChecks('[{}]')).toThrow(/empty object/)
  })

  it('rejects unparseable JSONC', () => {
    expect(() => parseIgnoreChecks('not json')).toThrow(/JSONC parse failed/)
    expect(() => parseIgnoreChecks('[{"app":')).toThrow(/JSONC parse failed/)
  })

  it('error messages name the JSONC fault and quote the offending fragment', () => {
    // jsonc-parser exposes numeric error codes (e.g. 4 = "ValueExpected").
    // The error surfaced to the user must name the fault and include the
    // bad fragment, not just expose the raw code number.
    expect(() => parseIgnoreChecks('[{"app":}]')).toThrow(/ValueExpected/)
    expect(() => parseIgnoreChecks('[{"app":}]')).toThrow(/at offset \d+/)
    expect(() => parseIgnoreChecks('[{"app":}]')).not.toThrow(/error=\d+/)
  })
})
