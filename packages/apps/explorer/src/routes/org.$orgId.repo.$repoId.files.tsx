import * as React from 'react'
import { Suspense } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'

const MonacoEditor = React.lazy(() => import('@monaco-editor/react'))

export const Route = createFileRoute('/org/$orgId/repo/$repoId/files' as any)({
  component: Files,
})

type FileChangeRow = Pick<Database['file_changes'], 'path' | 'additions' | 'deletions' | 'commit_sha'>

type FileEntry = {
  path: string
  commitSha: string | null
}

type FileNode = {
  type: 'file'
  name: string
  path: string
  commitSha: string | null
}

type DirectoryNode = {
  type: 'directory'
  name: string
  path: string
  children: TreeNode[]
}

type TreeNode = FileNode | DirectoryNode

type ViewerState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | { status: 'ready'; path: string; content: string }
  | { status: 'error'; path: string; error: string }

interface FileTree {
  root: DirectoryNode
  directories: string[]
}

const RAW_BASE =
  (import.meta.env.VITE_GITHUB_RAW_BASE ?? 'https://raw.githubusercontent.com').replace(/\/$/, '') || 'https://raw.githubusercontent.com'

const URL_TEMPLATE = import.meta.env.VITE_FILE_VIEWER_URL_TEMPLATE?.trim() || null

function buildFileTree(entries: FileEntry[]): FileTree {
  const root: DirectoryNode = { type: 'directory', name: '', path: '', children: [] }
  const directories = new Set<string>([''])

  for (const entry of entries) {
    if (!entry.path) continue
    const segments = entry.path.split('/').filter(Boolean)
    if (segments.length === 0) continue

    let current = root
    segments.forEach((segment, index) => {
      const currentPath = current.path ? `${current.path}/${segment}` : segment
      const isLeaf = index === segments.length - 1

      if (isLeaf) {
        current.children.push({
          type: 'file',
          name: segment,
          path: currentPath,
          commitSha: entry.commitSha ?? null,
        })
        return
      }

      let next = current.children.find(
        (child): child is DirectoryNode => child.type === 'directory' && child.name === segment,
      )
      if (!next) {
        next = {
          type: 'directory',
          name: segment,
          path: currentPath,
          children: [],
        }
        current.children.push(next)
      }
      directories.add(next.path)
      current = next
    })
  }

  sortTreeChildren(root)

  return {
    root,
    directories: Array.from(directories),
  }
}

function sortTreeChildren(node: DirectoryNode) {
  node.children.sort((a, b) => {
    if (a.type === b.type) return a.name.localeCompare(b.name)
    return a.type === 'directory' ? -1 : 1
  })
  node.children.forEach((child) => {
    if (child.type === 'directory') {
      sortTreeChildren(child)
    }
  })
}

function buildFileEntries(rows: Array<{ path: string | null | undefined; commit_sha: string | null | undefined }>): FileEntry[] {
  const map = new Map<string, string | null>()
  for (const row of rows) {
    const path = row.path?.trim()
    if (!path) continue
    if (!map.has(path)) {
      map.set(path, row.commit_sha ?? null)
    }
  }
  return Array.from(map.entries()).map(([path, commitSha]) => ({ path, commitSha }))
}

function buildContentUrl(orgId: string, repoId: string, commitSha: string, path: string): string {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  if (URL_TEMPLATE) {
    return URL_TEMPLATE.replace(/\{org\}/g, encodeURIComponent(orgId))
      .replace(/\{repo\}/g, encodeURIComponent(repoId))
      .replace(/\{commit\}/g, encodeURIComponent(commitSha))
      .replace(/\{path\}/g, encodedPath)
  }

  return `${RAW_BASE}/${encodeURIComponent(orgId)}/${encodeURIComponent(repoId)}/${encodeURIComponent(commitSha)}/${encodedPath}`
}

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

function Files() {
  const { orgId, repoId } = Route.useParams()
  useRepoStreams(orgId, repoId)
  const fixture = useRepoFixture(orgId, repoId)

  const { file_changes: fileChangesCollection } = useCollections()
  const { data: liveRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ f: fileChangesCollection })
        .where(({ f }) => eq(f.org_id, orgId))
        .where(({ f }) => eq(f.repo_id, repoId))
        .orderBy(({ f }) => f.commit_sha ?? '', 'desc')
        .select(({ f }) => ({
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
          commit_sha: f.commit_sha,
        })),
    [fileChangesCollection, orgId, repoId],
  ) as { data: Array<FileChangeRow> }

  const rows = fixture?.fileChanges?.length ? fixture.fileChanges : liveRows

  const fileEntries = React.useMemo(() => buildFileEntries(rows), [rows])
  const tree = React.useMemo(() => buildFileTree(fileEntries), [fileEntries])

  const directoryKey = React.useMemo(() => tree.directories.slice().sort().join('|'), [tree.directories])
  const [expandedDirs, setExpandedDirs] = React.useState<Set<string>>(() => new Set(['']))
  React.useEffect(() => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      next.add('')
      for (const dirPath of tree.directories) {
        if (!dirPath) continue
        const depth = dirPath.split('/').length
        if (depth <= 1) {
          next.add(dirPath)
        }
      }
      return next
    })
  }, [directoryKey, tree.directories])

  const [selectedPath, setSelectedPath] = React.useState<string | null>(null)
  React.useEffect(() => {
    if (selectedPath && !fileEntries.some((entry) => entry.path === selectedPath)) {
      setSelectedPath(null)
    }
  }, [selectedPath, fileEntries])

  const selectedEntry = React.useMemo(() => {
    if (!selectedPath) return null
    return fileEntries.find((entry) => entry.path === selectedPath) ?? null
  }, [fileEntries, selectedPath])

  const [viewerState, setViewerState] = React.useState<ViewerState>({ status: 'idle' })
  const selectedCommit = selectedEntry?.commitSha ?? null
  const selectedFilePath = selectedEntry?.path ?? null

  React.useEffect(() => {
    if (!selectedFilePath) {
      setViewerState({ status: 'idle' })
      return
    }
    if (!selectedCommit) {
      setViewerState({
        status: 'error',
        path: selectedFilePath,
        error: 'No commit information available for this file.',
      })
      return
    }

    const url = buildContentUrl(orgId, repoId, selectedCommit, selectedFilePath)
    const controller = new AbortController()
    let cancelled = false
    setViewerState({ status: 'loading', path: selectedFilePath })

    fetch(url, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }
        const text = await res.text()
        if (!cancelled) {
          setViewerState({ status: 'ready', path: selectedFilePath, content: text })
        }
      })
      .catch((error) => {
        if (cancelled) return
        setViewerState({
          status: 'error',
          path: selectedFilePath,
          error: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelled = true
      controller.abort()
    }
  }, [orgId, repoId, selectedCommit, selectedFilePath])

  const toggleDirectory = React.useCallback((path: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  const renderNodes = React.useCallback(
    (nodes: TreeNode[], depth: number): React.ReactNode => {
      return nodes.map((node) => {
        if (node.type === 'directory') {
          const expanded = expandedDirs.has(node.path)
          const isEmpty = node.children.length === 0
          const icon = expanded ? '▾' : '▸'
          return (
            <div key={`${node.path || '__root'}-dir`} className="select-none">
              <button
                type="button"
                className="flex items-center w-full text-left text-xs px-2 py-1 rounded-md text-gray-200 hover:bg-[#2a2d2e] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#007acc]/50"
                style={{ paddingLeft: depth * 12 }}
                onClick={() => toggleDirectory(node.path)}
                disabled={isEmpty}
                data-testid="file-tree-directory"
              >
                <span className="mr-1 text-[10px] leading-none text-gray-400">{isEmpty ? '•' : icon}</span>
                <span className="truncate">{node.name || (orgId + '/' + repoId)}</span>
              </button>
              {expanded && node.children.length > 0 && (
                <div className="space-y-0.5">{renderNodes(node.children, depth + 1)}</div>
              )}
            </div>
          )
        }

        const selected = selectedPath === node.path
        return (
          <div key={node.path} className="select-none">
            <button
              type="button"
              className={`flex items-center w-full text-left text-sm px-2 py-1 rounded-md transition-colors ${
                selected ? 'bg-[#094771] text-white' : 'text-gray-200 hover:bg-[#2a2d2e]'
              } focus:outline-none focus-visible:ring-2 focus-visible:ring-[#007acc]/50`}
              style={{ paddingLeft: depth * 12 + 16 }}
              onClick={() => setSelectedPath(node.path)}
              data-testid="file-tree-file"
            >
              <span className="mr-2 text-[11px] leading-none">📄</span>
              <span className="truncate">{node.name}</span>
            </button>
          </div>
        )
      })
    },
    [expandedDirs, orgId, repoId, selectedPath, toggleDirectory],
  )

  const hasFiles = fileEntries.length > 0

  return (
    <div className="space-y-4" data-testid="file-explorer-view">
      <div>
        <h3 className="font-semibold text-lg text-gray-900" data-testid="file-explorer-heading">
          Repository files ({orgId}/{repoId})
        </h3>
        <p className="text-sm text-gray-500">Browse the latest files detected from Git activity. Click a file to preview its contents.</p>
      </div>
      <div className="flex flex-col lg:flex-row gap-4 min-h-[520px]">
        <div className="lg:w-72 w-full bg-[#1e1e1e] text-gray-200 rounded-lg border border-gray-700 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-700 text-xs uppercase tracking-[0.2em] text-gray-400">
            Explorer
          </div>
          <div className="p-2 text-sm" data-testid="file-explorer-tree">
            {hasFiles ? (
              <div className="space-y-0.5">{renderNodes(tree.root.children, 0)}</div>
            ) : (
              <div className="px-2 py-4 text-xs text-gray-500">No files detected yet for this repository.</div>
            )}
          </div>
        </div>
        <div className="flex-1 min-h-[420px] bg-white rounded-lg border border-gray-200 overflow-hidden flex flex-col" data-testid="file-viewer">
          <div className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-sm font-medium text-gray-700 truncate" data-testid="file-viewer-header">
            {selectedPath ?? 'Select a file to preview'}
          </div>
          <div className="flex-1">
            {viewerState.status === 'idle' && (
              <div className="flex items-center justify-center h-full text-sm text-gray-500" data-testid="file-viewer-placeholder">
                Select a file to preview its contents.
              </div>
            )}
            {viewerState.status === 'loading' && (
              <div className="flex items-center justify-center h-full text-sm text-gray-500" data-testid="file-viewer-status">
                Loading {viewerState.path}…
              </div>
            )}
            {viewerState.status === 'error' && (
              <div className="flex flex-col items-center justify-center h-full text-center gap-2 text-sm text-red-600 px-6" data-testid="file-viewer-status">
                <p>Unable to load file content for {viewerState.path}.</p>
                <p className="text-xs text-red-400">{viewerState.error}</p>
              </div>
            )}
            {viewerState.status === 'ready' && (
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
                  loading={
                    <div className="flex items-center justify-center h-full text-sm text-gray-500">
                      Loading editor…
                    </div>
                  }
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
      </div>
    </div>
  )
}

export { Files as FilesComponent }
