import { parseList } from './filter.js'

export type RawInputs = {
  context: string
  ignoreApps: string
  ignoreChecks: string
  token: string
  pollIntervalSeconds: string
  forkPolicy: string
}

export type ParsedInputs = {
  context: string
  ignoreApps: string[]
  ignoreChecks: string[]
  token: string
  pollIntervalSeconds: number
  forkPolicy: 'skip' | 'success'
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

const parseForkPolicy = (raw: string): 'skip' | 'success' => {
  if (raw === 'skip' || raw === 'success') return raw
  throw new Error(
    `input \`fork-policy\` must be "skip" or "success" (got: "${raw}")`
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
    token: raw.token,
    pollIntervalSeconds: parsePositiveInt(
      raw.pollIntervalSeconds,
      'poll-interval-seconds'
    ),
    forkPolicy: parseForkPolicy(raw.forkPolicy)
  }
}
