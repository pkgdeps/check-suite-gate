import { describe, it, expect } from 'vitest'
import { parseInputs, parseRuleList, type RawInputs } from '../src/inputs.js'

const raw = (override: Partial<RawInputs> = {}): RawInputs => ({
  context: 'automerge-gate/all-passed',
  ignoreChecks: '[]',
  dedupChecks: '[]',
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

  it('parses dedup-checks with the same rule schema as ignore-checks', () => {
    const result = parseInputs(
      raw({
        dedupChecks:
          '[{"workflow":"ci.yaml"},{"app":"xcode-cloud","name":"Build *"}]'
      })
    )
    expect(result.dedupChecks).toEqual([
      { workflow: 'ci.yaml' },
      { app: 'xcode-cloud', name: 'Build *' }
    ])
  })

  it('treats empty and whitespace-only dedup-checks as an empty list', () => {
    expect(parseInputs(raw({ dedupChecks: '' })).dedupChecks).toEqual([])
    expect(parseInputs(raw({ dedupChecks: '  \n ' })).dedupChecks).toEqual([])
  })

  it('rejects a dedup-checks rule with neither workflow nor app', () => {
    // Stricter than ignore-checks: a dedup rule names whose runs it may
    // drop, and `name` alone does not.
    expect(() =>
      parseInputs(raw({ dedupChecks: '[{"name":"build"}]' }))
    ).toThrow(/entry \[0\] must set `workflow` or `app`/)
    expect(() =>
      parseInputs(
        raw({ dedupChecks: '[{"workflow":"ci.yaml"},{"name":"build-*"}]' })
      )
    ).toThrow(/entry \[1\] must set `workflow` or `app`/)
    // ignore-checks keeps accepting name-only rules.
    expect(
      parseInputs(raw({ ignoreChecks: '[{"name":"build"}]' })).ignoreChecks
    ).toEqual([{ name: 'build' }])
  })

  it('accepts workflow-only, app-only, and scoped-plus-name dedup rules', () => {
    const result = parseInputs(
      raw({
        dedupChecks:
          '[{"workflow":"ci.yaml"},{"app":"github-actions"},{"workflow":"ci.yaml","name":"build"}]'
      })
    )
    expect(result.dedupChecks).toHaveLength(3)
  })

  it('attributes dedup-checks validation errors to the dedup-checks input', () => {
    expect(() => parseInputs(raw({ dedupChecks: '[{}]' }))).toThrow(
      /input `dedup-checks`/
    )
    expect(() => parseInputs(raw({ dedupChecks: '{"name":"build"}' }))).toThrow(
      /input `dedup-checks`/
    )
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

describe('parseRuleList', () => {
  const parse = (input: string): ReturnType<typeof parseRuleList> =>
    parseRuleList(input, 'ignore-checks')

  it('parses a strict JSON array of rules', () => {
    expect(
      parse('[{"app":"dependabot"},{"workflow":"ci.yaml","name":"lint"}]')
    ).toEqual([{ app: 'dependabot' }, { workflow: 'ci.yaml', name: 'lint' }])
  })

  it('accepts trailing commas (JSONC)', () => {
    expect(
      parse(`[
        { "app": "dependabot" },
        { "name": "optional-*" },
      ]`)
    ).toEqual([{ app: 'dependabot' }, { name: 'optional-*' }])
  })

  it('accepts line and block comments (JSONC)', () => {
    expect(
      parse(`[
        // ignore all dependabot checks
        { "app": "dependabot" },
        /* flaky job, revisit before v6 */
        { "name": "flaky-test" }
      ]`)
    ).toEqual([{ app: 'dependabot' }, { name: 'flaky-test' }])
  })

  it('treats empty string as an empty array', () => {
    expect(parse('')).toEqual([])
    expect(parse('   ')).toEqual([])
  })

  it('rejects a non-array top-level value', () => {
    expect(() => parse('{"app":"dependabot"}')).toThrow(/must be an array/)
    expect(() => parse('"dependabot"')).toThrow(/must be an array/)
    expect(() => parse('null')).toThrow(/must be an array/)
  })

  it('rejects an entry that is not an object', () => {
    expect(() => parse('["dependabot"]')).toThrow(
      /entry \[0\] must be an object/
    )
    expect(() => parse('[[]]')).toThrow(/must be an object/)
  })

  it('rejects an entry with an unknown field', () => {
    expect(() => parse('[{"conclusion":"failure"}]')).toThrow(
      /unknown field "conclusion"/
    )
  })

  it('rejects an entry whose field value is not a non-empty string', () => {
    expect(() => parse('[{"app":123}]')).toThrow(
      /\.app must be a non-empty string/
    )
    expect(() => parse('[{"app":""}]')).toThrow(
      /\.app must be a non-empty string/
    )
  })

  it('rejects an entry with no fields set', () => {
    expect(() => parse('[{}]')).toThrow(/empty object/)
  })

  it('rejects unparseable JSONC', () => {
    expect(() => parse('not json')).toThrow(/JSONC parse failed/)
    expect(() => parse('[{"app":')).toThrow(/JSONC parse failed/)
  })

  it('error messages name the JSONC fault and quote the offending fragment', () => {
    // jsonc-parser exposes numeric error codes (e.g. 4 = "ValueExpected").
    // The error surfaced to the user must name the fault and include the
    // bad fragment, not just expose the raw code number.
    expect(() => parse('[{"app":}]')).toThrow(/ValueExpected/)
    expect(() => parse('[{"app":}]')).toThrow(/at offset \d+/)
    expect(() => parse('[{"app":}]')).not.toThrow(/error=\d+/)
  })

  it('attributes error messages to the input it was given', () => {
    expect(() => parseRuleList('[{}]', 'ignore-checks')).toThrow(
      /input `ignore-checks`/
    )
    expect(() => parseRuleList('[{}]', 'dedup-checks')).toThrow(
      /input `dedup-checks`/
    )
  })
})
