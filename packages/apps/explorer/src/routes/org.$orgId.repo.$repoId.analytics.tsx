import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { diffLines } from 'diff'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'
import { gitStore, type PackRow } from '@ps/git-store'
import { useTheme } from '../ui/theme-context'
import { BreadcrumbChips } from '../components/BreadcrumbChips'
import { InlineSpinner } from '../components/InlineSpinner'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/analytics' as any)({
  component: Analytics,
})

type CommitRow = Pick<Database['commits'], 'sha' | 'author_name' | 'author_email' | 'authored_at' | 'message'>
type FileChangeRow = Pick<Database['file_changes'], 'commit_sha' | 'path' | 'additions' | 'deletions'>
type ContributorStat = {
  author_name: string | null
  author_email: string | null
  commit_count: number
  total_additions: number
  total_deletions: number
  first_commit: string | null
  last_commit: string | null
}

type FileHotspot = {
  path: string | null
  change_count: number
  total_additions: number
  total_deletions: number
}

type DailyActivity = {
  date: string
  commit_count: number
}

type DiffLine = {
  type: 'context' | 'add' | 'remove'
  text: string
}

type SingleFileDiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; lines: DiffLine[] }
  | { status: 'binary'; message: string }
  | { status: 'missing'; message: string }
  | { status: 'too_large'; message: string }

const decoder = 'TextDecoder' in globalThis ? new TextDecoder('utf-8') : null
const MAX_DIFF_PREVIEW_BYTES = 200_000
const DIFF_SNIPPET_LIMIT = 2_000

function Analytics() {
  const { orgId, repoId } = Route.useParams()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  useRepoStreams(orgId, repoId)
  const fixture = useRepoFixture(orgId, repoId)

  const {
    commits: commitsCollection,
    file_changes: fileChangesCollection,
    objects: objectsCollection,
  } = useCollections()

  const { data: liveCommits = [] } = useLiveQuery(
    (q) =>
      q
        .from({ c: commitsCollection })
        .where(({ c }) => eq(c.org_id, orgId))
        .where(({ c }) => eq(c.repo_id, repoId))
        .select(({ c }) => ({
          sha: c.sha,
          author_name: c.author_name,
          author_email: c.author_email,
          authored_at: c.authored_at,
          message: c.message,
        })),
    [commitsCollection, orgId, repoId],
  ) as { data: Array<CommitRow> }

  const { data: liveFileChanges = [] } = useLiveQuery(
    (q) =>
      q
        .from({ f: fileChangesCollection })
        .where(({ f }) => eq(f.org_id, orgId))
        .where(({ f }) => eq(f.repo_id, repoId))
        .select(({ f }) => ({
          commit_sha: f.commit_sha,
          path: f.path,
          additions: f.additions,
          deletions: f.deletions,
        })),
    [fileChangesCollection, orgId, repoId],
  ) as { data: Array<FileChangeRow> }

  const commits = fixture?.commits?.length ? fixture.commits : liveCommits
  const fileChanges = fixture?.fileChanges?.length ? fixture.fileChanges : liveFileChanges

  // Pack indexing for diff viewing
  const packRows = useLiveQuery(
    (q) =>
      q
        .from({ o: objectsCollection })
        .where(({ o }) => eq(o.org_id, orgId))
        .where(({ o }) => eq(o.repo_id, repoId))
        .select(({ o }) => ({
          id: o.id,
          org_id: o.org_id,
          repo_id: o.repo_id,
          pack_oid: o.pack_oid,
          storage_key: o.storage_key,
          size_bytes: o.size_bytes,
          pack_bytes: '',
          created_at: o.created_at,
        })),
    [objectsCollection, orgId, repoId],
  ) as { data: PackRow[] }

  const packKey = React.useMemo(
    () => packRows.data.map((row) => `${row.pack_oid}:${row.storage_key ?? ''}`).join('|'),
    [packRows.data],
  )

  React.useEffect(() => {
    if (!packRows.data.length) return
    void gitStore.indexPacks(packRows.data).catch((error) => {
      console.error('[gitStore] failed to index packs (analytics view)', error)
    })
  }, [packKey, packRows.data])

  // File hotspot ignore patterns - demonstrates reactive filtering
  const defaultIgnorePatterns = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'CHANGELOG.md', 'CHANGELOG']
  const [ignoredPatterns, setIgnoredPatterns] = React.useState<string[]>(defaultIgnorePatterns)

  // === ADVANCED FEATURES STATE ===
  // Active tab for advanced features
  const [activeTab, setActiveTab] = React.useState<'overview' | 'author-insights' | 'blame-timeline' | 'commit-search'>('overview')

  // Author Insights state
  const [selectedAuthorEmail, setSelectedAuthorEmail] = React.useState<string | null>(null)

  // Blame Timeline state
  const [selectedFilePath, setSelectedFilePath] = React.useState<string | null>(null)
  const [fileSearchQuery, setFileSearchQuery] = React.useState('')
  const [expandedBlameCommit, setExpandedBlameCommit] = React.useState<string | null>(null)
  const [blameDiffStates, setBlameDiffStates] = React.useState<Record<string, SingleFileDiffState>>({})

  // Commit Search state
  const [searchFilters, setSearchFilters] = React.useState({
    author: '',
    message: '',
    filePath: '',
    dateFrom: '',
    dateTo: '',
    minAdditions: '',
    maxAdditions: '',
    minDeletions: '',
    maxDeletions: '',
  })

  const contributorStats = React.useMemo<ContributorStat[]>(() => {
    const statsMap = new Map<string, ContributorStat>()
    const changesByCommit = new Map<string, FileChangeRow[]>()
    for (const fc of fileChanges) {
      if (!fc.commit_sha) continue
      const list = changesByCommit.get(fc.commit_sha) ?? []
      list.push(fc)
      changesByCommit.set(fc.commit_sha, list)
    }
    for (const commit of commits) {
      const email = commit.author_email ?? 'unknown'
      const existing = statsMap.get(email) ?? {
        author_name: commit.author_name,
        author_email: commit.author_email ?? null,
        commit_count: 0,
        total_additions: 0,
        total_deletions: 0,
        first_commit: null,
        last_commit: null,
      }
      existing.commit_count += 1
      const commitChanges = changesByCommit.get(commit.sha ?? '') ?? []
      for (const fc of commitChanges) {
        existing.total_additions += fc.additions ?? 0
        existing.total_deletions += fc.deletions ?? 0
      }
      if (commit.authored_at) {
        if (!existing.first_commit || commit.authored_at < existing.first_commit) {
          existing.first_commit = commit.authored_at
        }
        if (!existing.last_commit || commit.authored_at > existing.last_commit) {
          existing.last_commit = commit.authored_at
        }
      }
      statsMap.set(email, existing)
    }
    return Array.from(statsMap.values()).sort((a, b) => b.commit_count - a.commit_count)
  }, [commits, fileChanges])

  // Compute all file hotspots first (unfiltered)
  const allFileHotspots = React.useMemo<FileHotspot[]>(() => {
    const hotspotsMap = new Map<string, FileHotspot>()
    for (const fc of fileChanges) {
      const path = fc.path ?? 'unknown'
      const existing = hotspotsMap.get(path) ?? {
        path: fc.path,
        change_count: 0,
        total_additions: 0,
        total_deletions: 0,
      }
      existing.change_count += 1
      existing.total_additions += fc.additions ?? 0
      existing.total_deletions += fc.deletions ?? 0
      hotspotsMap.set(path, existing)
    }
    return Array.from(hotspotsMap.values()).sort((a, b) => b.change_count - a.change_count)
  }, [fileChanges])

  // Apply ignore patterns - this reactive filter demonstrates TanStack DB's differential dataflow
  const fileHotspots = React.useMemo<FileHotspot[]>(() => {
    const isIgnored = (path: string | null) => {
      if (!path) return false
      const filename = path.split('/').pop() ?? path
      return ignoredPatterns.some((pattern) => {
        // Support simple glob patterns
        if (pattern.startsWith('*')) {
          return filename.endsWith(pattern.slice(1))
        }
        if (pattern.endsWith('*')) {
          return filename.startsWith(pattern.slice(0, -1))
        }
        return filename === pattern || path === pattern
      })
    }
    return allFileHotspots.filter((h) => !isIgnored(h.path)).slice(0, 20)
  }, [allFileHotspots, ignoredPatterns])

  const dailyActivity = React.useMemo<DailyActivity[]>(() => {
    const activityMap = new Map<string, number>()
    for (const commit of commits) {
      if (!commit.authored_at) continue
      const date = commit.authored_at.slice(0, 10)
      activityMap.set(date, (activityMap.get(date) ?? 0) + 1)
    }
    return Array.from(activityMap.entries())
      .map(([date, commit_count]) => ({ date, commit_count }))
      .sort((a, b) => a.date.localeCompare(b.date))
  }, [commits])

  const totalCommits = commits.length
  const totalContributors = contributorStats.length
  const totalFilesChanged = allFileHotspots.length
  const totalAdditions = fileChanges.reduce((sum, fc) => sum + (fc.additions ?? 0), 0)
  const totalDeletions = fileChanges.reduce((sum, fc) => sum + (fc.deletions ?? 0), 0)
  const maxDailyCommits = Math.max(...dailyActivity.map((d) => d.commit_count), 1)

  // === FILE IMPACT EXPLORER ===
  // Get unique file paths for autocomplete
  const uniqueFilePaths = React.useMemo(() => {
    const paths = new Set<string>()
    for (const fc of fileChanges) {
      if (fc.path) paths.add(fc.path)
    }
    return Array.from(paths).sort()
  }, [fileChanges])

  // Filter file paths based on search query and ignore patterns
  const filteredFilePaths = React.useMemo(() => {
    const isIgnored = (path: string) => {
      const filename = path.split('/').pop() ?? path
      return ignoredPatterns.some((pattern) => {
        if (pattern.startsWith('*')) {
          return filename.endsWith(pattern.slice(1))
        }
        if (pattern.endsWith('*')) {
          return filename.startsWith(pattern.slice(0, -1))
        }
        return filename === pattern || path === pattern
      })
    }
    const filtered = uniqueFilePaths.filter((p) => !isIgnored(p))
    if (!fileSearchQuery.trim()) return filtered.slice(0, 50)
    const query = fileSearchQuery.toLowerCase()
    return filtered.filter((p) => p.toLowerCase().includes(query)).slice(0, 50)
  }, [uniqueFilePaths, fileSearchQuery, ignoredPatterns])

  // Get commits that touched the selected file
  const fileImpactData = React.useMemo(() => {
    if (!selectedFilePath) return null
    const commitShas = new Set<string>()
    const changesByCommit = new Map<string, FileChangeRow>()
    for (const fc of fileChanges) {
      if (fc.path === selectedFilePath && fc.commit_sha) {
        commitShas.add(fc.commit_sha)
        changesByCommit.set(fc.commit_sha, fc)
      }
    }
    const relevantCommits = commits
      .filter((c) => c.sha && commitShas.has(c.sha))
      .sort((a, b) => (b.authored_at ?? '').localeCompare(a.authored_at ?? ''))
    
    // Compute blame timeline - who changed this file over time
    const authorChanges = new Map<string, { count: number; additions: number; deletions: number; lastChange: string }>()
    for (const commit of relevantCommits) {
      const author = commit.author_email ?? 'unknown'
      const change = changesByCommit.get(commit.sha ?? '')
      const existing = authorChanges.get(author) ?? { count: 0, additions: 0, deletions: 0, lastChange: '' }
      existing.count += 1
      existing.additions += change?.additions ?? 0
      existing.deletions += change?.deletions ?? 0
      if (!existing.lastChange || (commit.authored_at ?? '') > existing.lastChange) {
        existing.lastChange = commit.authored_at ?? ''
      }
      authorChanges.set(author, existing)
    }

    return {
      commits: relevantCommits,
      changesByCommit,
      authorChanges: Array.from(authorChanges.entries())
        .map(([email, data]) => ({
          email,
          name: relevantCommits.find((c) => c.author_email === email)?.author_name ?? email,
          ...data,
        }))
        .sort((a, b) => b.count - a.count),
      totalChanges: relevantCommits.length,
    }
  }, [selectedFilePath, commits, fileChanges])

  // === COMMIT SEARCH WITH COMPLEX FILTERS ===
  // Build a map of commit SHA -> aggregated file changes for filtering
  const commitAggregates = React.useMemo(() => {
    const map = new Map<string, { additions: number; deletions: number; files: string[] }>()
    for (const fc of fileChanges) {
      if (!fc.commit_sha) continue
      const existing = map.get(fc.commit_sha) ?? { additions: 0, deletions: 0, files: [] }
      existing.additions += fc.additions ?? 0
      existing.deletions += fc.deletions ?? 0
      if (fc.path) existing.files.push(fc.path)
      map.set(fc.commit_sha, existing)
    }
    return map
  }, [fileChanges])

  // Apply all search filters
  const searchResults = React.useMemo(() => {
    const { author, message, filePath, dateFrom, dateTo, minAdditions, maxAdditions, minDeletions, maxDeletions } = searchFilters
    const hasAnyFilter = author || message || filePath || dateFrom || dateTo || minAdditions || maxAdditions || minDeletions || maxDeletions
    if (!hasAnyFilter) return null

    return commits.filter((commit) => {
      // Author filter (case-insensitive partial match on name or email)
      if (author) {
        const authorLower = author.toLowerCase()
        const nameMatch = (commit.author_name ?? '').toLowerCase().includes(authorLower)
        const emailMatch = (commit.author_email ?? '').toLowerCase().includes(authorLower)
        if (!nameMatch && !emailMatch) return false
      }

      // Message filter (case-insensitive partial match)
      if (message) {
        if (!(commit.message ?? '').toLowerCase().includes(message.toLowerCase())) return false
      }

      // Date range filters
      if (dateFrom && commit.authored_at && commit.authored_at < dateFrom) return false
      if (dateTo && commit.authored_at && commit.authored_at > dateTo + 'T23:59:59') return false

      // Get aggregated data for this commit
      const agg = commitAggregates.get(commit.sha ?? '')

      // File path filter
      if (filePath) {
        const pathLower = filePath.toLowerCase()
        const hasMatchingFile = agg?.files.some((f) => f.toLowerCase().includes(pathLower))
        if (!hasMatchingFile) return false
      }

      // Additions/deletions filters
      const additions = agg?.additions ?? 0
      const deletions = agg?.deletions ?? 0
      if (minAdditions && additions < parseInt(minAdditions, 10)) return false
      if (maxAdditions && additions > parseInt(maxAdditions, 10)) return false
      if (minDeletions && deletions < parseInt(minDeletions, 10)) return false
      if (maxDeletions && deletions > parseInt(maxDeletions, 10)) return false

      return true
    }).sort((a, b) => (b.authored_at ?? '').localeCompare(a.authored_at ?? ''))
  }, [commits, searchFilters, commitAggregates])

  // Get unique authors for autocomplete
  const uniqueAuthors = React.useMemo(() => {
    const authors = new Map<string, string>()
    for (const commit of commits) {
      if (commit.author_email && !authors.has(commit.author_email)) {
        authors.set(commit.author_email, commit.author_name ?? commit.author_email)
      }
    }
    return Array.from(authors.entries()).map(([email, name]) => ({ email, name }))
  }, [commits])

  // Author-specific file hotspots (across all branches)
  const authorFileHotspots = React.useMemo<FileHotspot[]>(() => {
    if (!selectedAuthorEmail) return []
    
    // Get all commit SHAs by this author
    const authorCommitShas = new Set<string>()
    for (const commit of commits) {
      if (commit.author_email === selectedAuthorEmail && commit.sha) {
        authorCommitShas.add(commit.sha)
      }
    }
    
    // Aggregate file changes for those commits
    const hotspotsMap = new Map<string, FileHotspot>()
    for (const fc of fileChanges) {
      if (!fc.commit_sha || !authorCommitShas.has(fc.commit_sha)) continue
      const path = fc.path ?? 'unknown'
      const existing = hotspotsMap.get(path) ?? {
        path: fc.path,
        change_count: 0,
        total_additions: 0,
        total_deletions: 0,
      }
      existing.change_count += 1
      existing.total_additions += fc.additions ?? 0
      existing.total_deletions += fc.deletions ?? 0
      hotspotsMap.set(path, existing)
    }
    
    return Array.from(hotspotsMap.values()).sort((a, b) => b.change_count - a.change_count)
  }, [selectedAuthorEmail, commits, fileChanges])

  // Apply ignore patterns to author file hotspots
  const filteredAuthorFileHotspots = React.useMemo<FileHotspot[]>(() => {
    const isIgnored = (path: string | null) => {
      if (!path) return false
      const filename = path.split('/').pop() ?? path
      return ignoredPatterns.some((pattern) => {
        if (pattern.startsWith('*')) {
          return filename.endsWith(pattern.slice(1))
        }
        if (pattern.endsWith('*')) {
          return filename.startsWith(pattern.slice(0, -1))
        }
        return filename === pattern || path === pattern
      })
    }
    return authorFileHotspots.filter((h) => !isIgnored(h.path))
  }, [authorFileHotspots, ignoredPatterns])

  // Get selected author stats
  const selectedAuthorStats = React.useMemo(() => {
    if (!selectedAuthorEmail) return null
    return contributorStats.find((s) => s.author_email === selectedAuthorEmail) ?? null
  }, [selectedAuthorEmail, contributorStats])

  // === BLAME TIMELINE DIFF LOADING ===
  const isLikelyBinary = React.useCallback((content: Uint8Array) => {
    if (!content || content.length === 0) return false
    const sample = content.subarray(0, 4000)
    let decoded: string
    try {
      decoded = decoder?.decode(sample, { stream: false }) ?? new TextDecoder('utf-8', { fatal: false }).decode(sample)
    } catch {
      return true
    }
    return /\u0000/.test(decoded)
  }, [])

  const decodeContent = React.useCallback((content: Uint8Array) => {
    if (decoder) return decoder.decode(content)
    return new TextDecoder('utf-8', { fatal: false }).decode(content)
  }, [])

  const loadSingleFileDiff = React.useCallback(
    async (commitSha: string, filePath: string): Promise<SingleFileDiffState> => {
      const { parents } = await gitStore.getCommitInfo(commitSha)
      const parentSha = parents?.[0] ?? null

      let nextBytes: Uint8Array | null = null
      let prevBytes: Uint8Array | null = null

      try {
        const result = await gitStore.readFile(commitSha, filePath)
        nextBytes = result.content
      } catch {
        nextBytes = null
      }

      if (parentSha) {
        try {
          const prevResult = await gitStore.readFile(parentSha, filePath)
          prevBytes = prevResult.content
        } catch {
          prevBytes = null
        }
      }

      if (!nextBytes && !prevBytes) {
        return { status: 'missing', message: 'File contents unavailable in this replica.' }
      }

      const candidate = nextBytes ?? prevBytes
      if (candidate && candidate.length > MAX_DIFF_PREVIEW_BYTES) {
        return { status: 'too_large', message: 'File is too large for inline preview.' }
      }

      if ((nextBytes && isLikelyBinary(nextBytes)) || (prevBytes && isLikelyBinary(prevBytes))) {
        return { status: 'binary', message: 'Binary file — download to inspect locally.' }
      }

      const nextContent = nextBytes ? decodeContent(nextBytes) : ''
      const prevContent = prevBytes ? decodeContent(prevBytes) : ''
      const diff = diffLines(prevContent, nextContent)

      const lines: DiffLine[] = []
      for (const part of diff) {
        const type: DiffLine['type'] = part.added ? 'add' : part.removed ? 'remove' : 'context'
        const value = part.value.endsWith('\n') ? part.value.slice(0, -1) : part.value
        const segments = value.split('\n')
        for (const segment of segments) {
          const text = segment.slice(0, DIFF_SNIPPET_LIMIT)
          lines.push({ type, text })
        }
      }

      return { status: 'ready', lines }
    },
    [decodeContent, isLikelyBinary],
  )

  // Effect to load diff when a blame commit is expanded
  React.useEffect(() => {
    if (!expandedBlameCommit || !selectedFilePath) return
    const key = `${expandedBlameCommit}:${selectedFilePath}`
    const existingState = blameDiffStates[key]
    if (existingState && existingState.status !== 'idle') {
      return
    }

    let cancelled = false
    setBlameDiffStates((prev) => ({ ...prev, [key]: { status: 'loading' } }))

    const startDiff = async () => {
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))

      loadSingleFileDiff(expandedBlameCommit, selectedFilePath)
        .then((state) => {
          if (cancelled) return
          setBlameDiffStates((prev) => ({ ...prev, [key]: state }))
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          if (cancelled) return
          setBlameDiffStates((prev) => ({ ...prev, [key]: { status: 'error', message } }))
        })
    }

    void startDiff()

    return () => {
      cancelled = true
    }
  }, [expandedBlameCommit, selectedFilePath, blameDiffStates, loadSingleFileDiff])

  // Clear expanded commit when file selection changes
  React.useEffect(() => {
    setExpandedBlameCommit(null)
  }, [selectedFilePath])

  const headingClass = isDark ? 'text-lg font-semibold text-slate-100' : 'text-lg font-semibold text-slate-900'
  const subheadingClass = isDark ? 'text-base font-medium text-slate-200' : 'text-base font-medium text-slate-800'
  const cardClass = isDark
    ? 'rounded-2xl border border-slate-700 bg-slate-900/70 p-5 shadow-lg shadow-slate-900/40'
    : 'rounded-2xl border border-slate-200 bg-white p-5 shadow-sm'
  const statCardClass = isDark
    ? 'rounded-xl border border-slate-700 bg-slate-800/60 p-4 text-center'
    : 'rounded-xl border border-slate-200 bg-slate-50 p-4 text-center'
  const statValueClass = isDark ? 'text-3xl font-bold text-emerald-400' : 'text-3xl font-bold text-emerald-600'
  const statLabelClass = isDark ? 'text-xs uppercase tracking-wide text-slate-400' : 'text-xs uppercase tracking-wide text-slate-500'
  const tableHeaderClass = isDark
    ? 'border-b border-slate-700 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-400'
    : 'border-b border-slate-200 px-3 py-2 text-left text-xs font-medium uppercase tracking-wide text-slate-500'
  const tableCellClass = isDark
    ? 'border-b border-slate-800 px-3 py-2 text-sm text-slate-200'
    : 'border-b border-slate-100 px-3 py-2 text-sm text-slate-700'
  const additionsClass = isDark ? 'text-emerald-400' : 'text-emerald-600'
  const deletionsClass = isDark ? 'text-red-400' : 'text-red-600'
  const barClass = isDark ? 'bg-emerald-500' : 'bg-emerald-500'
  const emptyClass = isDark ? 'text-slate-500 italic' : 'text-slate-400 italic'

  return (
    <div className="mx-auto max-w-6xl space-y-6" data-testid="analytics-view">
      <BreadcrumbChips
        isDark={isDark}
        items={[
          { key: 'home', label: 'Home', to: '/' },
          { key: `org-${orgId}`, label: orgId, to: '/org/$orgId', params: { orgId } },
          { key: `repo-${repoId}`, label: repoId, to: '/org/$orgId/repo/$repoId/files', params: { orgId, repoId } },
          { key: 'analytics', label: 'Analytics', current: true },
        ]}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className={headingClass} data-testid="analytics-heading">
          {repoId} - Analytics
        </h3>
        <span className={isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'}>
          Powered by TanStack DB + PowerSync
        </span>
      </div>

      {/* Tab Navigation */}
      <div className="flex flex-wrap gap-1">
        {(['overview', 'author-insights', 'blame-timeline', 'commit-search'] as const).map((tab) => {
          const labels = {
            overview: 'Overview',
            'author-insights': 'Author Insights',
            'blame-timeline': 'Blame Timeline',
            'commit-search': 'Commit Search',
          }
          const isActive = activeTab === tab
          return (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={
                isActive
                  ? isDark
                    ? 'rounded-lg bg-emerald-500/20 px-4 py-2 text-sm font-medium text-emerald-300 transition'
                    : 'rounded-lg bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-700 transition'
                  : isDark
                    ? 'rounded-lg px-4 py-2 text-sm font-medium text-slate-400 transition hover:bg-slate-800 hover:text-slate-200'
                    : 'rounded-lg px-4 py-2 text-sm font-medium text-slate-500 transition hover:bg-slate-100 hover:text-slate-700'
              }
            >
              {labels[tab]}
            </button>
          )
        })}
      </div>

      {activeTab === 'overview' && (
        <>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-5">
        <div className={statCardClass}>
          <div className={statValueClass}>{totalCommits.toLocaleString()}</div>
          <div className={statLabelClass}>Commits</div>
        </div>
        <div className={statCardClass}>
          <div className={statValueClass}>{totalContributors.toLocaleString()}</div>
          <div className={statLabelClass}>Contributors</div>
        </div>
        <div className={statCardClass}>
          <div className={statValueClass}>{totalFilesChanged.toLocaleString()}</div>
          <div className={statLabelClass}>Files Changed</div>
        </div>
        <div className={statCardClass}>
          <div className={`${statValueClass} ${additionsClass}`}>+{totalAdditions.toLocaleString()}</div>
          <div className={statLabelClass}>Additions</div>
        </div>
        <div className={statCardClass}>
          <div className={`${statValueClass} ${deletionsClass}`}>-{totalDeletions.toLocaleString()}</div>
          <div className={statLabelClass}>Deletions</div>
        </div>
      </div>

      <div className={cardClass}>
        <h4 className={subheadingClass}>Commit Activity</h4>
        <p className={isDark ? 'mb-4 text-xs text-slate-400' : 'mb-4 text-xs text-slate-500'}>
          Daily commit frequency across the repository history
        </p>
        {dailyActivity.length === 0 ? (
          <div className={emptyClass}>No commit activity data available</div>
        ) : (
          <div className="flex h-32 items-end gap-px overflow-x-auto">
            {dailyActivity.map((day) => {
              const heightPx = Math.max(2, Math.round((day.commit_count / maxDailyCommits) * 128))
              return (
                <div
                  key={day.date}
                  className="group relative flex-shrink-0"
                  style={{ width: Math.max(4, Math.floor(800 / dailyActivity.length)) }}
                >
                  <div
                    className={`${barClass} w-full rounded-t transition-all hover:opacity-80`}
                    style={{ height: heightPx }}
                    title={`${day.date}: ${day.commit_count} commit${day.commit_count === 1 ? '' : 's'}`}
                  />
                  <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white group-hover:block">
                    {day.date}: {day.commit_count}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className={cardClass}>
          <h4 className={subheadingClass}>Contributor Leaderboard</h4>
          <p className={isDark ? 'mb-4 text-xs text-slate-400' : 'mb-4 text-xs text-slate-500'}>
            Top contributors by commit count with lines added/deleted
          </p>
          {contributorStats.length === 0 ? (
            <div className={emptyClass}>No contributor data available</div>
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className={tableHeaderClass}>#</th>
                    <th className={tableHeaderClass}>Contributor</th>
                    <th className={tableHeaderClass}>Commits</th>
                    <th className={tableHeaderClass}>+/-</th>
                  </tr>
                </thead>
                <tbody>
                  {contributorStats.slice(0, 15).map((stat, index) => (
                    <tr
                      key={stat.author_email ?? index}
                      onClick={() => {
                        setSelectedAuthorEmail(stat.author_email)
                        setActiveTab('author-insights')
                      }}
                      className={isDark
                        ? 'cursor-pointer transition hover:bg-slate-800/50'
                        : 'cursor-pointer transition hover:bg-slate-50'
                      }
                    >
                      <td className={tableCellClass}>{index + 1}</td>
                      <td className={tableCellClass}>
                        <div className={isDark
                          ? 'font-medium text-emerald-400 hover:text-emerald-300'
                          : 'font-medium text-emerald-600 hover:text-emerald-500'
                        }>
                          {stat.author_name ?? 'Unknown'}
                        </div>
                        <div className={isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-400'}>
                          {stat.author_email}
                        </div>
                      </td>
                      <td className={tableCellClass}>{stat.commit_count.toLocaleString()}</td>
                      <td className={tableCellClass}>
                        <span className={additionsClass}>+{stat.total_additions.toLocaleString()}</span>
                        {' / '}
                        <span className={deletionsClass}>-{stat.total_deletions.toLocaleString()}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className={cardClass}>
          <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h4 className={subheadingClass}>File Hotspots</h4>
              <p className={isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'}>
                Most frequently changed files across all commits
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {ignoredPatterns.length > 0 ? (
                <>
                  <span className={isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-400'}>Ignoring:</span>
                  {ignoredPatterns.map((pattern) => (
                    <button
                      key={pattern}
                      type="button"
                      onClick={() => setIgnoredPatterns((prev) => prev.filter((p) => p !== pattern))}
                      className={isDark
                        ? 'inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300 transition hover:bg-slate-700'
                        : 'inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 transition hover:bg-slate-200'
                      }
                      title={`Click to stop ignoring ${pattern}`}
                    >
                      {pattern}
                      <span className="text-[10px]">x</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setIgnoredPatterns([])}
                    className={isDark
                      ? 'ml-1 text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline'
                      : 'ml-1 text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline'
                    }
                  >
                    Clear all
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setIgnoredPatterns(defaultIgnorePatterns)}
                  className={isDark
                    ? 'text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline'
                    : 'text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline'
                  }
                >
                  Reset default filters
                </button>
              )}
            </div>
          </div>
          {fileHotspots.length === 0 ? (
            <div className={emptyClass}>
              {allFileHotspots.length > 0
                ? `All ${allFileHotspots.length} files are filtered out. Try removing some ignore patterns.`
                : 'No file change data available'}
            </div>
          ) : (
            <div className="max-h-80 overflow-auto">
              <table className="w-full text-left">
                <thead>
                  <tr>
                    <th className={tableHeaderClass}>File</th>
                    <th className={tableHeaderClass}>Changes</th>
                    <th className={tableHeaderClass}>+/-</th>
                    <th className={tableHeaderClass} style={{ width: 60 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {fileHotspots.map((hotspot, index) => {
                    const filename = (hotspot.path ?? '').split('/').pop() ?? hotspot.path ?? ''
                    return (
                      <tr key={hotspot.path ?? index}>
                        <td className={`${tableCellClass} max-w-xs truncate font-mono text-xs`} title={hotspot.path ?? ''}>
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedFilePath(hotspot.path)
                              setActiveTab('blame-timeline')
                            }}
                            className={isDark
                              ? 'text-left text-emerald-400 hover:text-emerald-300 hover:underline'
                              : 'text-left text-emerald-600 hover:text-emerald-500 hover:underline'
                            }
                          >
                            {hotspot.path ?? 'unknown'}
                          </button>
                        </td>
                        <td className={tableCellClass}>{hotspot.change_count.toLocaleString()}</td>
                        <td className={tableCellClass}>
                          <span className={additionsClass}>+{hotspot.total_additions.toLocaleString()}</span>
                          {' / '}
                          <span className={deletionsClass}>-{hotspot.total_deletions.toLocaleString()}</span>
                        </td>
                        <td className={tableCellClass}>
                          <button
                            type="button"
                            onClick={() => {
                              if (filename && !ignoredPatterns.includes(filename)) {
                                setIgnoredPatterns((prev) => [...prev, filename])
                              }
                            }}
                            className={isDark
                              ? 'rounded px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:bg-slate-800 hover:text-slate-300'
                              : 'rounded px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-600'
                            }
                            title={`Ignore ${filename}`}
                          >
                            Ignore
                          </button>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {ignoredPatterns.length > 0 && allFileHotspots.length > fileHotspots.length ? (
            <p className={isDark ? 'mt-3 text-xs text-slate-500' : 'mt-3 text-xs text-slate-400'}>
              Showing {fileHotspots.length} of {allFileHotspots.length} files ({allFileHotspots.length - fileHotspots.length} filtered)
            </p>
          ) : null}
        </div>
      </div>

      <div className={isDark ? 'rounded-xl border border-slate-700 bg-slate-800/40 p-4 text-sm text-slate-300' : 'rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600'}>
        <strong>Why This Is Fast:</strong> These statistics are computed instantly from{' '}
        <strong>{totalCommits.toLocaleString()} commits</strong> and{' '}
        <strong>{fileChanges.length.toLocaleString()} file changes</strong> stored locally via PowerSync.
        No API calls are made - all aggregations run against your local IndexedDB.
        On GitHub, rendering this would require paginating through the entire commit history via multiple API requests.
        As new commits sync from the backend, TanStack DB differential dataflow updates these aggregations incrementally.
      </div>
        </>
      )}

      {/* AUTHOR INSIGHTS */}
      {activeTab === 'author-insights' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          {/* Leaderboard - Left Panel */}
          <div className={cardClass}>
            <h4 className={subheadingClass}>Contributor Leaderboard</h4>
            <p className={isDark ? 'mb-4 text-xs text-slate-400' : 'mb-4 text-xs text-slate-500'}>
              Click an author to see their file hotspots across all branches
            </p>
            {contributorStats.length === 0 ? (
              <div className={emptyClass}>No contributor data available</div>
            ) : (
              <div className="max-h-[500px] overflow-auto space-y-1">
                {contributorStats.map((stat, index) => {
                  const isSelected = stat.author_email === selectedAuthorEmail
                  return (
                    <button
                      key={stat.author_email ?? index}
                      type="button"
                      onClick={() => setSelectedAuthorEmail(stat.author_email)}
                      className={
                        isSelected
                          ? isDark
                            ? 'w-full rounded-lg bg-emerald-500/20 p-3 text-left transition border border-emerald-500/30'
                            : 'w-full rounded-lg bg-emerald-50 p-3 text-left transition border border-emerald-200'
                          : isDark
                            ? 'w-full rounded-lg bg-slate-800/50 p-3 text-left transition hover:bg-slate-800 border border-transparent'
                            : 'w-full rounded-lg bg-slate-50 p-3 text-left transition hover:bg-slate-100 border border-transparent'
                      }
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className={isDark ? 'font-medium text-slate-100 truncate' : 'font-medium text-slate-800 truncate'}>
                            <span className={isDark ? 'text-slate-500 mr-2' : 'text-slate-400 mr-2'}>#{index + 1}</span>
                            {stat.author_name ?? 'Unknown'}
                          </div>
                          <div className={isDark ? 'text-xs text-slate-500 truncate' : 'text-xs text-slate-400 truncate'}>
                            {stat.author_email}
                          </div>
                        </div>
                        <div className="text-right text-xs whitespace-nowrap">
                          <div className={isDark ? 'font-medium text-slate-200' : 'font-medium text-slate-700'}>
                            {stat.commit_count} commits
                          </div>
                          <div>
                            <span className={additionsClass}>+{stat.total_additions.toLocaleString()}</span>
                            {' / '}
                            <span className={deletionsClass}>-{stat.total_deletions.toLocaleString()}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          {/* File Hotspots - Right Panel (2 cols) */}
          <div className={`${cardClass} lg:col-span-2`}>
            {!selectedAuthorEmail ? (
              <div className="flex h-full items-center justify-center">
                <div className={emptyClass}>Select an author from the leaderboard to view their file hotspots</div>
              </div>
            ) : (
              <>
                <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h4 className={subheadingClass}>
                      File Hotspots for {selectedAuthorStats?.author_name ?? selectedAuthorEmail}
                    </h4>
                    <p className={isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'}>
                      Most frequently changed files by this author across all branches
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedAuthorEmail(null)}
                    className={isDark
                      ? 'text-xs text-slate-500 hover:text-slate-300'
                      : 'text-xs text-slate-400 hover:text-slate-600'
                    }
                  >
                    Clear selection
                  </button>
                </div>

                {/* Author Stats Summary */}
                {selectedAuthorStats && (
                  <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                    <div className={statCardClass}>
                      <div className={statValueClass}>{selectedAuthorStats.commit_count}</div>
                      <div className={statLabelClass}>Commits</div>
                    </div>
                    <div className={statCardClass}>
                      <div className={statValueClass}>{authorFileHotspots.length}</div>
                      <div className={statLabelClass}>Files Touched</div>
                    </div>
                    <div className={statCardClass}>
                      <div className={`${statValueClass} ${additionsClass}`}>+{selectedAuthorStats.total_additions.toLocaleString()}</div>
                      <div className={statLabelClass}>Additions</div>
                    </div>
                    <div className={statCardClass}>
                      <div className={`${statValueClass} ${deletionsClass}`}>-{selectedAuthorStats.total_deletions.toLocaleString()}</div>
                      <div className={statLabelClass}>Deletions</div>
                    </div>
                  </div>
                )}

                {/* Ignore Patterns */}
                <div className="mb-4 flex flex-wrap items-center gap-1">
                  {ignoredPatterns.length > 0 ? (
                    <>
                      <span className={isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-400'}>Ignoring:</span>
                      {ignoredPatterns.map((pattern) => (
                        <button
                          key={pattern}
                          type="button"
                          onClick={() => setIgnoredPatterns((prev) => prev.filter((p) => p !== pattern))}
                          className={isDark
                            ? 'inline-flex items-center gap-1 rounded-full bg-slate-800 px-2 py-0.5 text-xs text-slate-300 transition hover:bg-slate-700'
                            : 'inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600 transition hover:bg-slate-200'
                          }
                          title={`Click to stop ignoring ${pattern}`}
                        >
                          {pattern}
                          <span className="text-[10px]">×</span>
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setIgnoredPatterns([])}
                        className={isDark
                          ? 'ml-1 text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline'
                          : 'ml-1 text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline'
                        }
                      >
                        Clear all
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setIgnoredPatterns(defaultIgnorePatterns)}
                      className={isDark
                        ? 'text-xs text-slate-500 underline-offset-2 hover:text-slate-300 hover:underline'
                        : 'text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline'
                      }
                    >
                      Reset default filters
                    </button>
                  )}
                </div>

                {/* File Hotspots Table */}
                {filteredAuthorFileHotspots.length === 0 ? (
                  <div className={emptyClass}>
                    {authorFileHotspots.length > 0
                      ? `All ${authorFileHotspots.length} files are filtered out. Try removing some ignore patterns.`
                      : 'No file change data available for this author'}
                  </div>
                ) : (
                  <div className="max-h-[400px] overflow-auto">
                    <table className="w-full text-left">
                      <thead>
                        <tr>
                          <th className={tableHeaderClass}>File</th>
                          <th className={tableHeaderClass}>Changes</th>
                          <th className={tableHeaderClass}>+/-</th>
                          <th className={tableHeaderClass} style={{ width: 60 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {filteredAuthorFileHotspots.slice(0, 50).map((hotspot, index) => {
                          const filename = (hotspot.path ?? '').split('/').pop() ?? hotspot.path ?? ''
                          return (
                            <tr key={hotspot.path ?? index}>
                              <td className={`${tableCellClass} max-w-xs truncate font-mono text-xs`} title={hotspot.path ?? ''}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setSelectedFilePath(hotspot.path)
                                    setActiveTab('blame-timeline')
                                  }}
                                  className={isDark
                                    ? 'text-left text-emerald-400 hover:text-emerald-300 hover:underline'
                                    : 'text-left text-emerald-600 hover:text-emerald-500 hover:underline'
                                  }
                                >
                                  {hotspot.path ?? 'unknown'}
                                </button>
                              </td>
                              <td className={tableCellClass}>{hotspot.change_count.toLocaleString()}</td>
                              <td className={tableCellClass}>
                                <span className={additionsClass}>+{hotspot.total_additions.toLocaleString()}</span>
                                {' / '}
                                <span className={deletionsClass}>-{hotspot.total_deletions.toLocaleString()}</span>
                              </td>
                              <td className={tableCellClass}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (filename && !ignoredPatterns.includes(filename)) {
                                      setIgnoredPatterns((prev) => [...prev, filename])
                                    }
                                  }}
                                  className={isDark
                                    ? 'rounded px-1.5 py-0.5 text-[10px] text-slate-500 transition hover:bg-slate-800 hover:text-slate-300'
                                    : 'rounded px-1.5 py-0.5 text-[10px] text-slate-400 transition hover:bg-slate-100 hover:text-slate-600'
                                  }
                                  title={`Ignore ${filename}`}
                                >
                                  Ignore
                                </button>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                    {filteredAuthorFileHotspots.length > 50 && (
                      <p className={isDark ? 'mt-3 text-xs text-slate-500' : 'mt-3 text-xs text-slate-400'}>
                        Showing 50 of {filteredAuthorFileHotspots.length} files
                      </p>
                    )}
                  </div>
                )}
                {ignoredPatterns.length > 0 && authorFileHotspots.length > filteredAuthorFileHotspots.length && (
                  <p className={isDark ? 'mt-3 text-xs text-slate-500' : 'mt-3 text-xs text-slate-400'}>
                    {authorFileHotspots.length - filteredAuthorFileHotspots.length} files filtered out
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* BLAME TIMELINE */}
      {activeTab === 'blame-timeline' && (
        <div className="space-y-4">
          <div className={cardClass}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h4 className={subheadingClass}>Blame Timeline</h4>
                <p className={isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'}>
                  See who changed a file over time with full commit history
                </p>
              </div>
              {selectedFilePath && (
                <button
                  type="button"
                  onClick={() => setSelectedFilePath(null)}
                  className={isDark
                    ? 'text-xs text-slate-500 hover:text-slate-300'
                    : 'text-xs text-slate-400 hover:text-slate-600'
                  }
                >
                  Clear selection
                </button>
              )}
            </div>

            {!selectedFilePath ? (
              <div>
                <p className={emptyClass + ' mb-4'}>Select a file to view its blame timeline</p>
                <input
                  type="text"
                  value={fileSearchQuery}
                  onChange={(e) => setFileSearchQuery(e.target.value)}
                  placeholder="Search files..."
                  className={isDark
                    ? 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none'
                    : 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none'
                  }
                />
                <div className="mt-2 flex flex-wrap gap-1 max-h-40 overflow-auto">
                  {filteredFilePaths.slice(0, 30).map((path) => (
                    <button
                      key={path}
                      type="button"
                      onClick={() => setSelectedFilePath(path)}
                      className={isDark
                        ? 'rounded-lg bg-slate-800 px-2 py-1 text-xs font-mono text-slate-300 transition hover:bg-slate-700 truncate max-w-xs'
                        : 'rounded-lg bg-slate-100 px-2 py-1 text-xs font-mono text-slate-600 transition hover:bg-slate-200 truncate max-w-xs'
                      }
                      title={path}
                    >
                      {path}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <div className={isDark
                  ? 'mb-4 rounded-lg bg-slate-800 px-3 py-2 font-mono text-sm text-emerald-300'
                  : 'mb-4 rounded-lg bg-slate-100 px-3 py-2 font-mono text-sm text-emerald-700'
                }>
                  {selectedFilePath}
                </div>

                {fileImpactData && (
                  <>
                    <div className="mb-4 grid grid-cols-2 gap-4 md:grid-cols-4">
                      <div className={statCardClass}>
                        <div className={statValueClass}>{fileImpactData.totalChanges}</div>
                        <div className={statLabelClass}>Total Changes</div>
                      </div>
                      <div className={statCardClass}>
                        <div className={statValueClass}>{fileImpactData.authorChanges.length}</div>
                        <div className={statLabelClass}>Contributors</div>
                      </div>
                    </div>

                    <h5 className={isDark ? 'mb-2 text-sm font-medium text-slate-200' : 'mb-2 text-sm font-medium text-slate-700'}>
                      Contributors to this file
                    </h5>
                    <div className="mb-4 max-h-48 overflow-auto">
                      <table className="w-full text-left">
                        <thead>
                          <tr>
                            <th className={tableHeaderClass}>Author</th>
                            <th className={tableHeaderClass}>Changes</th>
                            <th className={tableHeaderClass}>+/-</th>
                            <th className={tableHeaderClass}>Last Change</th>
                          </tr>
                        </thead>
                        <tbody>
                          {fileImpactData.authorChanges.map((author) => (
                            <tr key={author.email}>
                              <td className={tableCellClass}>
                                <div className="font-medium">{author.name}</div>
                                <div className={isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-400'}>
                                  {author.email}
                                </div>
                              </td>
                              <td className={tableCellClass}>{author.count}</td>
                              <td className={tableCellClass}>
                                <span className={additionsClass}>+{author.additions}</span>
                                {' / '}
                                <span className={deletionsClass}>-{author.deletions}</span>
                              </td>
                              <td className={tableCellClass}>
                                {author.lastChange ? author.lastChange.slice(0, 10) : '-'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <h5 className={isDark ? 'mb-2 text-sm font-medium text-slate-200' : 'mb-2 text-sm font-medium text-slate-700'}>
                      Commit History
                    </h5>
                    <div className="max-h-[500px] overflow-auto space-y-2">
                      {fileImpactData.commits.slice(0, 50).map((commit) => {
                        const change = fileImpactData.changesByCommit.get(commit.sha ?? '')
                        const sha = commit.sha ?? ''
                        const isExpanded = expandedBlameCommit === sha
                        const diffKey = `${sha}:${selectedFilePath}`
                        const diffState = blameDiffStates[diffKey]

                        return (
                          <div
                            key={sha}
                            className={isDark
                              ? 'rounded-lg border border-slate-700 bg-slate-800/50 p-3'
                              : 'rounded-lg border border-slate-200 bg-slate-50 p-3'
                            }
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0 flex-1">
                                <div className={isDark ? 'text-sm text-slate-100 truncate' : 'text-sm text-slate-800 truncate'}>
                                  {(commit.message ?? '').split('\n')[0] || '(no message)'}
                                </div>
                                <div className={isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-400'}>
                                  {commit.author_name} · {commit.authored_at?.slice(0, 10)} · <span className="font-mono">{sha.slice(0, 7)}</span>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <div className="text-right text-xs">
                                  <span className={additionsClass}>+{change?.additions ?? 0}</span>
                                  {' / '}
                                  <span className={deletionsClass}>-{change?.deletions ?? 0}</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setExpandedBlameCommit((prev) => (prev === sha ? null : sha))}
                                  className={isDark
                                    ? 'rounded-full border border-slate-600 px-2 py-0.5 text-[10px] font-medium text-slate-300 transition hover:bg-slate-700'
                                    : 'rounded-full border border-slate-300 px-2 py-0.5 text-[10px] font-medium text-slate-600 transition hover:bg-slate-200'
                                  }
                                >
                                  {isExpanded ? 'Hide diff' : 'View diff'}
                                </button>
                              </div>
                            </div>

                            {/* Diff View */}
                            {isExpanded && (
                              <div className="mt-3">
                                {!diffState || diffState.status === 'idle' || diffState.status === 'loading' ? (
                                  <div className={`flex items-center gap-2 text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                    <InlineSpinner size={12} color={isDark ? '#94a3b8' : '#64748b'} aria-label="Loading diff" />
                                    <span>Loading diff…</span>
                                  </div>
                                ) : diffState.status === 'error' ? (
                                  <div className={`text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                                    Failed to load diff: {diffState.message}
                                  </div>
                                ) : diffState.status === 'missing' || diffState.status === 'binary' || diffState.status === 'too_large' ? (
                                  <div className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                                    {diffState.message}
                                  </div>
                                ) : (
                                  <div className={isDark
                                    ? 'max-h-80 overflow-auto rounded-lg border border-slate-700 bg-slate-950 text-[12px] font-mono'
                                    : 'max-h-80 overflow-auto rounded-lg border border-slate-200 bg-slate-100 text-[12px] font-mono'
                                  }>
                                    {diffState.lines.map((line, idx) => (
                                      <div
                                        key={idx}
                                        className={
                                          line.type === 'add'
                                            ? isDark
                                              ? 'flex gap-2 bg-emerald-500/10 px-3 py-0.5 text-emerald-200'
                                              : 'flex gap-2 bg-emerald-50 px-3 py-0.5 text-emerald-800'
                                            : line.type === 'remove'
                                              ? isDark
                                                ? 'flex gap-2 bg-red-500/10 px-3 py-0.5 text-red-200'
                                                : 'flex gap-2 bg-red-50 px-3 py-0.5 text-red-800'
                                              : isDark
                                                ? 'flex gap-2 px-3 py-0.5 text-slate-300'
                                                : 'flex gap-2 px-3 py-0.5 text-slate-700'
                                        }
                                      >
                                        <span className="w-3 select-none text-[10px] opacity-60">
                                          {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ''}
                                        </span>
                                        <span className="whitespace-pre-wrap break-all">{line.text || ' '}</span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )
                      })}
                      {fileImpactData.commits.length > 50 && (
                        <p className={isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-400'}>
                          Showing 50 of {fileImpactData.commits.length} commits
                        </p>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* COMMIT SEARCH */}
      {activeTab === 'commit-search' && (
        <div className={cardClass}>
          <h4 className={subheadingClass}>Commit Search with Complex Filters</h4>
          <p className={isDark ? 'mb-4 text-xs text-slate-400' : 'mb-4 text-xs text-slate-500'}>
            Search across {totalCommits.toLocaleString()} commits with multiple combinable filters.
            All filtering happens instantly in your browser - no API calls needed.
          </p>

          <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            <div>
              <label className={isDark ? 'mb-1 block text-xs text-slate-400' : 'mb-1 block text-xs text-slate-500'}>
                Author (name or email)
              </label>
              <input
                type="text"
                value={searchFilters.author}
                onChange={(e) => setSearchFilters((prev) => ({ ...prev, author: e.target.value }))}
                placeholder="e.g. john"
                className={isDark
                  ? 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none'
                  : 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none'
                }
              />
            </div>
            <div>
              <label className={isDark ? 'mb-1 block text-xs text-slate-400' : 'mb-1 block text-xs text-slate-500'}>
                Commit message contains
              </label>
              <input
                type="text"
                value={searchFilters.message}
                onChange={(e) => setSearchFilters((prev) => ({ ...prev, message: e.target.value }))}
                placeholder="e.g. fix bug"
                className={isDark
                  ? 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none'
                  : 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none'
                }
              />
            </div>
            <div>
              <label className={isDark ? 'mb-1 block text-xs text-slate-400' : 'mb-1 block text-xs text-slate-500'}>
                File path contains
              </label>
              <input
                type="text"
                value={searchFilters.filePath}
                onChange={(e) => setSearchFilters((prev) => ({ ...prev, filePath: e.target.value }))}
                placeholder="e.g. src/components"
                className={isDark
                  ? 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none'
                  : 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none'
                }
              />
            </div>
            <div>
              <label className={isDark ? 'mb-1 block text-xs text-slate-400' : 'mb-1 block text-xs text-slate-500'}>
                Date from
              </label>
              <input
                type="date"
                value={searchFilters.dateFrom}
                onChange={(e) => setSearchFilters((prev) => ({ ...prev, dateFrom: e.target.value }))}
                className={isDark
                  ? 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none'
                  : 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none'
                }
              />
            </div>
            <div>
              <label className={isDark ? 'mb-1 block text-xs text-slate-400' : 'mb-1 block text-xs text-slate-500'}>
                Date to
              </label>
              <input
                type="date"
                value={searchFilters.dateTo}
                onChange={(e) => setSearchFilters((prev) => ({ ...prev, dateTo: e.target.value }))}
                className={isDark
                  ? 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none'
                  : 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none'
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={isDark ? 'mb-1 block text-xs text-slate-400' : 'mb-1 block text-xs text-slate-500'}>
                  Min additions
                </label>
                <input
                  type="number"
                  value={searchFilters.minAdditions}
                  onChange={(e) => setSearchFilters((prev) => ({ ...prev, minAdditions: e.target.value }))}
                  placeholder="0"
                  min="0"
                  className={isDark
                    ? 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none'
                    : 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none'
                  }
                />
              </div>
              <div>
                <label className={isDark ? 'mb-1 block text-xs text-slate-400' : 'mb-1 block text-xs text-slate-500'}>
                  Max additions
                </label>
                <input
                  type="number"
                  value={searchFilters.maxAdditions}
                  onChange={(e) => setSearchFilters((prev) => ({ ...prev, maxAdditions: e.target.value }))}
                  placeholder="∞"
                  min="0"
                  className={isDark
                    ? 'w-full rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-500 focus:outline-none'
                    : 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:border-emerald-500 focus:outline-none'
                  }
                />
              </div>
            </div>
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setSearchFilters({
                author: '',
                message: '',
                filePath: '',
                dateFrom: '',
                dateTo: '',
                minAdditions: '',
                maxAdditions: '',
                minDeletions: '',
                maxDeletions: '',
              })}
              className={isDark
                ? 'rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-400 transition hover:bg-slate-800'
                : 'rounded-lg border border-slate-300 px-3 py-1.5 text-xs text-slate-500 transition hover:bg-slate-100'
              }
            >
              Clear all filters
            </button>
            {searchResults && (
              <span className={isDark ? 'text-sm text-emerald-400' : 'text-sm text-emerald-600'}>
                Found {searchResults.length.toLocaleString()} matching commits
              </span>
            )}
          </div>

          {!searchResults ? (
            <div className={emptyClass}>
              Enter at least one filter to search commits
            </div>
          ) : searchResults.length === 0 ? (
            <div className={emptyClass}>
              No commits match your filters
            </div>
          ) : (
            <div className="max-h-96 overflow-auto space-y-2">
              {searchResults.slice(0, 100).map((commit) => {
                const agg = commitAggregates.get(commit.sha ?? '')
                return (
                  <div
                    key={commit.sha}
                    className={isDark
                      ? 'rounded-lg border border-slate-700 bg-slate-800/50 p-3'
                      : 'rounded-lg border border-slate-200 bg-slate-50 p-3'
                    }
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <div className={isDark ? 'text-sm text-slate-100' : 'text-sm text-slate-800'}>
                          {(commit.message ?? '').split('\n')[0] || '(no message)'}
                        </div>
                        <div className={isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-400'}>
                          <span className="font-medium">{commit.author_name}</span>
                          {' · '}
                          {commit.authored_at?.slice(0, 10)}
                          {' · '}
                          <span className="font-mono">{commit.sha?.slice(0, 7)}</span>
                        </div>
                      </div>
                      <div className="text-right text-xs whitespace-nowrap">
                        <span className={additionsClass}>+{agg?.additions ?? 0}</span>
                        {' / '}
                        <span className={deletionsClass}>-{agg?.deletions ?? 0}</span>
                        <div className={isDark ? 'text-slate-500' : 'text-slate-400'}>
                          {agg?.files.length ?? 0} files
                        </div>
                      </div>
                    </div>
                  </div>
                )
              })}
              {searchResults.length > 100 && (
                <p className={isDark ? 'text-xs text-slate-500' : 'text-xs text-slate-400'}>
                  Showing 100 of {searchResults.length} matching commits
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export { Analytics as AnalyticsComponent }
