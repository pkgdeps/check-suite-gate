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

describe('runPrivate', () => {
  beforeEach(() => {
    stubCoreSummary()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('synchronize without merge intent → no POST/PATCH to check-runs', async () => {
    const postBodies: Array<Record<string, unknown>> = []
    const patchIds: number[] = []
    server.use(
      http.post(
        `${BASE}/repos/:owner/:repo/check-runs`,
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>
          postBodies.push(body)
          return HttpResponse.json({
            ...body,
            id: 1,
            check_suite: { id: 1 },
            html_url: 'https://example.com'
          })
        }
      ),
      http.patch(`${BASE}/repos/:owner/:repo/check-runs/:id`, ({ params }) => {
        patchIds.push(Number(params.id))
        return HttpResponse.json({ id: Number(params.id) })
      })
    )

    const deps = buildDeps({
      eventName: 'pull_request',
      action: 'synchronize',
      before: 'sha-before',
      pr: { number: 1, head: { sha: 'sha-head' }, auto_merge: null }
    })

    await runPrivate(deps, buildInputs())

    expect(postBodies).toHaveLength(0)
    expect(patchIds).toHaveLength(0)
  })

  it('auto_merge_enabled with empty check list → POST to check-runs with conclusion: success', async () => {
    const postBodies: Array<Record<string, unknown>> = []
    server.use(
      http.post(
        `${BASE}/repos/:owner/:repo/check-runs`,
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>
          postBodies.push(body)
          return HttpResponse.json({
            ...body,
            id: postBodies.length,
            check_suite: { id: 1 },
            html_url: 'https://example.com'
          })
        }
      )
    )

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

    // Single POST: the final verdict. v3 removed the queued pre-write
    // (the v2 race it guarded against is structurally gone in the
    // single-job pattern), so polling now does one POST per run.
    expect(postBodies).toHaveLength(1)
    expect(postBodies[0].status).toBe('completed')
    expect(postBodies[0].conclusion).toBe('success')
  })

  it('synchronize with before SHA + auto-merge on + matching check_run on before → PATCH cancelled + fresh POST for new SHA', async () => {
    const postBodies: Array<Record<string, unknown>> = []
    const patchCalls: Array<{ id: number; body: Record<string, unknown> }> = []
    server.use(
      // The previous SHA already has one of our aggregated check_runs.
      http.get(
        `${BASE}/repos/:owner/:repo/commits/:sha/check-runs`,
        ({ params }) => {
          if (params.sha === 'sha-before') {
            return HttpResponse.json({
              total_count: 1,
              check_runs: [
                {
                  id: 4242,
                  name: 'automerge-gate/all-passed',
                  status: 'queued',
                  conclusion: null,
                  external_id: 'automerge-gate',
                  app: { slug: 'github-actions' }
                }
              ]
            })
          }
          return HttpResponse.json({ total_count: 0, check_runs: [] })
        }
      ),
      http.post(
        `${BASE}/repos/:owner/:repo/check-runs`,
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>
          postBodies.push(body)
          return HttpResponse.json({
            ...body,
            id: 100 + postBodies.length,
            check_suite: { id: 9 },
            html_url: 'https://example.com'
          })
        }
      ),
      http.patch(
        `${BASE}/repos/:owner/:repo/check-runs/:id`,
        async ({ params, request }) => {
          const body = (await request.json()) as Record<string, unknown>
          patchCalls.push({ id: Number(params.id), body })
          return HttpResponse.json({ id: Number(params.id) })
        }
      )
    )

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

    // PATCH on old SHA's check_run with conclusion=cancelled.
    expect(patchCalls).toHaveLength(1)
    expect(patchCalls[0].id).toBe(4242)
    expect(patchCalls[0].body.conclusion).toBe('cancelled')

    // Single fresh POST on the new SHA with the final verdict (no
    // queued pre-write in v3).
    expect(postBodies).toHaveLength(1)
    expect(postBodies[0].head_sha).toBe('sha-head')
    expect(postBodies[0].status).toBe('completed')
    expect(postBodies[0].conclusion).toBe('success')
  })

  it('pull_request_review.submitted approved by write-permission user → POST to check-runs', async () => {
    const postBodies: Array<Record<string, unknown>> = []
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
      ),
      http.post(
        `${BASE}/repos/:owner/:repo/check-runs`,
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>
          postBodies.push(body)
          return HttpResponse.json({
            ...body,
            id: postBodies.length,
            check_suite: { id: 1 },
            html_url: 'https://example.com'
          })
        }
      )
    )

    const deps = buildDeps({
      eventName: 'pull_request_review',
      action: 'submitted',
      reviewState: 'approved',
      pr: { number: 1, head: { sha: 'sha-head' }, auto_merge: null }
    })

    await runPrivate(deps, buildInputs())

    // Approve from a write-permission user is merge intent → polling fires.
    // Single POST: final success on the empty check list (no queued
    // pre-write in v3).
    expect(postBodies).toHaveLength(1)
    expect(postBodies[0].status).toBe('completed')
    expect(postBodies[0].conclusion).toBe('success')
  })

  it('drive-by Approve (read permission) → no POST', async () => {
    const postBodies: Array<Record<string, unknown>> = []
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
      ),
      http.post(
        `${BASE}/repos/:owner/:repo/check-runs`,
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>
          postBodies.push(body)
          return HttpResponse.json({
            ...body,
            id: 1,
            check_suite: { id: 1 },
            html_url: 'https://example.com'
          })
        }
      )
    )

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
