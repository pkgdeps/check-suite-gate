import { parseList } from './filter.js'

export type RawInputs = {
  context: string
  ignoreApps: string
  ignoreChecks: string
  token: string
}

export type ParsedInputs = {
  context: string
  ignoreApps: string[]
  ignoreChecks: string[]
  token: string
}

export const parseInputs = (raw: RawInputs): ParsedInputs => {
  if (raw.token.trim().length === 0) {
    throw new Error('input `token` must not be empty')
  }
  return {
    context: raw.context,
    ignoreApps: parseList(raw.ignoreApps),
    ignoreChecks: parseList(raw.ignoreChecks),
    token: raw.token
  }
}
