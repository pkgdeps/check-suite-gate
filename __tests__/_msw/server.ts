import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

const BASE = 'https://api.github.com'

// Default handlers: empty results everywhere — tests override per-case.
export const defaultHandlers = [
  http.get(`${BASE}/repos/:owner/:repo/commits/:sha/check-suites`, () =>
    HttpResponse.json({ check_suites: [] })
  ),
  http.get(`${BASE}/repos/:owner/:repo/check-suites/:id/check-runs`, () =>
    HttpResponse.json({ check_runs: [] })
  ),
  http.get(`${BASE}/repos/:owner/:repo/commits/:sha/check-runs`, () =>
    HttpResponse.json({ check_runs: [] })
  ),
  http.post(`${BASE}/repos/:owner/:repo/check-runs`, async ({ request }) => {
    const body = (await request.json()) as Record<string, unknown>
    return HttpResponse.json({
      ...body,
      id: 999,
      check_suite: { id: 1 },
      html_url: 'https://example.com'
    })
  }),
  http.patch(`${BASE}/repos/:owner/:repo/check-runs/:id`, ({ params }) =>
    HttpResponse.json({ id: Number(params.id) })
  ),
  http.get(`${BASE}/repos/:owner/:repo/pulls/:n/reviews`, () =>
    HttpResponse.json([])
  ),
  http.get(
    `${BASE}/repos/:owner/:repo/collaborators/:u/permission`,
    ({ params }) =>
      HttpResponse.json({
        permission: 'read',
        role_name: 'read',
        user: { login: params.u as string }
      })
  ),
  http.get(`${BASE}/repos/:owner/:repo/actions/runs/:id`, () =>
    HttpResponse.json({ path: '.github/workflows/other.yml' })
  )
]

export const server = setupServer(...defaultHandlers)
