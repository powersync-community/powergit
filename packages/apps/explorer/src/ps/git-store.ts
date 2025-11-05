import LightningFS from '@isomorphic-git/lightning-fs'
import * as git from 'isomorphic-git'

export type PackRow = {
  id: string
  org_id: string
  repo_id: string
  pack_oid: string
  pack_bytes: string
  created_at: string | null
}

export type TreeEntry = {
  type: 'tree' | 'blob'
  path: string
  name: string
  oid: string
  mode: string
}

export type IndexProgress = {
  status: 'idle' | 'indexing' | 'ready' | 'error'
  processed: number
  total: number
  error: string | null
}

export class GitObjectStore {
  private fs = new LightningFS('powersync-git-store', { wipe: false }).promises
  private readonly gitdir = '/.git'
  private initialized = false

  private readonly packCache = new Map<string, Uint8Array>()
  private readonly indexedPacks = new Set<string>()
  private readonly queue: PackRow[] = []
  private readonly queuedPackOids = new Set<string>()

  private processingJob: Promise<void> | null = null
  private processedInBatch = 0

  private progress: IndexProgress = { status: 'idle', processed: 0, total: 0, error: null }
  private readonly listeners = new Set<(progress: IndexProgress) => void>()

  private readonly storageKey = 'powersync-git-store/indexed-packs'

  constructor() {
    this.restoreIndexedSet()
    const originalReadFile = this.fs.readFile.bind(this.fs)
    this.fs.readFile = (async (path: string, options?: unknown) => {
      const normalizedPath = typeof path === 'string' ? this.normalizeFsPath(path) : path
      if (typeof normalizedPath === 'string' && this.packCache.has(normalizedPath)) {
        return this.packCache.get(normalizedPath)!.slice()
      }
      const resolvedOptions =
        options == null || (typeof options === 'object' && (options as { encoding?: unknown }).encoding == null)
          ? { encoding: null }
          : (options as Parameters<typeof originalReadFile>[1])
      const result = await originalReadFile(path, resolvedOptions)
      if (result == null && typeof normalizedPath === 'string' && this.packCache.has(normalizedPath)) {
        return this.packCache.get(normalizedPath)!.slice()
      }
      return result
    }) as typeof this.fs.readFile
  }

  private normalizeFsPath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/')
  }

  private async ensureDirectory(path: string) {
    if (!path || path === '/') return
    const normalized = path.replace(/\/+/g, '/')
    const segments = normalized.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current += `/${segment}`
      try {
        await this.fs.mkdir(current)
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException
        const code = nodeError?.code
        if (code === 'EEXIST') {
          continue
        }
        if (code === 'ENOENT') {
          // parent missing; loop will create it on next iteration
          continue
        }
        if (typeof nodeError?.message === 'string' && nodeError.message.includes('EEXIST')) {
          continue
        }
        throw nodeError
      }
    }
  }

  private restoreIndexedSet() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(this.storageKey) : null
      if (!raw) return
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) {
        this.indexedPacks.clear()
        parsed.forEach((value) => {
          if (typeof value === 'string') this.indexedPacks.add(value)
        })
      }
    } catch {
      this.indexedPacks.clear()
    }
  }

  private persistIndexedSet() {
    try {
      if (typeof localStorage === 'undefined') return
      localStorage.setItem(this.storageKey, JSON.stringify(Array.from(this.indexedPacks)))
    } catch {
      // ignore persistence issues
    }
  }

  private async ensureInitialized() {
    if (this.initialized) return
    await this.ensureDirectory(this.gitdir)
    await this.ensureDirectory(`${this.gitdir}/objects`)
    await this.ensureDirectory(`${this.gitdir}/objects/pack`)
    this.initialized = true
  }

  async indexPacks(packs: PackRow[]): Promise<void> {
    await this.ensureInitialized()
    if (!packs.length) {
      if (this.processingJob) await this.processingJob
      return
    }

    const sorted = [...packs].sort((a, b) => {
      const aTime = a.created_at ? Date.parse(a.created_at) : 0
      const bTime = b.created_at ? Date.parse(b.created_at) : 0
      if (aTime === bTime) return a.pack_oid.localeCompare(b.pack_oid)
      return aTime - bTime
    })

    let appended = false
    for (const pack of sorted) {
      if (!pack.pack_bytes || pack.pack_bytes.length === 0) continue
      if (this.indexedPacks.has(pack.pack_oid)) continue
      if (this.queuedPackOids.has(pack.pack_oid)) continue
      this.queue.push(pack)
      this.queuedPackOids.add(pack.pack_oid)
      appended = true
    }

    if (!appended) {
      if (this.processingJob) await this.processingJob
      return
    }

    this.updateProgress({
      status: 'indexing',
      processed: this.processedInBatch,
      total: this.processedInBatch + this.queue.length,
      error: null,
    })

    if (!this.processingJob) {
      this.processingJob = this.drainQueue()
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          this.updateProgress({ status: 'error', error: message })
          throw error
        })
        .finally(() => {
          this.processingJob = null
          this.processedInBatch = 0
          if (this.queue.length === 0 && this.progress.status !== 'error') {
            this.updateProgress({ status: 'ready', processed: 0, total: 0, error: null })
          }
        })
    } else {
      this.updateProgress({
        processed: this.processedInBatch,
        total: this.processedInBatch + this.queue.length,
        error: null,
      })
    }

    if (this.processingJob) {
      await this.processingJob
    }
  }

  getProgress(): IndexProgress {
    return this.progress
  }

  subscribe(listener: (progress: IndexProgress) => void): () => void {
    this.listeners.add(listener)
    listener(this.progress)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private updateProgress(partial: Partial<IndexProgress>) {
    this.progress = { ...this.progress, ...partial }
    for (const listener of this.listeners) {
      listener(this.progress)
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length) {
      const pack = this.queue.shift()!
      this.queuedPackOids.delete(pack.pack_oid)
      await this.processPack(pack)
      this.processedInBatch += 1
      this.updateProgress({
        status: 'indexing',
        processed: this.processedInBatch,
        total: this.processedInBatch + this.queue.length,
        error: null,
      })
      await this.yieldToBrowser()
    }
  }

  private async processPack(pack: PackRow): Promise<void> {
    const packPath = `${this.gitdir}/objects/pack/pack-${pack.pack_oid}.pack`
    const normalizedPackPath = this.normalizeFsPath(packPath)
    const relativePath = packPath.replace(/^\/*\.git\//, '')
    const normalizedRelativePath = this.normalizeFsPath(relativePath)
    const cacheKeys = new Set<string>([
      normalizedPackPath,
      normalizedRelativePath,
      this.normalizeFsPath(`/${normalizedRelativePath}`),
    ])

    if (this.indexedPacks.has(pack.pack_oid)) {
      const exists = await this.fs
        .stat(packPath)
        .then(() => true)
        .catch(() => false)
      if (exists) return
      this.indexedPacks.delete(pack.pack_oid)
      this.persistIndexedSet()
    }

    const decoded = this.decodePack(pack.pack_bytes)
    const writeBytes = decoded instanceof Uint8Array ? new Uint8Array(decoded) : new Uint8Array(decoded)
    const writeCopy = writeBytes.slice()
    await this.fs
      .writeFile(packPath, writeCopy)
      .catch(async () => {
        await this.fs.unlink(packPath).catch(() => undefined)
        await this.fs.writeFile(packPath, writeCopy)
      })
    for (const key of cacheKeys) {
      this.packCache.set(key, writeCopy.slice())
    }
    await (git.indexPack as unknown as (args: Record<string, unknown>) => Promise<unknown>)({
      fs: this.fs,
      dir: '/',
      gitdir: this.gitdir,
      filepath: relativePath,
      packfile: writeCopy,
    })
    for (const key of cacheKeys) {
      this.packCache.delete(key)
    }
    this.indexedPacks.add(pack.pack_oid)
    this.persistIndexedSet()
  }

  private decodePack(base64: string): Uint8Array {
    const globalAny = globalThis as typeof globalThis & { Buffer?: typeof Buffer; atob?: (input: string) => string }
    if (globalAny?.Buffer) {
      const buf = globalAny.Buffer.from(base64, 'base64')
      return new Uint8Array(buf)
    }
    const decode =
      globalAny?.atob ??
      ((input: string) => {
        if (typeof Buffer !== 'undefined') {
          return Buffer.from(input, 'base64').toString('binary')
        }
        throw new Error('No base64 decoder available')
      })
    const binaryString = decode(base64)
    const bytes = new Uint8Array(binaryString.length)
    for (let i = 0; i < binaryString.length; i += 1) {
      bytes[i] = binaryString.charCodeAt(i)
    }
    return bytes
  }

  private async yieldToBrowser(): Promise<void> {
    if (typeof window !== 'undefined') {
      if (typeof window.requestIdleCallback === 'function') {
        await new Promise<void>((resolve) => window.requestIdleCallback(() => resolve()))
        return
      }
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
      return
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
  }

  async getCommitTree(commitOid: string): Promise<{ treeOid: string }> {
    await this.ensureInitialized()
    const { commit } = await git.readCommit({ fs: this.fs, gitdir: this.gitdir, oid: commitOid })
    return { treeOid: commit.tree }
  }

  async readTreeAtPath(commitOid: string, pathSegments: string[]): Promise<TreeEntry[]> {
    const segments = pathSegments.filter(Boolean)
    const { treeOid } = await this.getCommitTree(commitOid)
    if (segments.length === 0) {
      return this.readTree(treeOid)
    }

    let currentOid = treeOid
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]!
      const entries = await this.readTree(currentOid)
      const match = entries.find((entry) => entry.type === 'tree' && entry.name === segment)
      if (!match) {
        throw new Error(`Directory not found: ${segments.slice(0, i + 1).join('/')}`)
      }
      currentOid = match.oid
    }
    return this.readTree(currentOid)
  }

  async readTree(oid: string): Promise<TreeEntry[]> {
    await this.ensureInitialized()
    const { tree } = await git.readTree({ fs: this.fs, gitdir: this.gitdir, oid })
    return tree.map((entry) => ({
      type: entry.type as 'tree' | 'blob',
      path: entry.path,
      name: entry.path.split('/').pop() ?? entry.path,
      oid: entry.oid,
      mode: entry.mode,
    }))
  }

  async readFile(commitOid: string, filePath: string): Promise<{ content: Uint8Array; oid: string }> {
    const segments = filePath.split('/').filter(Boolean)
    if (segments.length === 0) throw new Error('Invalid file path')

    const { treeOid } = await this.getCommitTree(commitOid)
    let currentTreeOid = treeOid

    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]!
      const entries = await this.readTree(currentTreeOid)
      const entry = entries.find((item) => item.name === segment)
      if (!entry) {
        throw new Error(`Path segment not found: ${segment}`)
      }
      if (entry.type === 'tree') {
        currentTreeOid = entry.oid
        continue
      }
      if (i !== segments.length - 1) {
        throw new Error(`Encountered blob before end of path at ${segment}`)
      }
      const blob = await git.readBlob({ fs: this.fs, gitdir: this.gitdir, oid: entry.oid })
      return { content: blob.blob, oid: entry.oid }
    }

    throw new Error(`File not found: ${filePath}`)
  }
}

export const gitStore = new GitObjectStore()

declare global {
  interface Window {
    __powersyncGitStore?: GitObjectStore
  }
}

if (typeof window !== 'undefined') {
  window.__powersyncGitStore = gitStore
}
