import * as github from '@actions/github'
import type { OctokitLike } from '../../src/api.js'
import type { ParsedInputs } from '../../src/inputs.js'
import type { RunContext, RunDeps, RunEnv } from '../../src/run-deps.js'

// Builds a real Octokit instance via @actions/github so msw can intercept
// the underlying HTTP calls. The structural OctokitLike contract is a
// subset of the real Octokit, so `as unknown as` is fine.
//
// `request.fetch: globalThis.fetch` overrides @actions/github's default
// proxy-aware fetch (which calls `undici.fetch` directly via a named
// import — a code path msw's setupServer does not intercept). msw v2
// patches globalThis.fetch, so swapping in the global fetch wires the
// requests through the msw mock server.
const buildOctokit = (): OctokitLike =>
  github.getOctokit('test-token', {
    request: { fetch: globalThis.fetch }
  }) as unknown as OctokitLike

const defaultContext: RunContext = {
  eventName: 'pull_request',
  action: 'opened',
  pr: { number: 1, head: { sha: 'sha-head' }, auto_merge: null },
  reviewState: null,
  before: undefined,
  owner: 'o',
  repo: 'r'
}

const defaultEnv: RunEnv = {
  runId: 1,
  runAttempt: 1,
  serverUrl: 'https://github.com',
  repository: 'o/r',
  workflowRef: undefined
}

export const buildDeps = (
  contextOverride: Partial<RunContext> = {},
  envOverride: Partial<RunEnv> = {}
): RunDeps => ({
  octokit: buildOctokit(),
  context: { ...defaultContext, ...contextOverride },
  env: { ...defaultEnv, ...envOverride }
})

export const buildInputs = (
  override: Partial<ParsedInputs> = {}
): ParsedInputs => ({
  context: 'automerge-gate/all-passed',
  ignoreChecks: [],
  dedupChecks: [],
  gateMode: 'private',
  token: 'test-token',
  pollIntervalSeconds: 1,
  ...override
})
