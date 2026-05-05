import { describe, it, expect, vi } from 'vitest'
import { buildTargetUrl, writeCommitStatus } from '../src/status.js'
import type { OctokitLike } from '../src/api.js'

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

describe('writeCommitStatus', () => {
  it('posts a commit status with state, context, and target_url', async () => {
    const create = vi.fn().mockResolvedValue({})
    const octokit = {
      rest: { repos: { createCommitStatus: create } }
    } as unknown as OctokitLike

    await writeCommitStatus(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'abc',
      state: 'success',
      context: 'check-suite-gate/all-passed',
      description: 'All 5 checks passed',
      target_url: 'https://example.com'
    })

    expect(create).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      sha: 'abc',
      state: 'success',
      context: 'check-suite-gate/all-passed',
      description: 'All 5 checks passed',
      target_url: 'https://example.com'
    })
  })

  it('retries on 5xx errors', async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce({ status: 500 })
      .mockResolvedValue({})
    const octokit = {
      rest: { repos: { createCommitStatus: create } }
    } as unknown as OctokitLike

    await writeCommitStatus(
      octokit,
      {
        owner: 'o',
        repo: 'r',
        sha: 'abc',
        state: 'success',
        context: 'ctx'
      },
      { retries: 3, baseDelayMs: 1 }
    )
    expect(create).toHaveBeenCalledTimes(2)
  })

  it('does not retry on 4xx errors', async () => {
    const create = vi.fn().mockRejectedValue({ status: 422 })
    const octokit = {
      rest: { repos: { createCommitStatus: create } }
    } as unknown as OctokitLike

    await expect(
      writeCommitStatus(
        octokit,
        {
          owner: 'o',
          repo: 'r',
          sha: 'abc',
          state: 'failure',
          context: 'ctx'
        },
        { retries: 3, baseDelayMs: 1 }
      )
    ).rejects.toEqual({ status: 422 })
    expect(create).toHaveBeenCalledTimes(1)
  })
})
