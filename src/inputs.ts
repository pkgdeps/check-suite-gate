import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError
} from 'jsonc-parser'

export type RawInputs = {
  context: string
  ignoreChecks: string
  gateMode: string
  token: string
  pollIntervalSeconds: string
}

export type GateMode = 'private' | 'public'

// One row in `ignore-checks`. At least one of `app` / `workflow` / `name`
// must be set; an empty object is rejected at parse time. All present
// fields must match (AND) for a check_run to be excluded. Each value is
// a glob (`*` / `?`); a literal string matches exactly.
//
// The schema deliberately mirrors what `gh api ... | jq` emits, so the
// inspection output can be pasted into `ignore-checks` with no rewriting.
export type IgnoreRule = {
  app?: string
  workflow?: string
  name?: string
}

export type ParsedInputs = {
  context: string
  ignoreChecks: IgnoreRule[]
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

const validateRule = (raw: unknown, index: number): IgnoreRule => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(
      `input \`ignore-checks\`: entry [${index}] must be an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`
    )
  }
  const obj = raw as Record<string, unknown>
  const rule: IgnoreRule = {}
  for (const [key, value] of Object.entries(obj)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new Error(
        `input \`ignore-checks\`: entry [${index}] has unknown field "${key}" (allowed: app, workflow, name)`
      )
    }
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(
        `input \`ignore-checks\`: entry [${index}].${key} must be a non-empty string`
      )
    }
    rule[key as keyof IgnoreRule] = value
  }
  if (Object.keys(rule).length === 0) {
    throw new Error(
      `input \`ignore-checks\`: entry [${index}] is an empty object — at least one of app / workflow / name must be set`
    )
  }
  return rule
}

// Parses the `ignore-checks` input. The format is a JSONC array (JSON
// with `//` and `/* */` comments plus trailing commas) whose entries are
// IgnoreRule objects. Empty input is treated as an empty array.
export const parseIgnoreChecks = (raw: string): IgnoreRule[] => {
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
    throw new Error(`input \`ignore-checks\`: JSONC parse failed: ${summary}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `input \`ignore-checks\`: top-level value must be an array (got ${parsed === null ? 'null' : typeof parsed})`
    )
  }
  return parsed.map((entry, i) => validateRule(entry, i))
}

export const parseInputs = (raw: RawInputs): ParsedInputs => {
  if (raw.token.trim().length === 0) {
    throw new Error('input `token` must not be empty')
  }
  return {
    context: raw.context,
    ignoreChecks: parseIgnoreChecks(raw.ignoreChecks),
    gateMode: parseGateMode(raw.gateMode),
    token: raw.token,
    pollIntervalSeconds: parsePositiveInt(
      raw.pollIntervalSeconds,
      'poll-interval-seconds'
    )
  }
}
