import { parseList } from './filter.js'

export type RawInputs = {
  context: string
  ignoreApps: string
  ignoreChecks: string
  gateMode: string
  token: string
  pollIntervalSeconds: string
}

export type GateMode = 'private' | 'public'

export type ParsedInputs = {
  context: string
  ignoreApps: string[]
  ignoreChecks: string[]
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

export const parseInputs = (raw: RawInputs): ParsedInputs => {
  if (raw.token.trim().length === 0) {
    throw new Error('input `token` must not be empty')
  }
  return {
    context: raw.context,
    ignoreApps: parseList(raw.ignoreApps),
    ignoreChecks: parseList(raw.ignoreChecks),
    gateMode: parseGateMode(raw.gateMode),
    token: raw.token,
    pollIntervalSeconds: parsePositiveInt(
      raw.pollIntervalSeconds,
      'poll-interval-seconds'
    )
  }
}
