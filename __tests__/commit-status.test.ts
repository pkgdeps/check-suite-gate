import { describe, it, expect, vi } from 'vitest'
import { buildTargetUrl, writeCommitStatus } from '../src/commit-status.js'
import type { CreateCommitStatusParams, OctokitLike } from '../src/api.js'

type Mocks = {
  createCommitStatus: ReturnType<typeof vi.fn>
}

const buildOctokit = (
  override?: () => Promise<unknown>
): { octokit: OctokitLike; mocks: Mocks } => {
  const createCommitStatus =
    override !== undefined ? vi.fn(override) : vi.fn().mockResolvedValue({})
  const octokit = {
    rest: {
      repos: {
        createCommitStatus
      }
    }
  } as unknown as OctokitLike
  return { octokit, mocks: { createCommitStatus } }
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

describe('writeCommitStatus', () => {
  it('POSTs a success commit status with the expected body shape', async () => {
    const { octokit, mocks } = buildOctokit()

    await writeCommitStatus(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'abc',
      state: 'success',
      context: 'automerge-gate/all-passed',
      description: '5 checks passed',
      target_url: 'https://example.com/run/42'
    })

    expect(mocks.createCommitStatus).toHaveBeenCalledTimes(1)
    expect(mocks.createCommitStatus).toHaveBeenCalledWith({
      owner: 'o',
      repo: 'r',
      sha: 'abc',
      state: 'success',
      context: 'automerge-gate/all-passed',
      description: '5 checks passed',
      target_url: 'https://example.com/run/42'
    } satisfies CreateCommitStatusParams)
  })

  it('POSTs a failure commit status with the expected body shape', async () => {
    const { octokit, mocks } = buildOctokit()

    await writeCommitStatus(octokit, {
      owner: 'o',
      repo: 'r',
      sha: 'abc',
      state: 'failure',
      context: 'automerge-gate/all-passed',
      description: '5 checks evaluated, at least one failed',
      target_url: 'https://example.com/run/42'
    })

    expect(mocks.createCommitStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'failure',
        context: 'automerge-gate/all-passed',
        description: '5 checks evaluated, at least one failed'
      })
    )
  })

  it('does not retry on 4xx errors', async () => {
    const { octokit, mocks } = buildOctokit(async () => {
      throw { status: 422 }
    })

    await expect(
      writeCommitStatus(
        octokit,
        {
          owner: 'o',
          repo: 'r',
          sha: 'abc',
          state: 'failure',
          context: 'ctx',
          description: 'd',
          target_url: 'u'
        },
        { retries: 3, baseDelayMs: 1 }
      )
    ).rejects.toEqual({ status: 422 })
    expect(mocks.createCommitStatus).toHaveBeenCalledTimes(1)
  })

  it('retries on 5xx errors', async () => {
    let attempt = 0
    const { octokit, mocks } = buildOctokit(async () => {
      attempt++
      if (attempt === 1) throw { status: 500 }
      return {}
    })

    await writeCommitStatus(
      octokit,
      {
        owner: 'o',
        repo: 'r',
        sha: 'abc',
        state: 'success',
        context: 'ctx',
        description: 'd',
        target_url: 'u'
      },
      { retries: 3, baseDelayMs: 1 }
    )
    expect(mocks.createCommitStatus).toHaveBeenCalledTimes(2)
  })
})
