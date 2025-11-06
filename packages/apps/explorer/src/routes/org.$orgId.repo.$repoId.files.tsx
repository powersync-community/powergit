import * as React from 'react'
import { Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import { gitStore, type PackRow, type TreeEntry } from '@ps/git-store'
import type { Database } from '@ps/schema'

const MonacoEditor = React.lazy(() => import('@monaco-editor/react'))
const decoder = 'TextDecoder' in globalThis ? new TextDecoder('utf-8') : null

type FileRouteSearch = {
  branch?: string
}

export const Route = createFileRoute('/org/$orgId/repo/$repoId/files' as any)({
  component: Files,
  validateSearch: (search: Record<string, unknown>): FileRouteSearch => ({
    branch: typeof search.branch === 'string' && search.branch.length > 0 ? search.branch : undefined,
  }),
})

type BranchRow = {
  name: string | null
  target_sha: string | null
  updated_at: string | null
}

type ViewerState =
  | { status: 'idle' }
  | { status: 'indexing' }
  | { status: 'loading'; path: string }
  | {
      status: 'ready'
      path: string
      content: string
      oid: string
      size: number
      raw: Uint8Array
    }
  | { status: 'binary'; path: string; oid: string; size: number; raw?: Uint8Array }
  | { status: 'error'; path: string; message: string }

const MAX_INLINE_BYTES = 1_000_000

type FileChangeRow = Pick<Database['file_changes'], 'path' | 'additions' | 'deletions' | 'commit_sha'>

type FallbackEntry = {
  path: string
  commitSha: string | null
}

type FallbackNode =
  | { type: 'directory'; name: string; path: string; children: FallbackNode[] }
  | { type: 'file'; name: string; path: string; commitSha: string | null }

function buildFallbackEntries(rows: FileChangeRow[]): FallbackEntry[] {
  const map = new Map<string, string | null>()
  for (const row of rows) {
    const trimmed = row.path?.trim()
    if (!trimmed || map.has(trimmed)) continue
    map.set(trimmed, row.commit_sha ?? null)
  }
  return Array.from(map.entries()).map(([path, commitSha]) => ({ path, commitSha }))
}

function buildFallbackTree(entries: FallbackEntry[]): FallbackNode {
  const root: FallbackNode = { type: 'directory', name: '', path: '', children: [] }
  for (const entry of entries) {
    if (!entry.path) continue
    const segments = entry.path.split('/').filter(Boolean)
    if (segments.length === 0) continue
    let current = root
    segments.forEach((segment, index) => {
      if (current.type !== 'directory') return
      const currentPath = current.path ? `${current.path}/${segment}` : segment
      const isLeaf = index === segments.length - 1
      if (isLeaf) {
        if (!current.children.some((child) => child.type === 'file' && child.name === segment)) {
          current.children.push({ type: 'file', name: segment, path: currentPath, commitSha: entry.commitSha })
        }
        return
      }
      let next = current.children.find(
        (child): child is Extract<FallbackNode, { type: 'directory' }> =>
          child.type === 'directory' && child.name === segment,
      )
      if (!next) {
        next = { type: 'directory', name: segment, path: currentPath, children: [] }
        current.children.push(next)
      }
      current = next
    })
  }
  sortFallbackTree(root)
  return root
}

function sortFallbackTree(node: FallbackNode) {
  if (node.type !== 'directory') return
  node.children.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name)
    return a.type === 'directory' ? -1 : 1
  })
  node.children.forEach(sortFallbackTree)
}

function Files() {
  const { orgId, repoId } = Route.useParams()
  const navigate = Route.useNavigate()
  const { branch: branchParam } = Route.useSearch()
  useRepoStreams(orgId, repoId)
  const fixture = useRepoFixture(orgId, repoId)

  const { objects, refs, file_changes: fileChanges } = useCollections()

  const { data: packRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ o: objects })
        .where(({ o }) => eq(o.org_id, orgId))
        .where(({ o }) => eq(o.repo_id, repoId))
        .orderBy(({ o }) => o.created_at ?? '')
        .select(({ o }) => ({
          id: o.id,
          org_id: o.org_id,
          repo_id: o.repo_id,
          pack_oid: o.pack_oid,
          pack_bytes: o.pack_bytes,
          created_at: o.created_at,
        })),
    [objects, orgId, repoId],
  ) as { data: PackRow[] }

  const { data: branchRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ r: refs })
        .where(({ r }) => eq(r.org_id, orgId))
        .where(({ r }) => eq(r.repo_id, repoId))
        .select(({ r }) => ({
          name: r.name,
          target_sha: r.target_sha,
          updated_at: r.updated_at,
        })),
    [refs, orgId, repoId],
  ) as { data: BranchRow[] }

  const { data: liveFileRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ f: fileChanges })
        .where(({ f }) => eq(f.org_id, orgId))
        .where(({ f }) => eq(f.repo_id, repoId))
        .select(({ f }) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          commit_sha: f.commit_sha,
        })),
    [fileChanges, orgId, repoId],
  ) as { data: Array<FileChangeRow> }

  const branchOptions = React.useMemo(() => {
    if (fixture?.branches?.length) {
      return fixture.branches
        .filter((branch) => branch.name && branch.target_sha)
        .map((branch) => ({
          name: branch.name!,
          target_sha: branch.target_sha!,
          updated_at: branch.updated_at ?? null,
        }))
    }
    return branchRows
      .filter((row) => row.name && row.target_sha)
      .map((row) => ({ name: row.name!, target_sha: row.target_sha!, updated_at: row.updated_at }))
  }, [branchRows, fixture])

  const defaultBranch = React.useMemo(() => {
    if (branchOptions.length === 0) return null
    const head = branchOptions.find((opt) => opt.name === 'HEAD')
    if (head) return head
    const main = branchOptions.find((opt) => opt.name?.endsWith('/main'))
    if (main) return main
    return branchOptions[0] ?? null
  }, [branchOptions])

  const fallbackEntries = React.useMemo<FallbackEntry[]>(() => {
    const source = fixture?.fileChanges?.length ? fixture.fileChanges : liveFileRows
    const normalized: FileChangeRow[] = source.map((row) => ({
      path: row.path ?? '',
      additions: row.additions ?? 0,
      deletions: row.deletions ?? 0,
      commit_sha: row.commit_sha ?? null,
    }))
    return buildFallbackEntries(normalized)
  }, [fixture, liveFileRows])

  const fallbackTree = React.useMemo(() => buildFallbackTree(fallbackEntries), [fallbackEntries])
  const hasFallbackTree = fallbackTree.type === 'directory' && fallbackTree.children.length > 0

  const storageBase = React.useMemo(() => `powersync-file-explorer/${orgId}/${repoId}`, [orgId, repoId])
  const resolvePathKey = React.useCallback(
    (branchName: string | null | undefined) =>
      `${storageBase}/branches/${encodeURIComponent(branchName ?? '__no_branch__')}/path`,
    [storageBase],
  )

  const [pendingPath, setPendingPath] = React.useState<string | null>(null)

  const [selectedBranch, setSelectedBranch] = React.useState<{ name: string; target_sha: string } | null>(null)
  const [selectedCommit, setSelectedCommit] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!branchOptions.length) return
    const branchExists = branchParam ? branchOptions.some((opt) => opt.name === branchParam) : false
    const fallback = defaultBranch?.name
    if ((!branchExists || !branchParam) && fallback) {
      void navigate({
        to: '.',
        search: { branch: fallback } as any,
        replace: true,
      })
    }
  }, [branchParam, branchOptions, defaultBranch, navigate])

  React.useEffect(() => {
    if (!branchOptions.length) {
      if (selectedBranch !== null) setSelectedBranch(null)
      if (selectedCommit !== null) setSelectedCommit(null)
      return
    }
    const branchExists = branchParam ? branchOptions.some((opt) => opt.name === branchParam) : false
    const resolvedName = branchExists ? branchParam! : defaultBranch?.name ?? null
    if (!resolvedName) {
      if (selectedBranch !== null) setSelectedBranch(null)
      if (selectedCommit !== null) setSelectedCommit(null)
      return
    }
    const next = branchOptions.find((opt) => opt.name === resolvedName) ?? null
    if (next && (!selectedBranch || selectedBranch.name !== next.name)) {
      setSelectedBranch(next)
      setSelectedCommit(next.target_sha)
    }
  }, [branchParam, branchOptions, defaultBranch, selectedBranch, selectedCommit])

  const loadStoredPath = React.useCallback(
    (branchName: string | null | undefined) => {
      if (typeof window === 'undefined') return null
      try {
        return window.localStorage.getItem(resolvePathKey(branchName))
      } catch {
        return null
      }
    },
    [resolvePathKey],
  )

  const selectedBranchName = selectedBranch?.name ?? null

  React.useEffect(() => {
    setPendingPath(loadStoredPath(selectedBranchName))
  }, [loadStoredPath, selectedBranchName])

  const packKey = React.useMemo(() => packRows.map((row) => row.pack_oid).join('|'), [packRows])
  const [indexProgress, setIndexProgress] = React.useState(() => gitStore.getProgress())

  React.useEffect(() => gitStore.subscribe((progress) => setIndexProgress(progress)), [])

  React.useEffect(() => {
    if (!packRows.length) return
    void gitStore.indexPacks(packRows).catch((error) => {
      console.error('[gitStore] failed to index packs', error)
    })
  }, [packKey, packRows])

  const indexStatus = indexProgress.status
  const indexError = indexProgress.error
  const indexingLabel = React.useMemo(() => {
    if (indexProgress.status === 'error') {
      return 'Repository content failed to sync.'
    }
    if (indexProgress.total > 0) {
      const processed = Math.min(indexProgress.processed, indexProgress.total)
      return `Repository content is syncing (${processed}/${indexProgress.total})…`
    }
    return 'Repository content is syncing…'
  }, [indexProgress])

  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(new Set(['']))
  const [treeCache, setTreeCache] = React.useState<Map<string, TreeEntry[]>>(new Map())
  const [treeErrors, setTreeErrors] = React.useState<Map<string, string>>(new Map())
  const [loadingDirs, setLoadingDirs] = React.useState<Set<string>>(new Set())
  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  const [viewerState, setViewerState] = React.useState<ViewerState>({ status: 'idle' })

  const rootLoaded = treeCache.has('')
  const rootLoading = loadingDirs.has('')

  React.useEffect(() => {
    if (typeof window === 'undefined') return
    const key = resolvePathKey(selectedBranchName)
    if (selectedPath) {
      try {
        window.localStorage.setItem(key, selectedPath)
      } catch {
        // ignore storage errors
      }
    } else {
      try {
        window.localStorage.removeItem(key)
      } catch {
        // ignore storage errors
      }
    }
  }, [selectedPath, resolvePathKey, selectedBranchName])

  const resetTreeState = React.useCallback(() => {
    setExpandedDirs(new Set(['']))
    setTreeCache(new Map())
    setTreeErrors(new Map())
    setLoadingDirs(new Set())
    setSelectedPath(null)
    setViewerState({ status: 'idle' })
  }, [])

  const previousCommitRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    const previousCommit = previousCommitRef.current
    if (previousCommit !== selectedCommit) {
      resetTreeState()
      setPendingPath(loadStoredPath(selectedBranchName))
    }
    previousCommitRef.current = selectedCommit
  }, [selectedCommit, resetTreeState, loadStoredPath, selectedBranchName])

  const loadDirectory = React.useCallback(
    async (path: string, commitOverride?: string | null) => {
      if (indexStatus !== 'ready') return
      const commitOid = commitOverride ?? selectedCommit
      if (!commitOid) return
      if (treeCache.has(path) || loadingDirs.has(path)) return
      const segments = path.split('/').filter(Boolean)
      setLoadingDirs((prev) => {
        const next = new Set(prev)
        next.add(path)
        return next
      })
      setTreeErrors((prev) => {
        const next = new Map(prev)
        next.delete(path)
        return next
      })
      try {
        const entries = await gitStore.readTreeAtPath(commitOid, segments)
        setTreeCache((prev) => {
          const next = new Map(prev)
          next.set(path, entries)
          return next
        })
      } catch (error) {
        setTreeErrors((prev) => {
          const next = new Map(prev)
          next.set(path, error instanceof Error ? error.message : String(error))
          return next
        })
      } finally {
        setLoadingDirs((prev) => {
          const next = new Set(prev)
          next.delete(path)
          return next
        })
      }
    },
    [selectedCommit, treeCache, loadingDirs, indexStatus],
  )

  React.useEffect(() => {
    if (indexStatus !== 'ready' || !selectedCommit) return
    if (rootLoaded || rootLoading) return
    void loadDirectory('', selectedCommit)
  }, [indexStatus, selectedCommit, rootLoaded, rootLoading, loadDirectory])

  const handleToggleDirectory = React.useCallback(
    (path: string) => {
      setExpandedDirs((prev) => {
        const next = new Set(prev)
        if (next.has(path)) {
          next.delete(path)
        } else {
          next.add(path)
          void loadDirectory(path)
        }
        return next
      })
    },
    [loadDirectory],
  )

  const handleFileSelect = React.useCallback(
    async (fullPath: string) => {
      setSelectedPath(fullPath)
      setPendingPath(null)
      if (indexStatus === 'error') {
        setViewerState({
          status: 'error',
          path: fullPath,
          message: indexError ?? 'Repository packs failed to sync; refresh or retry later.',
        })
        return
      }
      if (indexStatus !== 'ready') {
        setViewerState({ status: 'indexing' })
        return
      }
      if (!selectedCommit) {
        setViewerState({
          status: 'error',
          path: fullPath,
          message: 'Select a branch with commits to preview this file.',
        })
        return
      }
      setSelectedPath(fullPath)
      setViewerState({ status: 'loading', path: fullPath })
      try {
        const { content, oid } = await gitStore.readFile(selectedCommit, fullPath)
        const size = content.length
        if (size > MAX_INLINE_BYTES) {
          setViewerState({ status: 'binary', path: fullPath, oid, size, raw: content })
          return
        }
        const text =
          decoder?.decode(content, { stream: false }) ??
          new TextDecoder('utf-8', { fatal: false }).decode(content)
        if (/\u0000/.test(text.slice(0, 800))) {
          setViewerState({ status: 'binary', path: fullPath, oid, size, raw: content })
          return
        }
        setViewerState({ status: 'ready', path: fullPath, content: text, oid, size, raw: content })
      } catch (error) {
        setViewerState({
          status: 'error',
          path: fullPath,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    },
    [selectedCommit, indexStatus, indexError],
  )

  React.useEffect(() => {
    if (indexStatus !== 'ready' || !selectedCommit || !pendingPath) return
    void handleFileSelect(pendingPath)
  }, [indexStatus, selectedCommit, pendingPath, handleFileSelect])

  const downloadCurrentBlob = React.useCallback(async () => {
    if (!selectedCommit) return
    if (viewerState.status !== 'ready' && viewerState.status !== 'binary') return
    let raw = viewerState.raw ?? null
    const path = viewerState.path
    if (!raw) {
      try {
        const { content } = await gitStore.readFile(selectedCommit, path)
        raw = content
      } catch (error) {
        setViewerState({
          status: 'error',
          path,
          message: error instanceof Error ? error.message : String(error),
        })
        return
      }
    }
    if (!raw || typeof document === 'undefined' || typeof URL === 'undefined') return
    const copy = new Uint8Array(raw.byteLength)
    copy.set(raw)
    const blob = new Blob([copy.buffer], { type: 'application/octet-stream' })
    const objectUrl = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = objectUrl
    anchor.download = path.split('/').pop() ?? 'download'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    URL.revokeObjectURL(objectUrl)
  }, [selectedCommit, viewerState, setViewerState])

  const renderTree = React.useCallback(
    (path: string, depth: number): React.ReactNode => {
      const entries = treeCache.get(path)
      const error = treeErrors.get(path)
      if (error) {
        return (
          <div className="text-xs text-red-400 px-2 py-1" key={`${path}-error`}>
            {error}
          </div>
        )
      }
      if (!entries) {
        if (loadingDirs.has(path)) {
          return (
            <div className="text-xs text-gray-400 px-2 py-1" key={`${path}-loading`}>
              Loading…
            </div>
          )
        }
        return null
      }

      const base = path ? `${path}/` : ''
      return entries.map((entry) => {
        const entryPath = `${base}${entry.name}`
        if (entry.type === 'tree') {
          const expanded = expandedDirs.has(entryPath)
          return (
            <div key={entryPath} className="select-none">
              <button
                type="button"
                className="flex items-center w-full text-left text-xs px-2 py-1 rounded-md text-gray-200 hover:bg-[#2a2d2e] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#007acc]/50"
                style={{ paddingLeft: depth * 12 }}
                onClick={() => handleToggleDirectory(entryPath)}
                data-testid="file-tree-directory"
              >
                <span className="mr-1 text-[10px] leading-none text-gray-400">{expanded ? '▾' : '▸'}</span>
                <span className="truncate">{entry.name}</span>
              </button>
              {expanded && <div className="space-y-0.5">{renderTree(entryPath, depth + 1)}</div>}
            </div>
          )
        }
        const selected = selectedPath === entryPath
        return (
          <div key={entryPath} className="select-none">
            <button
              type="button"
              className={`flex items-center w-full text-left text-sm px-2 py-1 rounded-md transition-colors ${
                selected ? 'bg-[#094771] text-white' : 'text-gray-200 hover:bg-[#2a2d2e]'
              } focus:outline-none focus-visible:ring-2 focus-visible:ring-[#007acc]/50`}
              style={{ paddingLeft: depth * 12 + 16 }}
              onClick={() => handleFileSelect(entryPath)}
              data-testid="file-tree-file"
            >
              <span className="mr-2 text-[11px] leading-none">📄</span>
              <span className="truncate">{entry.name}</span>
            </button>
          </div>
        )
      })
    },
    [expandedDirs, handleFileSelect, handleToggleDirectory, loadingDirs, selectedPath, treeCache, treeErrors],
  )

  const branchSelector = (
    <select
      value={selectedBranch?.name ?? ''}
      onChange={(event) => {
        const name = event.target.value
        const next = branchOptions.find((opt) => opt.name === name) ?? null
        setSelectedBranch(next)
        setSelectedCommit(next?.target_sha ?? null)
        setPendingPath(loadStoredPath(next?.name ?? null))
        void navigate({
          to: '.',
          search: { branch: next?.name ?? undefined } as any,
        })
      }}
      className="border border-gray-300 rounded px-2 py-1 text-sm"
      data-testid="branch-selector"
    >
      {branchOptions.length === 0 && <option value="">No branches</option>}
      {branchOptions.map((branch) => (
        <option key={branch.name ?? branch.target_sha} value={branch.name ?? ''}>
          {(branch.name ?? '(unknown)').replace(/^refs\/heads\//, '')}
        </option>
      ))}
    </select>
  )

  const viewerContent = (() => {
    if (indexStatus === 'indexing') {
      return (
        <div className="flex items-center justify-center h-full text-sm text-gray-500" data-testid="file-viewer-status">
          Repository content is syncing…
        </div>
      )
    }
    if (indexStatus === 'error') {
      return (
        <div className="flex flex-col items-center justify-center h-full text-center px-6 gap-2 text-sm text-red-600" data-testid="file-viewer-status">
          <p>Failed to index repository data.</p>
          {indexError ? <p className="text-xs text-red-400">{indexError}</p> : null}
        </div>
      )
    }
    if (!selectedCommit) {
      return (
        <div className="flex items-center justify-center h-full text-sm text-gray-500" data-testid="file-viewer-status">
          Select a branch to preview files.
        </div>
      )
    }
    switch (viewerState.status) {
      case 'idle':
        return (
          <div className="flex items-center justify-center h-full text-sm text-gray-500" data-testid="file-viewer-placeholder">
            Select a file to preview its contents.
          </div>
        )
      case 'indexing':
        return (
          <div className="flex items-center justify-center h-full text-sm text-gray-500" data-testid="file-viewer-status">
            {indexingLabel}
          </div>
        )
      case 'loading':
        return (
          <div className="flex items-center justify-center h-full text-sm text-gray-500" data-testid="file-viewer-status">
            Loading {viewerState.path}…
          </div>
        )
      case 'error':
        return (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3 text-sm text-red-600 px-6" data-testid="file-viewer-status">
            <div>
              <p className="font-medium">Unable to load {viewerState.path}.</p>
              <p className="text-xs text-red-400">{viewerState.message}</p>
            </div>
            <button
              type="button"
              onClick={() => handleFileSelect(viewerState.path)}
              className="inline-flex items-center gap-2 rounded-md bg-[#611818] px-3 py-1 text-xs font-medium text-white hover:bg-[#7a1f1f] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#611818]/50"
            >
              Retry
            </button>
          </div>
        )
      case 'binary':
        return (
          <div className="flex flex-col items-center justify-center h-full text-center px-6 gap-3 text-sm text-gray-600" data-testid="file-viewer-status">
            <div>
              <p className="font-medium text-gray-700">{viewerState.path}</p>
              <p className="mt-1 text-xs text-gray-500">
                Blob <code className="font-mono text-[11px]">{viewerState.oid}</code> • {formatBytes(viewerState.size)}
              </p>
            </div>
            <p className="text-xs text-gray-500">Binary preview isn&apos;t available. Download the blob to inspect it locally.</p>
            <button
              type="button"
              onClick={downloadCurrentBlob}
              className="inline-flex items-center gap-2 rounded-md bg-[#0e639c] px-3 py-1 text-xs font-medium text-white hover:bg-[#1177bb] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0e639c]/50"
            >
              Download blob
            </button>
          </div>
        )
      case 'ready':
        return (
          <div className="flex h-full flex-col">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs text-gray-600">
              <span>
                <span className="font-semibold text-gray-700">Blob</span>{' '}
                <code className="font-mono text-[11px]">{viewerState.oid}</code>
              </span>
              <span>
                <span className="font-semibold text-gray-700">Size</span> {formatBytes(viewerState.size)}
              </span>
              <button
                type="button"
                onClick={downloadCurrentBlob}
                className="inline-flex items-center gap-2 rounded-md bg-[#0e639c] px-3 py-1 text-xs font-medium text-white hover:bg-[#1177bb] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0e639c]/50"
              >
                Download file
              </button>
            </div>
            <div className="flex-1">
              <Suspense
                fallback={
                  <div className="flex items-center justify-center h-full text-sm text-gray-500">
                    Preparing editor…
                  </div>
                }
              >
                <MonacoEditor
                  path={viewerState.path}
                  defaultLanguage={inferLanguage(viewerState.path)}
                  theme="vs-dark"
                  value={viewerState.content}
                  options={{
                    readOnly: true,
                    minimap: { enabled: false },
                    fontSize: 13,
                    scrollBeyondLastLine: false,
                    wordWrap: 'on',
                  }}
                  height="100%"
                />
              </Suspense>
            </div>
          </div>
        )
      default:
        return null
    }
  })()

  return (
    <div className="space-y-4" data-testid="file-explorer-view">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div>
          <h3 className="font-semibold text-lg text-gray-900">Repository files ({orgId}/{repoId})</h3>
          <p className="text-sm text-gray-500">Browse files replicated via PowerSync. Switch branches to inspect other snapshots.</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-600">Branch</span>
          {branchSelector}
        </div>
      </div>

      <div className="flex flex-col lg:flex-row gap-4 min-h-[520px]">
        <div className="lg:w-72 w-full bg-[#1e1e1e] text-gray-200 rounded-lg border border-gray-700 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-700 text-xs uppercase tracking-[0.2em] text-gray-400">
            Explorer
          </div>
          <div className="p-2 text-sm space-y-0.5" data-testid="file-explorer-tree">
            {indexStatus !== 'ready' ? (
              hasFallbackTree ? (
                <div className="space-y-2">
                  <div className="text-xs text-gray-500 px-2 space-y-1">
                    <div>{indexingLabel}</div>
                    {indexProgress.status !== 'error' ? (
                      <div>Showing recently replicated paths until packs finish indexing.</div>
                    ) : indexError ? (
                      <div className="text-red-400">{indexError}</div>
                    ) : null}
                  </div>
                  <div className="space-y-0.5">
                    {renderFallbackTree(fallbackTree, 0, handleFileSelect, selectedPath)}
                  </div>
                </div>
              ) : (
                <div className="text-xs text-gray-500 px-2 py-4">{indexingLabel}</div>
              )
            ) : selectedCommit ? (
              renderTree('', 0)
            ) : (
              <div className="text-xs text-gray-500 px-2 py-4">No commits available.</div>
            )}
          </div>
        </div>

        <div className="flex-1 min-h-[420px] bg-white rounded-lg border border-gray-200 overflow-hidden flex flex-col" data-testid="file-viewer">
          <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700 truncate" data-testid="file-viewer-header">
            {selectedPath ?? 'Select a file to preview'}
          </div>
          <div className="flex-1">{viewerContent}</div>
        </div>
      </div>
    </div>
  )
}

export { Files as FilesComponent }

function inferLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript'
    case 'js':
    case 'jsx':
      return 'javascript'
    case 'json':
      return 'json'
    case 'md':
    case 'markdown':
      return 'markdown'
    case 'css':
      return 'css'
    case 'html':
    case 'htm':
      return 'html'
    case 'yml':
    case 'yaml':
      return 'yaml'
    default:
      return 'plaintext'
  }
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unitIndex = 0
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const precision = value >= 10 || unitIndex === 0 ? 0 : 1
  return `${value.toFixed(precision)} ${units[unitIndex]}`
}

function renderFallbackTree(node: FallbackNode, depth: number, onSelect: (path: string) => void, selectedPath: string | null): React.ReactNode {
  if (node.type !== 'directory') {
    const selected = selectedPath === node.path
    return (
      <div key={`fallback-${node.path}`} className="select-none">
        <button
          type="button"
          className={`flex items-center w-full text-left text-sm px-2 py-1 rounded-md transition-colors ${
            selected ? 'bg-[#094771] text-white' : 'text-gray-200 hover:bg-[#2a2d2e]'
          } focus:outline-none focus-visible:ring-2 focus-visible:ring-[#007acc]/50`}
          style={{ paddingLeft: depth * 12 + 16 }}
          onClick={() => onSelect(node.path)}
          data-testid="file-tree-file"
        >
          <span className="mr-2 text-[11px] leading-none">📄</span>
          <span className="truncate">{node.name}</span>
        </button>
      </div>
    )
  }

  if (depth === 0 && node.children.length === 0) {
    return <div className="text-xs text-gray-500 px-2 py-4">No files detected yet.</div>
  }

  return node.children.map((child) => {
    if (child.type === 'directory') {
      return (
        <div key={`fallback-${child.path}`} className="select-none">
          <div
            className="flex items-center w-full text-left text-xs px-2 py-1 text-gray-400"
            style={{ paddingLeft: depth * 12 }}
          >
            <span className="mr-1 text-[10px] leading-none text-gray-500">▸</span>
            <span className="truncate">{child.name}</span>
          </div>
          <div className="ml-3 space-y-0.5">{renderFallbackTree(child, depth + 1, onSelect, selectedPath)}</div>
        </div>
      )
    }
    return renderFallbackTree(child, depth, onSelect, selectedPath)
  })
}
