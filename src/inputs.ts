import { parseList } from './filter.js'

export type RawInputs = {
  context: string
  ignoreApps: string
  ignoreChecks: string
  mode: string
  token: string
  pollIntervalSeconds: string
}

export type ParsedInputs = {
  context: string
  ignoreApps: string[]
  ignoreChecks: string[]
  mode: 'commit-status' | 'fork'
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

const parseMode = (raw: string): 'commit-status' | 'fork' => {
  if (raw === 'commit-status' || raw === 'fork') return raw
  throw new Error(
    `input \`mode\` must be "commit-status" or "fork" (got: "${raw}")`
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
    mode: parseMode(raw.mode),
    token: raw.token,
    pollIntervalSeconds: parsePositiveInt(
      raw.pollIntervalSeconds,
      'poll-interval-seconds'
    )
  }
}
