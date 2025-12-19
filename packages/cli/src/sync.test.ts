import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'

vi.mock('simple-git', () => ({
  default: vi.fn(),
}))


vi.mock('@powersync-community/powergit-core', async () => {
  const actual = await vi.importActual<typeof import('@powersync-community/powergit-core')>('@powersync-community/powergit-core')
  const mockClient = vi.fn()
  return {
    ...actual,
    PowerSyncRemoteClient: mockClient,
  }
})

import simpleGit from 'simple-git'
import { PowerSyncRemoteClient } from '@powersync-community/powergit-core'
import { syncPowerSyncRepository } from './index.js'

const simpleGitMock = simpleGit as unknown as Mock
const PowerSyncRemoteClientMock = PowerSyncRemoteClient as unknown as Mock

const mockGetRepoSummary = vi.fn()

describe('syncPowerSyncRepository', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    simpleGitMock.mockReset()
    PowerSyncRemoteClientMock.mockReset()
    mockGetRepoSummary.mockReset()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    PowerSyncRemoteClientMock.mockImplementation(() => ({
      getRepoSummary: mockGetRepoSummary,
    }))

    global.fetch = vi
      .fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : `${input}`
        if (url.endsWith('/health')) {
          return { ok: true } as Response
        }
        if (url.endsWith('/auth/status')) {
          return {
            ok: true,
            json: async () => ({ status: 'ready' }),
          } as unknown as Response
        }
        return { ok: true } as Response
      }) as unknown as typeof fetch
  })

  afterEach(() => {
    warnSpy.mockRestore()
    delete (global as any).fetch
  })

  it('fetches summary via daemon and returns counts', async () => {
    const gitApi = {
      getRemotes: vi.fn(async () => [
        {
          name: 'powersync',
          refs: {
            fetch: 'powergit::https://api.example.com/orgs/acme/repos/infra',
            push: 'powergit::https://api.example.com/orgs/acme/repos/infra',
          },
        },
      ]),
    }
    simpleGitMock.mockReturnValue(gitApi)

    mockGetRepoSummary.mockResolvedValue({
      orgId: 'acme',
      repoId: 'infra',
      counts: { refs: 2, commits: 5, file_changes: 9, objects: 4 },
    })

    const result = await syncPowerSyncRepository('/tmp/repo')

    expect(PowerSyncRemoteClientMock).toHaveBeenCalledWith({
      endpoint: 'http://127.0.0.1:5030',
      fetchImpl: expect.any(Function),
      pathRouting: 'segments',
    })
    expect(mockGetRepoSummary).toHaveBeenCalledWith('acme', 'infra')
    expect(result).toEqual({
      org: 'acme',
      repo: 'infra',
      endpoint: 'https://api.example.com',
      counts: { refs: 2, commits: 5, file_changes: 9, objects: 4 },
      databasePath: null,
    })
  })

  it('uses custom remote name and daemon URL', async () => {
    const gitApi = {
      getRemotes: vi.fn(async () => [
        {
          name: 'powersync-upstream',
          refs: { fetch: 'powergit::https://svc.example.dev/orgs/team/repos/runtime' },
        },
      ]),
    }
    simpleGitMock.mockReturnValue(gitApi)

    mockGetRepoSummary.mockResolvedValue({
      orgId: 'team',
      repoId: 'runtime',
      counts: { refs: 1, commits: 0, file_changes: 0, objects: 0 },
    })

    const result = await syncPowerSyncRepository('/tmp/repo', {
      remoteName: 'powersync-upstream',
      daemonUrl: 'http://localhost:9999',
    })

    expect(result.org).toBe('team')
    expect(result.repo).toBe('runtime')
    expect(PowerSyncRemoteClientMock).toHaveBeenCalledWith({
      endpoint: 'http://localhost:9999',
      fetchImpl: expect.any(Function),
      pathRouting: 'segments',
    })
  })

  it('throws when the requested remote is missing', async () => {
    const gitApi = { getRemotes: vi.fn(async () => []) }
    simpleGitMock.mockReturnValue(gitApi)

    await expect(syncPowerSyncRepository('/tmp/repo')).rejects.toThrow(/Missing Git remote "powersync"/)
  })
})
