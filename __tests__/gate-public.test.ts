import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import * as core from '@actions/core'
import { server } from './_msw/server.js'
import { buildDeps, buildInputs } from './_msw/fixtures.js'
import { runPublic } from '../src/gate-public.js'

const BASE = 'https://api.github.com'

// `runPublic` calls `core.summary.write()` which appends to
// $GITHUB_STEP_SUMMARY. We don't care about the actual file output here;
// stubbing the chained API to no-op keeps the tests hermetic.
const stubCoreSummary = (): void => {
  vi.spyOn(core.summary, 'write').mockResolvedValue(core.summary)
}

describe('runPublic', () => {
  beforeEach(() => {
    stubCoreSummary()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('any event → polling runs (suites endpoint hit), no POST/PATCH to check-runs', async () => {
    const suitesCalls: string[] = []
    const postBodies: Array<Record<string, unknown>> = []
    const patchIds: number[] = []
    server.use(
      http.get(
        `${BASE}/repos/:owner/:repo/commits/:sha/check-suites`,
        ({ params }) => {
          suitesCalls.push(params.sha as string)
          return HttpResponse.json({ total_count: 0, check_suites: [] })
        }
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
      ),
      http.patch(`${BASE}/repos/:owner/:repo/check-runs/:id`, ({ params }) => {
        patchIds.push(Number(params.id))
        return HttpResponse.json({ id: Number(params.id) })
      })
    )

    const deps = buildDeps({
      eventName: 'pull_request',
      action: 'opened',
      pr: { number: 1, head: { sha: 'sha-head' }, auto_merge: null }
    })

    await runPublic(deps, buildInputs({ gateMode: 'public' }))

    // Polling reached the suites endpoint at least once.
    expect(suitesCalls.length).toBeGreaterThanOrEqual(1)
    expect(suitesCalls[0]).toBe('sha-head')
    // runPublic never writes its own check_run.
    expect(postBodies).toHaveLength(0)
    expect(patchIds).toHaveLength(0)
  })

  it('empty check list → polling exits success (no setFailed)', async () => {
    const setFailedSpy = vi
      .spyOn(core, 'setFailed')
      .mockImplementation(() => {})

    const deps = buildDeps()
    await runPublic(deps, buildInputs({ gateMode: 'public' }))

    expect(setFailedSpy).not.toHaveBeenCalled()
  })

  it('failing aggregate → core.setFailed is called', async () => {
    const setFailedSpy = vi
      .spyOn(core, 'setFailed')
      .mockImplementation(() => {})
    server.use(
      http.get(`${BASE}/repos/:owner/:repo/commits/:sha/check-suites`, () =>
        HttpResponse.json({
          total_count: 1,
          check_suites: [
            { id: 7, app: { slug: 'github-actions' }, status: 'completed' }
          ]
        })
      ),
      http.get(`${BASE}/repos/:owner/:repo/check-suites/:id/check-runs`, () =>
        HttpResponse.json({
          total_count: 1,
          check_runs: [
            {
              id: 71,
              name: 'lint',
              status: 'completed',
              conclusion: 'failure',
              details_url: ''
            }
          ]
        })
      )
    )

    const deps = buildDeps()
    await runPublic(deps, buildInputs({ gateMode: 'public' }))

    expect(setFailedSpy).toHaveBeenCalledTimes(1)
    expect(String(setFailedSpy.mock.calls[0][0])).toContain('failure')
  })
})
