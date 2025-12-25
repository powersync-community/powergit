import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
import { syncPowerSyncRepository } from '../index.js'

const simpleGitMock = simpleGit as unknown as Mock
const PowerSyncRemoteClientMock = PowerSyncRemoteClient as unknown as Mock

const mockGetRepoSummary = vi.fn()

describe('syncPowerSyncRepository', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  const originalHome = process.env.POWERGIT_HOME
  let tempHome: string

  beforeEach(() => {
    simpleGitMock.mockReset()
    PowerSyncRemoteClientMock.mockReset()
    mockGetRepoSummary.mockReset()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    tempHome = mkdtempSync(join(tmpdir(), 'powergit-sync-test-'))
    process.env.POWERGIT_HOME = tempHome
    writeFileSync(
      join(tempHome, 'profiles.json'),
      JSON.stringify(
        {
          test: { powersync: { url: 'https://api.example.com' } },
        },
        null,
        2,
      ),
    )

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
    if (originalHome !== undefined) {
      process.env.POWERGIT_HOME = originalHome
    } else {
      delete process.env.POWERGIT_HOME
    }
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it('fetches summary via daemon and returns counts', async () => {
    const gitApi = {
      getRemotes: vi.fn(async () => [
        {
          name: 'powersync',
          refs: {
            fetch: 'powergit::test/acme/infra',
            push: 'powergit::test/acme/infra',
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
          refs: { fetch: 'powergit::test/team/runtime' },
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
