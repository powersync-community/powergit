import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Mock } from 'vitest'

vi.mock('simple-git', () => ({
  default: vi.fn(),
}))

import simpleGit from 'simple-git'
import type { PowerSyncBackendConnector, PowerSyncDatabase } from '@powersync/node'
import { syncPowerSyncRepository } from './index.js'

const simpleGitMock = simpleGit as unknown as Mock

class FakeSubscription {
  public waitForFirstSync = vi.fn(async () => {})
  public unsubscribe = vi.fn()
  constructor(public readonly id: string) {}
}

class FakeSyncStream {
  public readonly subscribe: ReturnType<typeof vi.fn>

  constructor(subscription: FakeSubscription) {
    this.subscribe = vi.fn(async () => subscription)
  }
}

class FakeDatabase {
  public readonly connect = vi.fn(async () => {})
  public readonly waitForReady = vi.fn(async () => {})
  public readonly close = vi.fn(async () => {})
  public readonly syncStream: (id: string) => FakeSyncStream
  public readonly getAll = vi.fn(async (sql: string) => {
    const match = /from\s+(\w+)/i.exec(sql)
    const table = match?.[1] ?? ''
    const count = this.counts[table as keyof typeof this.counts] ?? 0
    return [{ count }]
  })
  public readonly subscriptions: FakeSubscription[] = []

  constructor(private readonly counts: Record<string, number>) {
    this.syncStream = vi.fn((id: string) => {
      const subscription = new FakeSubscription(id)
      this.subscriptions.push(subscription)
      return new FakeSyncStream(subscription)
    })
  }
}

describe('syncPowerSyncRepository', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    simpleGitMock.mockReset()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('connects to PowerSync and returns row counts', async () => {
    const gitApi = {
      getRemotes: vi.fn(async () => [
        {
          name: 'origin',
          refs: {
            fetch: 'powersync::https://api.example.com/orgs/acme/repos/infra',
            push: 'powersync::https://api.example.com/orgs/acme/repos/infra',
          },
        },
      ]),
    }
    simpleGitMock.mockReturnValue(gitApi)

    const fakeDb = new FakeDatabase({ refs: 2, commits: 5, file_changes: 9, objects: 4 })
    const databaseFactory = vi.fn(async () => fakeDb as unknown as PowerSyncDatabase)
    const connector: PowerSyncBackendConnector = {
      fetchCredentials: vi.fn(async () => ({ endpoint: 'https://api.example.com', token: 'token' })),
      uploadData: vi.fn(async () => {}),
    }
    const connectorFactory = vi.fn(() => connector)

    const result = await syncPowerSyncRepository('/tmp/repo', {
      databaseFactory,
      connectorFactory,
    })

    expect(databaseFactory).toHaveBeenCalled()
    expect(fakeDb.connect).toHaveBeenCalledWith(connector, { includeDefaultStreams: false })
    expect(fakeDb.waitForReady).toHaveBeenCalled()
    expect(fakeDb.syncStream).toHaveBeenCalledTimes(4)
    expect(result).toEqual({
      org: 'acme',
      repo: 'infra',
      endpoint: 'https://api.example.com',
      databasePath: expect.any(String),
      counts: { refs: 2, commits: 5, file_changes: 9, objects: 4 },
    })
    expect(fakeDb.close).toHaveBeenCalled()
    fakeDb.subscriptions.forEach((subscription) => {
      expect(subscription.waitForFirstSync).toHaveBeenCalled()
      expect(subscription.unsubscribe).toHaveBeenCalled()
    })
  })

  it('allows overriding remote name and database path', async () => {
    const gitApi = {
      getRemotes: vi.fn(async () => [
        {
          name: 'powersync-upstream',
          refs: { fetch: 'powersync::https://svc.example.dev/orgs/team/repos/runtime' },
        },
      ]),
    }
    simpleGitMock.mockReturnValue(gitApi)

    const fakeDb = new FakeDatabase({ refs: 0, commits: 0, file_changes: 0, objects: 0 })
    const databaseFactory = vi.fn(async (options: { dbPath?: string }) => {
      expect(options.dbPath).toBe('/custom/path.db')
      return fakeDb as unknown as PowerSyncDatabase
    })

    const connector: PowerSyncBackendConnector = {
      fetchCredentials: vi.fn(async () => ({ endpoint: 'https://svc.example.dev', token: 'token' })),
      uploadData: vi.fn(async () => {}),
    }

    const result = await syncPowerSyncRepository('/tmp/repo', {
      remoteName: 'powersync-upstream',
      dbPath: '/custom/path.db',
      databaseFactory,
      connectorFactory: () => connector,
    })

    expect(result.org).toBe('team')
    expect(result.repo).toBe('runtime')
    expect(result.databasePath).toBe('/custom/path.db')
    expect(fakeDb.close).toHaveBeenCalled()
  })

  it('throws when the requested remote is missing', async () => {
    const gitApi = {
      getRemotes: vi.fn(async () => []),
    }
    simpleGitMock.mockReturnValue(gitApi)

    await expect(
      syncPowerSyncRepository('/tmp/repo', {
        remoteName: 'missing',
        databaseFactory: vi.fn(),
        connectorFactory: vi.fn(),
      }),
    ).rejects.toThrow(/Missing Git remote "missing"/)
  })
})
