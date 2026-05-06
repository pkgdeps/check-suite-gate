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
        title: 'Waiting for Approve or Enable auto-merge',
        summary: 'Approve or click Enable auto-merge.'
      },
      details_url: 'https://example.com'
    })

    expect(mocks.list).not.toHaveBeenCalled()
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
        title: 'Waiting for Approve or Enable auto-merge',
        summary: 'Approve or click Enable auto-merge.'
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

  it('always creates a new check_run even when one already exists on the SHA', async () => {
    // Regression: PATCHing an existing check_run leaves it in its original
    // suite. The auto_merge_enabled run's suite stays without the
    // required check, and GitHub's required-check evaluation against the
    // latest suite blocks merge with "Expected — Waiting for status to
    // be reported". Posting a fresh check_run per run keeps every suite
    // populated.
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
      output: { title: 'All checks passed', summary: 'done' }
    })

    expect(mocks.list).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
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

  it('retries on 5xx errors from create', async () => {
    let attempt = 0
    const { octokit, mocks } = buildOctokit([], {
      createImpl: async () => {
        attempt++
        if (attempt === 1) throw { status: 500 }
        return {}
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
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })
})

describe('markCheckRunStale', () => {
  it('PATCHes every matching check_run with conclusion: cancelled', async () => {
    // writeCheckRun creates a fresh check_run per run, so a SHA carries
    // multiple matches across multiple suites. All of them must be
    // marked, otherwise stragglers keep the SHA visually "in progress".
    const a: CheckRunListItem = {
      id: 4242,
      name: 'automerge-gate/all-passed',
      status: 'queued',
      conclusion: null,
      external_id: CHECK_RUN_EXTERNAL_ID,
      app: { slug: 'github-actions' }
    }
    const b: CheckRunListItem = { ...a, id: 4243 }
    const { octokit, mocks } = buildOctokit([a, b])

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
    expect(mocks.update).toHaveBeenCalledTimes(2)
    expect(mocks.update).toHaveBeenNthCalledWith(1, {
      owner: 'o',
      repo: 'r',
      check_run_id: 4242,
      status: 'completed',
      conclusion: 'cancelled'
    })
    expect(mocks.update).toHaveBeenNthCalledWith(2, {
      owner: 'o',
      repo: 'r',
      check_run_id: 4243,
      status: 'completed',
      conclusion: 'cancelled'
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
