import * as React from 'react'
import { Suspense } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import {
  IoGitBranchOutline,
  IoChevronForwardOutline,
  IoChevronDownOutline,
  IoChevronBackOutline,
  IoDocumentTextOutline,
} from 'react-icons/io5'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import { gitStore, type PackRow, type TreeEntry } from '@ps/git-store'
import type { Database } from '@ps/schema'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeHighlight from 'rehype-highlight'
import rehypeSanitize, { defaultSchema, type Options as RehypeSanitizeOptions } from 'rehype-sanitize'
import { useTheme } from '../ui/theme-context'

const MonacoEditor = React.lazy(() => import('@monaco-editor/react'))
const decoder = 'TextDecoder' in globalThis ? new TextDecoder('utf-8') : null
const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd'])
const DESKTOP_TREE_MIN_WIDTH = 240
const DESKTOP_TREE_MAX_WIDTH = 640
const DESKTOP_TREE_DEFAULT_WIDTH = 360

const clampTreeWidth = (width: number) => Math.min(DESKTOP_TREE_MAX_WIDTH, Math.max(DESKTOP_TREE_MIN_WIDTH, width))

const markdownSanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  tagNames: Array.from(
    new Set([...(defaultSchema.tagNames ?? []), 'picture', 'source']),
  ),
  attributes: {
    ...defaultSchema.attributes,
    p: [
      ...(defaultSchema.attributes?.p ?? []),
      ['align', /^(left|right|center|justify)$/],
    ],
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      ['target', /^(_blank|_self|_parent|_top)$/],
      ['rel', 'string'],
    ],
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      ['loading', /^(lazy|eager|auto)$/],
      ['decoding', /^(sync|async|auto)$/],
      ['referrerpolicy', 'string'],
    ],
    picture: [
      ...(defaultSchema.attributes?.picture ?? []),
      ['className', 'string'],
    ],
    source: [
      ...(defaultSchema.attributes?.source ?? []),
      ['srcSet', 'string'],
      ['srcset', 'string'],
      ['media', 'string'],
      ['type', 'string'],
    ],
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ['className', 'string'],
      ['dataLanguage', 'string'],
    ],
    pre: [
      ...(defaultSchema.attributes?.pre ?? []),
      ['className', 'string'],
    ],
    span: [
      ...(defaultSchema.attributes?.span ?? []),
      ['className', 'string'],
    ],
    div: [
      ...(defaultSchema.attributes?.div ?? []),
      ['className', 'string'],
    ],
  },
}

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

type IndexStatus = ReturnType<typeof gitStore.getProgress>['status']

type FileTreePaneProps = {
  className: string
  headerClass: string
  bodyClass: string
  fallbackInfoClass: string
  fallbackNoticeClass: string
  treeEmptyClass: string
  indexStatus: IndexStatus
  hasFallbackTree: boolean
  fallbackTree: FallbackNode
  indexingLabel: string
  indexError?: string | null
  selectedCommit: string | null
  renderTree: (path: string, depth: number) => React.ReactNode
  handleFileSelect: (path: string) => void
  selectedPath: string | null
  isDark: boolean
  headerAction?: React.ReactNode
}

type FileViewerPaneProps = React.PropsWithChildren<{
  className: string
  headerClass: string
  selectedPath: string | null
  headerAction?: React.ReactNode
}>

type ExplorerViewProps = {
  treeProps: FileTreePaneProps
  viewerProps: FileViewerPaneProps
  isDark: boolean
}

function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type === b.type) {
      return a.name.localeCompare(b.name)
    }
    return a.type === 'tree' ? -1 : 1
  })
}

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
  const { theme } = useTheme()
  const isDesktop = useMediaQuery('(min-width: 1024px)')
  const isDark = theme === 'dark'
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
  const headCommitLabel = React.useMemo(() => (selectedCommit ? selectedCommit.slice(0, 12) : null), [selectedCommit])

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
      const percent = Math.min(100, Math.round((processed / indexProgress.total) * 100))
      return `Repository content is syncing (${processed}/${indexProgress.total}, ${percent}%)…`
    }
    if (indexProgress.processed > 0 && indexProgress.total === 0) {
      return `Repository content is syncing (${indexProgress.processed})…`
    }
    return 'Repository content is syncing…'
  }, [indexProgress])

  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(new Set())
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
    setExpandedDirs(new Set())
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
        const sortedEntries = sortTreeEntries(entries)
        setTreeCache((prev) => {
          const next = new Map(prev)
          next.set(path, sortedEntries)
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
          <div className={`px-2 py-1 text-xs ${isDark ? 'text-red-300' : 'text-red-500'}`} key={`${path}-error`}>
            {error}
          </div>
        )
      }
      if (!entries) {
        if (loadingDirs.has(path)) {
          return (
            <div className={`px-2 py-1 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`} key={`${path}-loading`}>
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
          const dirButtonClass = isDark
            ? 'flex w-full items-center rounded-md px-2 py-1 text-left text-xs text-slate-300 transition hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
            : 'flex w-full items-center rounded-md px-2 py-1 text-left text-xs text-slate-600 transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
          const dirIconClass = isDark ? 'text-[12px] text-slate-400' : 'text-[12px] text-slate-400'
          const dirTextClass = isDark ? 'truncate font-medium text-slate-100' : 'truncate font-medium text-slate-700'
          return (
            <div key={entryPath} className="select-none">
              <button
                type="button"
                className={dirButtonClass}
                style={{ paddingLeft: depth * 12 }}
                onClick={() => handleToggleDirectory(entryPath)}
                data-testid="file-tree-directory"
              >
                <span className="mr-2 flex shrink-0 items-center" aria-hidden>
                  {expanded ? <IoChevronDownOutline className={dirIconClass} /> : <IoChevronForwardOutline className={dirIconClass} />}
                </span>
                <span className={dirTextClass}>{entry.name}</span>
              </button>
              {expanded && <div className="space-y-0.5">{renderTree(entryPath, depth + 1)}</div>}
            </div>
          )
        }
        const selected = selectedPath === entryPath
        const fileButtonBase =
          'flex w-full items-center rounded-md px-2 py-1 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
        const fileButtonState = selected
          ? isDark
            ? 'bg-emerald-500/20 text-emerald-200'
            : 'bg-emerald-100 text-emerald-700'
          : isDark
            ? 'text-slate-200 hover:bg-slate-800'
            : 'text-slate-700 hover:bg-slate-100'
        const fileIconClass = isDark ? 'text-[13px] text-slate-400' : 'text-[13px] text-slate-500'
        const fileNameClass = selected
          ? isDark
            ? 'truncate text-emerald-100'
            : 'truncate text-emerald-800'
          : 'truncate'
        return (
          <div key={entryPath} className="select-none">
            <button
              type="button"
              className={`${fileButtonBase} ${fileButtonState}`}
              style={{ paddingLeft: depth * 12 }}
              onClick={() => handleFileSelect(entryPath)}
              data-testid="file-tree-file"
            >
              <span className="mr-2 flex shrink-0 items-center" aria-hidden>
                <IoDocumentTextOutline className={fileIconClass} />
              </span>
              <span className={fileNameClass}>{entry.name}</span>
            </button>
          </div>
        )
      })
    },
    [
      expandedDirs,
      handleFileSelect,
      handleToggleDirectory,
      isDark,
      loadingDirs,
      selectedPath,
      treeCache,
      treeErrors,
    ],
  )

  const branchSelectorClass = isDark
    ? 'rounded-md border border-slate-600 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 shadow-inner transition focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 shadow-inner transition focus:border-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'

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
      className={branchSelectorClass}
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

  const neutralStatusClass = isDark ? 'text-sm text-slate-400' : 'text-sm text-slate-600'
  const neutralStatusCenterClass = `flex items-center justify-center h-full ${neutralStatusClass}`
  const neutralStatusStackClass = `flex flex-col items-center justify-center h-full text-center gap-3 ${neutralStatusClass}`
  const errorStatusClass = isDark ? 'text-sm text-red-400' : 'text-sm text-red-600'
  const errorDetailClass = isDark ? 'text-xs text-red-300' : 'text-xs text-red-500'
  const binaryMetaLabel = isDark ? 'font-medium text-slate-100' : 'font-medium text-slate-700'
  const binaryMetaSubtle = isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'
  const binaryHelpText = isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'
  const primaryActionClass = isDark
    ? 'inline-flex items-center gap-2 rounded-md bg-emerald-400 px-3 py-1 text-xs font-semibold text-emerald-950 shadow-lg shadow-emerald-500/30 transition hover:bg-emerald-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
    : 'inline-flex items-center gap-2 rounded-md bg-emerald-500 px-3 py-1 text-xs font-semibold text-white shadow hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
  const secondaryActionClass = isDark
    ? 'inline-flex items-center gap-2 rounded-md bg-slate-800 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'inline-flex items-center gap-2 rounded-md bg-slate-100 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
  const retryButtonClass = isDark
    ? 'inline-flex items-center gap-2 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white hover:bg-red-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50'
    : 'inline-flex items-center gap-2 rounded-md bg-red-500 px-3 py-1 text-xs font-medium text-white hover:bg-red-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300'
  const blobHeaderClass = isDark
    ? 'flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-700 bg-slate-900/70 px-4 py-2 text-xs text-slate-300'
    : 'flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 bg-slate-50 px-4 py-2 text-xs text-slate-600'
  const markdownProseClass = isDark
    ? 'markdown-prose markdown-prose-dark prose prose-invert max-w-none px-6 py-4'
    : 'markdown-prose markdown-prose-light prose max-w-none px-6 py-4'

  const viewerContent = (() => {
    if (indexStatus === 'indexing') {
      return (
        <div className={neutralStatusCenterClass} data-testid="file-viewer-status">
          Repository content is syncing…
        </div>
      )
    }
    if (indexStatus === 'error') {
      return (
        <div className={`flex flex-col items-center justify-center h-full gap-2 px-6 text-center ${errorStatusClass}`} data-testid="file-viewer-status">
          <p>Failed to index repository data.</p>
          {indexError ? <p className={errorDetailClass}>{indexError}</p> : null}
        </div>
      )
    }
    if (!selectedCommit) {
      return (
        <div className={neutralStatusCenterClass} data-testid="file-viewer-status">
          Select a branch to preview files.
        </div>
      )
    }
    switch (viewerState.status) {
      case 'idle':
        return (
          <div className={neutralStatusCenterClass} data-testid="file-viewer-placeholder">
            Select a file to preview its contents.
          </div>
        )
      case 'indexing':
        return (
          <div className={neutralStatusCenterClass} data-testid="file-viewer-status">
            {indexingLabel}
          </div>
        )
      case 'loading':
        return (
          <div className={neutralStatusCenterClass} data-testid="file-viewer-status">
            Loading {viewerState.path}…
          </div>
        )
      case 'error':
        return (
          <div
            className={`flex flex-col items-center justify-center h-full gap-3 px-6 text-center ${errorStatusClass}`}
            data-testid="file-viewer-status"
          >
            <div>
              <p className={isDark ? 'font-medium text-red-200' : 'font-medium text-red-700'}>
                Unable to load {viewerState.path}.
              </p>
              <p className={errorDetailClass}>{viewerState.message}</p>
            </div>
            <button
              type="button"
              onClick={() => handleFileSelect(viewerState.path)}
              className={retryButtonClass}
            >
              Retry
            </button>
          </div>
        )
      case 'binary':
        return (
          <div
            className={`${neutralStatusStackClass} px-6`}
            data-testid="file-viewer-status"
          >
            <div className="space-y-1">
              <p className={binaryMetaLabel}>{viewerState.path}</p>
              <p className={binaryMetaSubtle}>
                Blob <code className="font-mono text-[11px]">{viewerState.oid}</code> • {formatBytes(viewerState.size)}
              </p>
            </div>
            <p className={binaryHelpText}>
              Binary preview isn&apos;t available. Download the blob to inspect it locally.
            </p>
            <button
              type="button"
              onClick={downloadCurrentBlob}
              className={primaryActionClass}
            >
              Download blob
            </button>
          </div>
        )
      case 'ready': {
        const extension = viewerState.path.split('.').pop()?.toLowerCase()
        const isMarkdownFile = Boolean(extension && MARKDOWN_EXTENSIONS.has(extension))
        return (
          <div className="flex h-full flex-col">
            <div className={blobHeaderClass}>
              <span>
                <span className={isDark ? 'font-semibold text-slate-100' : 'font-semibold text-slate-700'}>Blob</span>{' '}
                <code className="font-mono text-[11px]">{viewerState.oid}</code>
              </span>
              <span>
                <span className={isDark ? 'font-semibold text-slate-100' : 'font-semibold text-slate-700'}>Size</span>{' '}
                {formatBytes(viewerState.size)}
              </span>
              <button
                type="button"
                onClick={downloadCurrentBlob}
                className={primaryActionClass}
              >
                Download file
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              {isMarkdownFile ? (
                <div className={markdownProseClass}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    rehypePlugins={[
                      rehypeRaw,
                      rehypeHighlight,
                      [rehypeSanitize, markdownSanitizeSchema],
                    ]}
                  >
                    {viewerState.content}
                  </ReactMarkdown>
                </div>
              ) : (
                <Suspense
                  fallback={
                    <div className={neutralStatusCenterClass}>
                      Preparing editor…
                    </div>
                  }
                >
                  <MonacoEditor
                    path={viewerState.path}
                    defaultLanguage={inferLanguage(viewerState.path)}
                    theme={isDark ? 'vs-dark' : 'vs-light'}
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
              )}
            </div>
          </div>
        )
      }
      default:
        return null
    }
  })()

  const branchIconClass = isDark ? 'text-slate-200 text-base' : 'text-slate-500 text-base'
  const commitButtonClass = isDark
    ? 'inline-flex items-center gap-2 rounded-full border border-emerald-400/60 px-4 py-1.5 text-xs font-medium text-emerald-200 transition hover:bg-emerald-500/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/60'
    : 'inline-flex items-center gap-2 rounded-full border border-emerald-500/30 px-4 py-1.5 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'

  const toolbarClass = isDark
    ? 'rounded-3xl border border-slate-700 bg-slate-900 px-6 py-5 text-slate-100 shadow-xl shadow-slate-900/40'
    : 'rounded-3xl border border-slate-200 bg-white px-6 py-5 text-slate-900 shadow-lg'
  const repoHeadingClass = isDark ? 'text-xl font-semibold tracking-tight text-white' : 'text-xl font-semibold tracking-tight text-slate-900'
  const repoSlashClass = isDark ? 'text-slate-500' : 'text-slate-400'
  const branchLabelClass = isDark ? 'text-xs uppercase tracking-wide text-slate-400' : 'text-xs uppercase tracking-wide text-slate-500'
  const treePanelClass = isDark
    ? 'rounded-2xl border border-slate-700 bg-slate-900/70 text-slate-200 shadow-lg shadow-slate-900/40'
    : 'rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm'
  const treeHeaderClass = isDark
    ? 'border-b border-slate-700/70 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400'
    : 'border-b border-slate-200 px-4 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-slate-400'
  const treeBodyClass = isDark ? 'space-y-0.5 p-3 text-sm text-slate-200' : 'space-y-0.5 p-3 text-sm text-slate-700'
  const fallbackInfoClass = isDark
    ? 'space-y-1 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200'
    : 'space-y-1 rounded-lg border border-emerald-100 bg-emerald-50 px-3 py-2 text-xs text-emerald-700'
  const fallbackNoticeClass = isDark
    ? 'rounded-lg border border-slate-700 px-3 py-4 text-xs text-slate-300'
    : 'rounded-lg border border-slate-200 px-3 py-4 text-xs text-slate-500'
  const treeEmptyClass = fallbackNoticeClass
  const viewerContainerClass = isDark
    ? 'flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-slate-900/70 text-slate-200 shadow-lg shadow-slate-900/40'
    : 'flex min-h-[420px] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-700 shadow-sm'
  const viewerHeaderClass = isDark
    ? 'border-b border-slate-700 bg-slate-900/60 px-4 py-2 text-sm font-medium text-slate-100 flex items-center justify-between gap-2'
    : 'border-b border-slate-200 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700 flex items-center justify-between gap-2'

  const treePaneProps: FileTreePaneProps = {
    className: treePanelClass,
    headerClass: treeHeaderClass,
    bodyClass: treeBodyClass,
    fallbackInfoClass,
    fallbackNoticeClass,
    treeEmptyClass,
    indexStatus,
    hasFallbackTree,
    fallbackTree,
    indexingLabel,
    indexError,
    selectedCommit,
    renderTree,
    handleFileSelect,
    selectedPath,
    isDark,
  }

  const viewerPaneProps: FileViewerPaneProps = {
    className: viewerContainerClass,
    headerClass: viewerHeaderClass,
    selectedPath,
    children: viewerContent,
  }

  return (
    <div className="space-y-6" data-testid="file-explorer-view">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className={repoHeadingClass}>
          {orgId}
          <span className={repoSlashClass}>/</span>
          {repoId}
        </div>
        <div className={toolbarClass} data-testid="repo-toolbar">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-wrap items-center gap-2 w-full">
              <div className="flex items-center gap-1.5">
                <IoGitBranchOutline className={branchIconClass} aria-hidden />
                {branchSelector}
              </div>
              <div className="ml-auto">
                {headCommitLabel ? (
                  <Link
                    to="/org/$orgId/repo/$repoId/commits"
                    params={{ orgId, repoId }}
                    search={{ branch: selectedBranch?.name ?? undefined }}
                    className={commitButtonClass}
                    data-testid="view-commits-button"
                  >
                    View commits · {headCommitLabel}
                  </Link>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>

      {isDesktop ? (
        <DesktopView treeProps={treePaneProps} viewerProps={viewerPaneProps} isDark={isDark} />
      ) : (
        <MobileView treeProps={treePaneProps} viewerProps={viewerPaneProps} isDark={isDark} />
      )}
    </div>
  )
}

const FileTreePane = React.forwardRef<HTMLDivElement, FileTreePaneProps>(function FileTreePane(
  {
    className,
    headerClass,
    bodyClass,
    fallbackInfoClass,
    fallbackNoticeClass,
    treeEmptyClass,
    indexStatus,
    hasFallbackTree,
    fallbackTree,
    indexingLabel,
    indexError,
    selectedCommit,
    renderTree,
    handleFileSelect,
    selectedPath,
    isDark,
    headerAction,
  },
  ref,
) {
  return (
    <div ref={ref} className={className}>
      <div className={`${headerClass} flex items-center justify-between gap-2`}>
        <span>Files</span>
        {headerAction ?? null}
      </div>
      <div className={bodyClass} data-testid="file-explorer-tree">
        {indexStatus !== 'ready' ? (
          hasFallbackTree ? (
            <div className="space-y-2">
              <div className={fallbackInfoClass}>
                <div>{indexingLabel}</div>
                {indexStatus !== 'error' ? (
                  <div className={isDark ? 'text-emerald-200/80' : undefined}>
                    Showing recently replicated paths while pack indexing completes.
                  </div>
                ) : indexError ? (
                  <div className={isDark ? 'text-red-300' : 'text-red-500'}>{indexError}</div>
                ) : null}
              </div>
              <div className="space-y-0.5">
                {renderFallbackTree(fallbackTree, 0, handleFileSelect, selectedPath, isDark)}
              </div>
            </div>
          ) : (
            <div className={fallbackNoticeClass}>{indexingLabel}</div>
          )
        ) : selectedCommit ? (
          renderTree('', 0)
        ) : (
          <div className={treeEmptyClass}>No commits available.</div>
        )}
      </div>
    </div>
  )
})

const FileViewerPane = React.forwardRef<HTMLDivElement, FileViewerPaneProps>(function FileViewerPane(
  { className, headerClass, selectedPath, headerAction, children },
  ref,
) {
  return (
    <div ref={ref} className={className} data-testid="file-viewer">
      <div className={headerClass} data-testid="file-viewer-header">
        <span>{selectedPath ?? 'Select a file to preview'}</span>
        {headerAction ?? null}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  )
})

function DesktopView({ treeProps, viewerProps, isDark }: ExplorerViewProps) {
  const [treeWidth, setTreeWidth] = React.useState(DESKTOP_TREE_DEFAULT_WIDTH)
  const desktopViewerProps = {
    ...viewerProps,
    className: `${viewerProps.className} flex-1 min-w-0`,
  }
  const startXRef = React.useRef(0)
  const startWidthRef = React.useRef(DESKTOP_TREE_DEFAULT_WIDTH)
  const resizingRef = React.useRef(false)
  const separatorButtonClass = isDark
    ? 'bg-slate-900/60 border-slate-700 hover:bg-slate-900/80 focus-visible:ring-emerald-300/50'
    : 'bg-white border-slate-200 hover:bg-slate-50 focus-visible:ring-emerald-300/50'
  const separatorIndicatorClass = isDark
    ? 'bg-slate-600 group-hover:bg-emerald-300'
    : 'bg-slate-300 group-hover:bg-emerald-500'

  const handlePointerMove = React.useCallback((event: PointerEvent) => {
    if (!resizingRef.current) return
    const delta = event.clientX - startXRef.current
    setTreeWidth(clampTreeWidth(startWidthRef.current + delta))
  }, [])

  const handlePointerUp = React.useCallback(() => {
    if (!resizingRef.current) return
    resizingRef.current = false
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [handlePointerMove])

  const beginResize = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (typeof window === 'undefined') return
      event.preventDefault()
      resizingRef.current = true
      startXRef.current = event.clientX
      startWidthRef.current = treeWidth
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
    },
    [handlePointerMove, handlePointerUp, treeWidth],
  )

  React.useEffect(() => {
    return () => {
      if (typeof window === 'undefined') return
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [handlePointerMove, handlePointerUp])

  const adjustWidth = React.useCallback((delta: number) => {
    setTreeWidth((prev) => clampTreeWidth(prev + delta))
  }, [])

  const handleSeparatorKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowDown':
          event.preventDefault()
          adjustWidth(-24)
          break
        case 'ArrowRight':
        case 'ArrowUp':
          event.preventDefault()
          adjustWidth(24)
          break
        case 'Home':
          event.preventDefault()
          setTreeWidth(DESKTOP_TREE_MIN_WIDTH)
          break
        case 'End':
          event.preventDefault()
          setTreeWidth(DESKTOP_TREE_MAX_WIDTH)
          break
        case 'Enter':
        case ' ': // Space
          event.preventDefault()
          setTreeWidth(DESKTOP_TREE_DEFAULT_WIDTH)
          break
        default:
          break
      }
    },
    [adjustWidth],
  )

  return (
    <div className="flex min-h-[540px] w-full items-stretch gap-4">
      <div className="flex h-full flex-col" style={{ width: `${treeWidth}px` }}>
        <FileTreePane {...treeProps} />
      </div>
      <button
        type="button"
        role="separator"
        aria-label="Resize file tree panel"
        aria-orientation="vertical"
        aria-valuemin={DESKTOP_TREE_MIN_WIDTH}
        aria-valuemax={DESKTOP_TREE_MAX_WIDTH}
        aria-valuenow={Math.round(treeWidth)}
        onPointerDown={beginResize}
        onKeyDown={handleSeparatorKeyDown}
        onDoubleClick={() => setTreeWidth(DESKTOP_TREE_DEFAULT_WIDTH)}
        className={`group flex w-3 shrink-0 cursor-col-resize items-center justify-center self-stretch rounded-full border transition focus-visible:outline-none ${separatorButtonClass}`}
      >
        <span aria-hidden="true" className={`h-24 w-1 rounded-full transition-all ${separatorIndicatorClass}`} />
      </button>
      <div className="flex min-w-0 flex-1">
        <FileViewerPane {...desktopViewerProps} />
      </div>
    </div>
  )
}

function MobileView({ treeProps, viewerProps }: ExplorerViewProps) {
  const [panel, setPanel] = React.useState<'tree' | 'viewer'>('tree')
  const treeRef = React.useRef<HTMLDivElement | null>(null)
  const viewerRef = React.useRef<HTMLDivElement | null>(null)
  const previousPath = React.useRef<string | null>(null)
  const selectedPath = viewerProps.selectedPath ?? null

  React.useEffect(() => {
    if (selectedPath && selectedPath !== previousPath.current) {
      setPanel('viewer')
    }
    previousPath.current = selectedPath
  }, [selectedPath])

  React.useEffect(() => {
    const node = panel === 'tree' ? treeRef.current : viewerRef.current
    node?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [panel])

  return (
    <div className="grid min-h-[540px] w-full gap-5">
      <FileTreePane
        {...treeProps}
        ref={treeRef}
        className={`${treeProps.className} ${panel !== 'tree' ? 'hidden' : ''}`}
        headerAction={
          panel === 'tree' && selectedPath ? (
            <button
              type="button"
              onClick={() => setPanel('viewer')}
              className="text-xs font-medium text-emerald-600"
            >
              View file
            </button>
          ) : null
        }
      />
      <FileViewerPane
        {...viewerProps}
        ref={viewerRef}
        className={`${viewerProps.className} ${panel !== 'viewer' ? 'hidden' : ''}`}
        headerAction={
          panel === 'viewer' ? (
            <button
              type="button"
              onClick={() => setPanel('tree')}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-600"
            >
              File explorer
            </button>
          ) : null
        }
      />
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

function renderFallbackTree(
  node: FallbackNode,
  depth: number,
  onSelect: (path: string) => void,
  selectedPath: string | null,
  isDark: boolean,
): React.ReactNode {
  if (node.type !== 'directory') {
    const selected = selectedPath === node.path
    return (
      <div key={`fallback-${node.path}`} className="select-none">
        <button
          type="button"
          className={`flex w-full items-center rounded-md px-2 py-1 text-left text-sm transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40 ${
            selected
              ? isDark
                ? 'bg-emerald-500/20 text-emerald-200'
                : 'bg-emerald-100 text-emerald-700'
              : isDark
                ? 'text-slate-200 hover:bg-slate-800'
                : 'text-slate-700 hover:bg-slate-100'
          }`}
          style={{ paddingLeft: depth * 12 + 16 }}
          onClick={() => onSelect(node.path)}
          data-testid="file-tree-file"
        >
          <span className={`mr-2 text-[11px] leading-none ${isDark ? 'text-slate-400' : 'text-slate-400'}`}>📄</span>
          <span className={`truncate ${selected ? (isDark ? 'text-emerald-100' : 'text-emerald-800') : ''}`}>{node.name}</span>
        </button>
      </div>
    )
  }

  if (depth === 0 && node.children.length === 0) {
    return (
      <div className={`px-2 py-4 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
        No files detected yet.
      </div>
    )
  }

  return node.children.map((child) => {
    if (child.type === 'directory') {
      return (
        <div key={`fallback-${child.path}`} className="select-none">
          <div
            className={`flex w-full items-center px-2 py-1 text-left text-xs ${isDark ? 'text-slate-400' : 'text-slate-400'}`}
            style={{ paddingLeft: depth * 12 }}
          >
            <span className={`mr-1 text-[10px] leading-none ${isDark ? 'text-slate-500' : 'text-slate-500'}`}>▸</span>
            <span className="truncate">{child.name}</span>
          </div>
          <div className="ml-3 space-y-0.5">
            {renderFallbackTree(child, depth + 1, onSelect, selectedPath, isDark)}
          </div>
        </div>
      )
    }
    return renderFallbackTree(child, depth, onSelect, selectedPath, isDark)
  })
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(() => {
    if (typeof window === 'undefined') return false
    return window.matchMedia(query).matches
  })

  React.useEffect(() => {
    if (typeof window === 'undefined') return undefined
    const media = window.matchMedia(query)
    const listener = (event: MediaQueryListEvent) => setMatches(event.matches)
    if (media.addEventListener) {
      media.addEventListener('change', listener)
    } else {
      media.addListener(listener)
    }
    setMatches(media.matches)
    return () => {
      if (media.removeEventListener) {
        media.removeEventListener('change', listener)
      } else {
        media.removeListener(listener)
      }
    }
  }, [query])

  return matches
}
