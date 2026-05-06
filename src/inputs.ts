import { parseList } from './filter.js'

export type RawInputs = {
  context: string
  ignoreApps: string
  ignoreChecks: string
  token: string
  pollIntervalSeconds: string
}

export type ParsedInputs = {
  context: string
  ignoreApps: string[]
  ignoreChecks: string[]
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

export const parseInputs = (raw: RawInputs): ParsedInputs => {
  if (raw.token.trim().length === 0) {
    throw new Error('input `token` must not be empty')
  }
  return {
    context: raw.context,
    ignoreApps: parseList(raw.ignoreApps),
    ignoreChecks: parseList(raw.ignoreChecks),
    token: raw.token,
    pollIntervalSeconds: parsePositiveInt(
      raw.pollIntervalSeconds,
      'poll-interval-seconds'
    )
  }
}
