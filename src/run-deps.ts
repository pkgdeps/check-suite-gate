import type { OctokitLike } from './api.js'
import type { ReviewState } from './mode.js'

export type RunContext = {
  eventName: string
  action: string
  pr: {
    number: number
    head: { sha: string }
    auto_merge: { enabled_by: { login: string } } | null
  }
  reviewState: ReviewState | null
  before: string | undefined
  owner: string
  repo: string
}

export type RunEnv = {
  runId: number
  runAttempt: number
  serverUrl: string
  repository: string
  workflowRef: string | undefined
}

export type RunDeps = {
  octokit: OctokitLike
  context: RunContext
  env: RunEnv
}
