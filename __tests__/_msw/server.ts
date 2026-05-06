import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'

const BASE = 'https://api.github.com'

// Default handlers: empty results everywhere — tests override per-case.
//
// Endpoints that octokit's paginate plugin recognises (check-suites,
// check-runs) wrap their array under a namespace key alongside
// `total_count`. The plugin extracts the array only when `total_count`
// is present (see normalize-paginated-list-response.js); without it,
// paginate yields the entire response object as a single element. So
// every paginated default response below carries `total_count`.
export const defaultHandlers = [
  http.get(`${BASE}/repos/:owner/:repo/commits/:sha/check-suites`, () =>
    HttpResponse.json({ total_count: 0, check_suites: [] })
  ),
  http.get(`${BASE}/repos/:owner/:repo/check-suites/:id/check-runs`, () =>
    HttpResponse.json({ total_count: 0, check_runs: [] })
  ),
  http.post(
    `${BASE}/repos/:owner/:repo/statuses/:sha`,
    async ({ request, params }) => {
      const body = (await request.json()) as Record<string, unknown>
      return HttpResponse.json(
        {
          id: 1,
          sha: params.sha,
          url: `${BASE}/repos/${params.owner}/${params.repo}/statuses/${params.sha}`,
          ...body
        },
        { status: 201 }
      )
    }
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
