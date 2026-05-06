import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import * as core from '@actions/core'
import { server } from './_msw/server.js'
import { buildDeps, buildInputs } from './_msw/fixtures.js'
import { runPrivate } from '../src/gate-private.js'

const BASE = 'https://api.github.com'

// `runPrivate` calls `core.summary.write()` which appends to
// $GITHUB_STEP_SUMMARY. We don't care about the actual file output here;
// stubbing the chained API to no-op keeps the tests hermetic.
const stubCoreSummary = (): void => {
  vi.spyOn(core.summary, 'write').mockResolvedValue(core.summary)
}

const captureStatusPosts = (
  bodies: Array<Record<string, unknown>>,
  shas: string[]
): void => {
  server.use(
    http.post(
      `${BASE}/repos/:owner/:repo/statuses/:sha`,
      async ({ request, params }) => {
        const body = (await request.json()) as Record<string, unknown>
        bodies.push(body)
        shas.push(params.sha as string)
        return HttpResponse.json(
          { id: bodies.length, sha: params.sha, ...body },
          { status: 201 }
        )
      }
    )
  )
}

describe('runPrivate', () => {
  beforeEach(() => {
    stubCoreSummary()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('synchronize without merge intent → no POST to /statuses', async () => {
    const postBodies: Array<Record<string, unknown>> = []
    const postShas: string[] = []
    captureStatusPosts(postBodies, postShas)

    const deps = buildDeps({
      eventName: 'pull_request',
      action: 'synchronize',
      before: 'sha-before',
      pr: { number: 1, head: { sha: 'sha-head' }, auto_merge: null }
    })

    await runPrivate(deps, buildInputs())

    expect(postBodies).toHaveLength(0)
  })

  it('auto_merge_enabled with empty check list → POST to /statuses with state: success', async () => {
    const postBodies: Array<Record<string, unknown>> = []
    const postShas: string[] = []
    captureStatusPosts(postBodies, postShas)

    const deps = buildDeps({
      eventName: 'pull_request',
      action: 'auto_merge_enabled',
      pr: {
        number: 1,
        head: { sha: 'sha-head' },
        auto_merge: { enabled_by: { login: 'maintainer' } }
      }
    })

    await runPrivate(deps, buildInputs())

    // Single POST: the final verdict. v4 keeps v3's "no pre-write" rule
    // and additionally swaps the API call from check_run create to
    // commit status, so polling does exactly one POST per run.
    expect(postBodies).toHaveLength(1)
    expect(postShas[0]).toBe('sha-head')
    expect(postBodies[0]).toMatchObject({
      state: 'success',
      context: 'automerge-gate/all-passed'
    })
    expect(typeof postBodies[0].description).toBe('string')
    expect(typeof postBodies[0].target_url).toBe('string')
  })

  it('synchronize with auto-merge on → fresh POST to /statuses for new SHA (no PATCH for previous SHA)', async () => {
    const postBodies: Array<Record<string, unknown>> = []
    const postShas: string[] = []
    captureStatusPosts(postBodies, postShas)

    const deps = buildDeps({
      eventName: 'pull_request',
      action: 'synchronize',
      before: 'sha-before',
      pr: {
        number: 1,
        head: { sha: 'sha-head' },
        auto_merge: { enabled_by: { login: 'maintainer' } }
      }
    })

    await runPrivate(deps, buildInputs())

    // v4 commit status is keyed by `(SHA, context)` and append-only;
    // the previous SHA's status doesn't need to be marked stale (no
    // markCheckRunStale equivalent). One POST: the new SHA's verdict.
    expect(postBodies).toHaveLength(1)
    expect(postShas).toEqual(['sha-head'])
    expect(postBodies[0]).toMatchObject({
      state: 'success',
      context: 'automerge-gate/all-passed'
    })
  })

  it('pull_request_review.submitted approved by write-permission user → POST to /statuses', async () => {
    const postBodies: Array<Record<string, unknown>> = []
    const postShas: string[] = []
    server.use(
      http.get(`${BASE}/repos/:owner/:repo/pulls/:n/reviews`, () =>
        HttpResponse.json([
          {
            state: 'APPROVED',
            submitted_at: '2026-05-06T00:00:00Z',
            user: { login: 'reviewer' },
            author_association: 'MEMBER'
          }
        ])
      ),
      http.get(
        `${BASE}/repos/:owner/:repo/collaborators/:u/permission`,
        ({ params }) =>
          HttpResponse.json({
            permission: 'write',
            role_name: 'write',
            user: { login: params.u as string }
          })
      )
    )
    captureStatusPosts(postBodies, postShas)

    const deps = buildDeps({
      eventName: 'pull_request_review',
      action: 'submitted',
      reviewState: 'approved',
      pr: { number: 1, head: { sha: 'sha-head' }, auto_merge: null }
    })

    await runPrivate(deps, buildInputs())

    // Approve from a write-permission user is merge intent → polling fires.
    // Single POST: final success on the empty check list.
    expect(postBodies).toHaveLength(1)
    expect(postBodies[0]).toMatchObject({
      state: 'success',
      context: 'automerge-gate/all-passed'
    })
  })

  it('drive-by Approve (read permission) → no POST', async () => {
    const postBodies: Array<Record<string, unknown>> = []
    const postShas: string[] = []
    server.use(
      http.get(`${BASE}/repos/:owner/:repo/pulls/:n/reviews`, () =>
        HttpResponse.json([
          {
            state: 'APPROVED',
            submitted_at: '2026-05-06T00:00:00Z',
            user: { login: 'driveby' },
            author_association: 'CONTRIBUTOR'
          }
        ])
      ),
      // Default already returns permission: read; keeping explicit for clarity.
      http.get(
        `${BASE}/repos/:owner/:repo/collaborators/:u/permission`,
        ({ params }) =>
          HttpResponse.json({
            permission: 'read',
            role_name: 'read',
            user: { login: params.u as string }
          })
      )
    )
    captureStatusPosts(postBodies, postShas)

    const deps = buildDeps({
      eventName: 'pull_request_review',
      action: 'submitted',
      reviewState: 'approved',
      pr: { number: 1, head: { sha: 'sha-head' }, auto_merge: null }
    })

    await runPrivate(deps, buildInputs())

    expect(postBodies).toHaveLength(0)
  })
})
