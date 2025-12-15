import 'fake-indexeddb/auto'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { Buffer } from 'node:buffer'
import * as path from 'node:path'
import * as os from 'node:os'
import * as nodeFs from 'node:fs'
import * as git from 'isomorphic-git'
import { GitObjectStore, type IndexProgress, type PackRow } from '../git-store'

function installLocalStorageMock() {
  const store = new Map<string, string>()
  const localStorage = {
    getItem(key: string) {
      return store.has(key) ? store.get(key)! : null
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
    removeItem(key: string) {
      store.delete(key)
    },
    clear() {
      store.clear()
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null
    },
    get length() {
      return store.size
    },
  } satisfies Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'clear' | 'key' | 'length'>

  vi.stubGlobal('localStorage', localStorage as unknown as Storage)
  return () => store.clear()
}

async function createSamplePackBase64(): Promise<{ base64: string; commitOid: string }> {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'powersync-pack-'))
  const cleanup = () => {
    nodeFs.rmSync(dir, { recursive: true, force: true })
  }
  try {
    await git.init({ fs: nodeFs, dir })
    const filePath = path.join(dir, 'file.txt')
    await nodeFs.promises.writeFile(filePath, 'hello powersync\n', 'utf8')
    await git.add({ fs: nodeFs, dir, filepath: 'file.txt' })
    const author = {
      name: 'PowerSync',
      email: 'powersync@example.com',
      timestamp: Math.floor(Date.now() / 1000),
      timezoneOffset: 0,
    }
    await git.commit({
      fs: nodeFs,
      dir,
      message: 'Initial commit',
      author,
      committer: author,
    })
    const headOid = await git.resolveRef({ fs: nodeFs, dir, ref: 'HEAD' })
    const packResult = await git.packObjects({
      fs: nodeFs,
      dir,
      oids: [headOid],
    })
    const packfile =
      packResult instanceof Uint8Array ? packResult : (packResult as { packfile: Uint8Array }).packfile
    const base64 = Buffer.from(packfile).toString('base64')
    return { base64, commitOid: headOid }
  } finally {
    cleanup()
  }
}

const BASE_PACK: Omit<PackRow, 'id' | 'pack_oid' | 'created_at'> = {
  org_id: 'org-1',
  repo_id: 'repo-1',
  storage_key: 'org-1/repo-1/placeholder',
  size_bytes: 1,
  pack_bytes: 'Zg==', // "f" in base64
}

const createPack = (packOid: string, createdAt = new Date().toISOString()): PackRow => ({
  id: `pack-${packOid}`,
  pack_oid: packOid,
  created_at: createdAt,
  ...BASE_PACK,
  storage_key: `org-1/repo-1/${packOid}.pack`,
})

const cloneProgress = (progress: IndexProgress): IndexProgress => ({ ...progress })

let resetLocalStorage: (() => void) | null = null

beforeEach(() => {
  resetLocalStorage = installLocalStorageMock()
})

afterEach(() => {
  resetLocalStorage?.()
  resetLocalStorage = null
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GitObjectStore', () => {

  it('indexes packs emitted by isomorphic-git without LightningFS read errors', async () => {
    const { base64 } = await createSamplePackBase64()
    const store = new GitObjectStore()
    const size = Buffer.from(base64, 'base64').length
    const packRow: PackRow = {
      id: 'sample-pack',
      org_id: 'test-org',
      repo_id: 'test-repo',
      pack_oid: 'sample-pack',
      storage_key: 'test-org/test-repo/sample-pack.pack',
      size_bytes: size,
      pack_bytes: base64,
      created_at: new Date().toISOString(),
    }
    await expect(store.indexPacks([packRow])).resolves.not.toThrow()
    expect(store.getProgress().status).toBe('ready')
  })

  it('can re-index the same pack without throwing', async () => {
    const { base64 } = await createSamplePackBase64()
    const store = new GitObjectStore()
    const size = Buffer.from(base64, 'base64').length
    const packRow: PackRow = {
      id: 'sample-pack',
      org_id: 'test-org',
      repo_id: 'test-repo',
      pack_oid: 'repeat-pack',
      storage_key: 'test-org/test-repo/repeat-pack.pack',
      size_bytes: size,
      pack_bytes: base64,
      created_at: new Date().toISOString(),
    }
    await store.indexPacks([packRow])
    await expect(store.indexPacks([packRow])).resolves.not.toThrow()
    expect(store.getProgress().status).toBe('ready')
  })

  it('re-indexes packs after LightningFS persistence without cached bytes', async () => {
    const { base64 } = await createSamplePackBase64()
    const firstStore = new GitObjectStore()
    const size = Buffer.from(base64, 'base64').length
    const packRow: PackRow = {
      id: 'persisted-pack',
      org_id: 'test-org',
      repo_id: 'test-repo',
      pack_oid: 'persisted-pack',
      storage_key: 'test-org/test-repo/persisted-pack.pack',
      size_bytes: size,
      pack_bytes: base64,
      created_at: new Date().toISOString(),
    }
    await firstStore.indexPacks([packRow])
    ;(globalThis as unknown as { localStorage: Storage }).localStorage.removeItem('powersync-git-store/indexed-packs')
    const secondStore = new GitObjectStore()
    await expect(secondStore.indexPacks([packRow])).resolves.not.toThrow()
    expect(secondStore.getProgress().status).toBe('ready')
  })
})

describe('GitObjectStore indexing queue', () => {
  let store: GitObjectStore

  beforeEach(() => {
    store = new GitObjectStore()
  })

  it('processes queued packs sequentially and emits progress updates', async () => {
    const processMock = vi
      .spyOn(store as unknown as { processPack(pack: PackRow): Promise<void> }, 'processPack')
      .mockImplementation(async function mockProcess(this: GitObjectStore, pack: PackRow) {
        ;(this as unknown as { indexedPacks: Set<string> }).indexedPacks.add(pack.pack_oid)
      })
    const yieldMock = vi
      .spyOn(store as unknown as { yieldToBrowser(): Promise<void> }, 'yieldToBrowser')
      .mockResolvedValue(undefined)

    const updates: IndexProgress[] = []
    const unsubscribe = store.subscribe((progress) => {
      updates.push(cloneProgress(progress))
    })

    const packs = [createPack('a'), createPack('b'), createPack('c')]
    await store.indexPacks(packs)
    unsubscribe()

    expect(processMock).toHaveBeenCalledTimes(packs.length)
    expect(yieldMock).toHaveBeenCalledTimes(packs.length)
    expect(store.getProgress().status).toBe('ready')

    expect(updates[0]?.status).toBe('idle')
    const indexingUpdate = updates.find((entry) => entry.status === 'indexing')
    expect(indexingUpdate).toBeDefined()
    expect(indexingUpdate?.total).toBe(packs.length)
    expect(updates.at(-1)?.status).toBe('ready')
  })

  it('skips packs that are already indexed and only processes new oids', async () => {
    const processMock = vi
      .spyOn(store as unknown as { processPack(pack: PackRow): Promise<void> }, 'processPack')
      .mockImplementation(async function mockProcess(this: GitObjectStore, pack: PackRow) {
        ;(this as unknown as { indexedPacks: Set<string> }).indexedPacks.add(pack.pack_oid)
      })
    vi.spyOn(store as unknown as { packExists(oid: string): Promise<boolean> }, 'packExists').mockImplementation(
      async function mockPackExists(this: GitObjectStore, oid: string) {
        return (this as unknown as { indexedPacks: Set<string> }).indexedPacks.has(oid)
      },
    )
    vi.spyOn(store as unknown as { yieldToBrowser(): Promise<void> }, 'yieldToBrowser').mockResolvedValue(undefined)

    await store.indexPacks([createPack('alpha')])
    expect(processMock).toHaveBeenCalledTimes(1)

    processMock.mockClear()
    const updates: IndexProgress[] = []
    const unsubscribe = store.subscribe((progress) => {
      updates.push(cloneProgress(progress))
    })

    await store.indexPacks([createPack('alpha'), createPack('bravo')])
    unsubscribe()

    expect(processMock).toHaveBeenCalledTimes(1)
    expect(processMock).toHaveBeenCalledWith(expect.objectContaining({ pack_oid: 'bravo' }))
    const indexingTotals = updates
      .filter((entry) => entry.status === 'indexing')
      .map((entry) => entry.total)
    expect(indexingTotals).toContain(1)
    expect(store.getProgress().status).toBe('ready')
  })
})
