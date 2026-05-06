import { describe, it, expect, vi } from 'vitest'
import {
  buildTargetUrl,
  writeCheckRun,
  markCheckRunStale,
  CHECK_RUN_EXTERNAL_ID
} from '../src/check-run.js'
import type { OctokitLike, CheckRunListItem } from '../src/api.js'

type Mocks = {
  list: ReturnType<typeof vi.fn>
  create: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
}

const buildOctokit = (
  listResult: CheckRunListItem[] = [],
  overrides: Partial<{
    listImpl: () => Promise<{ data: { check_runs: CheckRunListItem[] } }>
    createImpl: () => Promise<unknown>
    updateImpl: () => Promise<unknown>
  }> = {}
): { octokit: OctokitLike; mocks: Mocks } => {
  const list =
    overrides.listImpl !== undefined
      ? vi.fn(overrides.listImpl)
      : vi.fn().mockResolvedValue({ data: { check_runs: listResult } })
  const create =
    overrides.createImpl !== undefined
      ? vi.fn(overrides.createImpl)
      : vi.fn().mockResolvedValue({})
  const update =
    overrides.updateImpl !== undefined
      ? vi.fn(overrides.updateImpl)
      : vi.fn().mockResolvedValue({})
  const octokit = {
    rest: {
      checks: {
        listForRef: list,
        create,
        update
      }
    }
  } as unknown as OctokitLike
  return { octokit, mocks: { list, create, update } }
}

describe('buildTargetUrl', () => {
  it('composes the run page URL including the run_attempt', () => {
    const url = buildTargetUrl({
      serverUrl: 'https://github.com',
      repository: 'owner/repo',
      runId: 42,
      runAttempt: 3
    })
    expect(url).toBe('https://github.com/owner/repo/actions/runs/42/attempts/3')
  })
})

describe('writeCheckRun', () => {
  it('creates a queued check_run (no conclusion) for pending state', async () => {
    const { octokit, mocks } = buildOctokit([])
    await writeCheckRun(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'abc',
      state: 'pending',
      name: 'automerge-gate/all-passed',
      output: {
        title: 'Waiting for Enable auto-merge',
        summary: 'Click Enable auto-merge.'
      },
      details_url: 'https://example.com'
    })

    expect(mocks.list).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      ref: 'abc',
      check_name: 'automerge-gate/all-passed',
      per_page: 100
    })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      name: 'automerge-gate/all-passed',
      head_sha: 'abc',
      status: 'queued',
      conclusion: undefined,
      external_id: CHECK_RUN_EXTERNAL_ID,
      output: {
        title: 'Waiting for Enable auto-merge',
        summary: 'Click Enable auto-merge.'
      },
      details_url: 'https://example.com'
    })
  })

  it('creates a completed check_run with conclusion=success', async () => {
    const { octokit, mocks } = buildOctokit([])
    await writeCheckRun(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'abc',
      state: 'success',
      name: 'automerge-gate/all-passed',
      output: { title: 'All checks passed', summary: 'All 5 checks passed.' }
    })

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        conclusion: 'success',
        output: { title: 'All checks passed', summary: 'All 5 checks passed.' }
      })
    )
  })

  it('creates a completed check_run with conclusion=failure', async () => {
    const { octokit, mocks } = buildOctokit([])
    await writeCheckRun(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'abc',
      state: 'failure',
      name: 'automerge-gate/all-passed'
    })

    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'completed',
        conclusion: 'failure'
      })
    )
  })

  it('updates an existing check_run (matched by external_id) instead of creating a new one', async () => {
    const existing: CheckRunListItem = {
      id: 9999,
      name: 'automerge-gate/all-passed',
      status: 'queued',
      conclusion: null,
      external_id: CHECK_RUN_EXTERNAL_ID,
      app: { slug: 'github-actions' }
    }
    const { octokit, mocks } = buildOctokit([existing])

    await writeCheckRun(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'abc',
      state: 'success',
      name: 'automerge-gate/all-passed',
      output: { title: 'All checks passed', summary: 'done' },
      details_url: 'https://example.com'
    })

    expect(mocks.create).not.toHaveBeenCalled()
    expect(mocks.update).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      check_run_id: 9999,
      status: 'completed',
      conclusion: 'success',
      output: { title: 'All checks passed', summary: 'done' },
      details_url: 'https://example.com'
    })
  })

  it('skips a same-name check_run with a different external_id (avoids hijacking)', async () => {
    const unrelated: CheckRunListItem = {
      id: 1234,
      name: 'automerge-gate/all-passed',
      status: 'completed',
      conclusion: 'success',
      external_id: 'someone-else',
      app: { slug: 'other-app' }
    }
    const { octokit, mocks } = buildOctokit([unrelated])

    await writeCheckRun(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'abc',
      state: 'pending',
      name: 'automerge-gate/all-passed'
    })

    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('retries on 5xx errors during list', async () => {
    let attempt = 0
    const { octokit, mocks } = buildOctokit([], {
      listImpl: async () => {
        attempt++
        if (attempt === 1) throw { status: 500 }
        return { data: { check_runs: [] } }
      }
    })

    await writeCheckRun(
      octokit,
      {
        owner: 'o',
        repo: 'r',
        sha: 'abc',
        state: 'success',
        name: 'ctx'
      },
      { retries: 3, baseDelayMs: 1 }
    )
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })

  it('does not retry on 4xx errors from create', async () => {
    const { octokit, mocks } = buildOctokit([], {
      createImpl: async () => {
        throw { status: 422 }
      }
    })

    await expect(
      writeCheckRun(
        octokit,
        {
          owner: 'o',
          repo: 'r',
          sha: 'abc',
          state: 'failure',
          name: 'ctx'
        },
        { retries: 3, baseDelayMs: 1 }
      )
    ).rejects.toEqual({ status: 422 })
    expect(mocks.create).toHaveBeenCalledTimes(1)
  })
})

describe('markCheckRunStale', () => {
  it('PATCHes a matching check_run with conclusion: stale', async () => {
    const existing: CheckRunListItem = {
      id: 4242,
      name: 'automerge-gate/all-passed',
      status: 'queued',
      conclusion: null,
      external_id: CHECK_RUN_EXTERNAL_ID,
      app: { slug: 'github-actions' }
    }
    const { octokit, mocks } = buildOctokit([existing])

    await markCheckRunStale(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'old-sha',
      name: 'automerge-gate/all-passed'
    })

    expect(mocks.list).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      ref: 'old-sha',
      check_name: 'automerge-gate/all-passed',
      per_page: 100
    })
    expect(mocks.update).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      check_run_id: 4242,
      status: 'completed',
      conclusion: 'stale'
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('no-ops when no matching check_run is found', async () => {
    const { octokit, mocks } = buildOctokit([])

    await markCheckRunStale(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'old-sha',
      name: 'automerge-gate/all-passed'
    })

    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('skips check_runs with a different external_id', async () => {
    const unrelated: CheckRunListItem = {
      id: 1,
      name: 'automerge-gate/all-passed',
      status: 'completed',
      conclusion: 'success',
      external_id: 'someone-else',
      app: { slug: 'other-app' }
    }
    const { octokit, mocks } = buildOctokit([unrelated])

    await markCheckRunStale(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'old-sha',
      name: 'automerge-gate/all-passed'
    })

    expect(mocks.update).not.toHaveBeenCalled()
  })
})
