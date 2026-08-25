import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError
} from 'jsonc-parser'

export type RawInputs = {
  context: string
  ignoreChecks: string
  dedupChecks: string
  gateMode: string
  token: string
  pollIntervalSeconds: string
}

export type GateMode = 'private' | 'public'

// One row in `ignore-checks` / `dedup-checks`. At least one of `app` /
// `workflow` / `name` must be set; an empty object is rejected at parse
// time. All present fields must match (AND) for a check_run to match the
// rule. Each value is a glob (`*` / `?`); a literal string matches exactly.
//
// The schema deliberately mirrors what `gh api ... | jq` emits, so the
// inspection output can be pasted into either input with no rewriting.
export type CheckRule = {
  app?: string
  workflow?: string
  name?: string
}

export type ParsedInputs = {
  context: string
  ignoreChecks: CheckRule[]
  dedupChecks: CheckRule[]
  gateMode: GateMode
  token: string
  pollIntervalSeconds: number
}

const parsePositiveInt = (raw: string, name: string): number => {
  const n = Number.parseInt(raw, 10)
  if (Number.isNaN(n) || n <= 0) {
    throw new Error(
      `input \`${name}\` must be a positive integer (got: "${raw}")`
    )
  }
  return n
}

const parseGateMode = (raw: string): GateMode => {
  if (raw === 'private' || raw === 'public') return raw
  throw new Error(
    `input \`gate-mode\` must be "private" or "public" (got: "${raw}"). ` +
      `If migrating from v2: gate: main → gate-mode: private, gate: fork → gate-mode: public.`
  )
}

const ALLOWED_FIELDS = new Set(['app', 'workflow', 'name'])

const validateRule = (
  raw: unknown,
  index: number,
  inputName: string
): CheckRule => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      `input \`${inputName}\`: entry [${index}] must be an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`
    )
  }
  const obj = raw as Record<string, unknown>
  const rule: CheckRule = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(
        `input \`${inputName}\`: entry [${index}] has unknown field "${key}" (allowed: app, workflow, name)`
      )
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `input \`${inputName}\`: entry [${index}].${key} must be a non-empty string`
      )
    }
    rule[key as keyof CheckRule] = value
  }
  if (Object.keys(rule).length === 0) {
    throw new Error(
      `input \`${inputName}\`: entry [${index}] is an empty object — at least one of app / workflow / name must be set`
    )
  }
  return rule
}

// Parses a rule-list input (`ignore-checks` / `dedup-checks` — both share
// the CheckRule schema). The format is a JSONC array (JSON with `//` and
// `/* */` comments plus trailing commas) whose entries are CheckRule
// objects. Empty input is treated as an empty array. `inputName` is only
// used to attribute error messages to the offending input.
export const parseRuleList = (raw: string, inputName: string): CheckRule[] => {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return []
  const errors: ParseError[] = []
  const parsed: unknown = parseJsonc(trimmed, errors, {
    allowTrailingComma: true,
    disallowComments: false
  })
  if (errors.length > 0) {
    const summary = errors
      .map((e) => {
        // Reproduce the offending fragment so the user can locate it
        // without manually counting characters.
        const snippet = trimmed
          .slice(e.offset, e.offset + Math.max(e.length, 1))
          .replace(/\n/g, '\\n')
        return `${printParseErrorCode(e.error)} at offset ${e.offset} ("${snippet}")`
      })
      .join('; ')
    throw new Error(`input \`${inputName}\`: JSONC parse failed: ${summary}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `input \`${inputName}\`: top-level value must be an array (got ${parsed === null ? 'null' : typeof parsed})`
    )
  }
  return parsed.map((entry, i) => validateRule(entry, i, inputName))
}

// `dedup-checks` rules must be scoped by `workflow` or `app` — stricter
// than `ignore-checks`. Dedup drops runs, and a bare `name` rule would
// silently enroll every workflow and app whose job happens to share the
// name into latest-run-wins, which can discard a genuine failure (e.g. a
// workflow triggered by both push and pull_request where only the older
// run fails). `name` is still allowed to narrow a scoped rule.
export const parseDedupChecks = (raw: string): CheckRule[] => {
  const rules = parseRuleList(raw, 'dedup-checks')
  for (const [index, rule] of rules.entries()) {
    if (rule.workflow === undefined && rule.app === undefined) {
      throw new Error(
        `input \`dedup-checks\`: entry [${index}] must set \`workflow\` or \`app\` — \`name\` alone would opt every workflow/app with that job name into latest-run-wins`
      )
    }
  }
  return rules
}

export const parseInputs = (raw: RawInputs): ParsedInputs => {
  if (raw.token.trim().length === 0) {
    throw new Error('input `token` must not be empty')
  }
  return {
    context: raw.context,
    ignoreChecks: parseRuleList(raw.ignoreChecks, 'ignore-checks'),
    dedupChecks: parseDedupChecks(raw.dedupChecks),
    gateMode: parseGateMode(raw.gateMode),
    token: raw.token,
    pollIntervalSeconds: parsePositiveInt(
      raw.pollIntervalSeconds,
      'poll-interval-seconds'
    )
  }
}
