import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { diffLines } from 'diff'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'
import { gitStore } from '@ps/git-store'
import { useTheme } from '../ui/theme-context'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/commits' as any)({
  component: Commits,
})

const decoder = 'TextDecoder' in globalThis ? new TextDecoder('utf-8') : null
const MAX_DIFF_PREVIEW_BYTES = 200_000
const DIFF_SNIPPET_LIMIT = 2_000

type BranchRow = Pick<Database['refs'], 'name' | 'target_sha'>
type CommitRow = Pick<Database['commits'], 'sha' | 'author_name' | 'authored_at' | 'message'>
type FileChangeRow = Pick<Database['file_changes'], 'commit_sha' | 'path' | 'additions' | 'deletions'>

type DiffLine = {
  type: 'context' | 'add' | 'remove'
  text: string
}

type DiffFilePreview =
  | {
      path: string
      additions: number
      deletions: number
      status: 'text'
      lines: DiffLine[]
    }
  | {
      path: string
      additions: number
      deletions: number
      status: 'binary' | 'missing' | 'too_large'
      message: string
    }

type CommitDiffState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; files: DiffFilePreview[] }

function Commits() {
  const { orgId, repoId } = Route.useParams()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  useRepoStreams(orgId, repoId)
  const fixture = useRepoFixture(orgId, repoId)

  const { commits: commitsCollection, refs, file_changes: fileChangesCollection } = useCollections()

  const { data: liveCommits = [] } = useLiveQuery(
    (q) =>
      q
        .from({ c: commitsCollection })
        .where(({ c }) => eq(c.org_id, orgId))
        .where(({ c }) => eq(c.repo_id, repoId))
        .orderBy(({ c }) => c.authored_at ?? '', 'desc'),
    [commitsCollection, orgId, repoId],
  ) as { data: Array<CommitRow> }

  const { data: branchRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ r: refs })
        .where(({ r }) => eq(r.org_id, orgId))
        .where(({ r }) => eq(r.repo_id, repoId)),
    [refs, orgId, repoId],
  ) as { data: Array<BranchRow> }

  const { data: liveFileChanges = [] } = useLiveQuery(
    (q) =>
      q
        .from({ f: fileChangesCollection })
        .where(({ f }) => eq(f.org_id, orgId))
        .where(({ f }) => eq(f.repo_id, repoId)),
    [fileChangesCollection, orgId, repoId],
  ) as { data: Array<FileChangeRow> }

  const commits = fixture?.commits?.length ? fixture.commits : liveCommits
  const branchOptions = React.useMemo(() => {
    const source = fixture?.branches?.length ? fixture.branches : branchRows
    return source
      .filter((branch) => branch.name && branch.target_sha)
      .map((branch) => ({ name: branch.name!, targetSha: branch.target_sha! }))
  }, [branchRows, fixture])

  const authorOptions = React.useMemo(() => {
    const labels = new Set<string>()
    for (const commit of commits) {
      const normalized = (commit.author_name ?? 'Unknown').trim() || 'Unknown'
      labels.add(normalized)
    }
    return Array.from(labels).sort((a, b) => a.localeCompare(b))
  }, [commits])

  const repoFileChanges = fixture?.fileChanges?.length ? fixture.fileChanges : liveFileChanges
  const fileChangesByCommit = React.useMemo(() => {
    const map = new Map<string, Array<FileChangeRow>>()
    for (const row of repoFileChanges) {
      if (!row.commit_sha) continue
      const list = map.get(row.commit_sha) ?? []
      list.push(row)
      map.set(row.commit_sha, list)
    }
    return map
  }, [repoFileChanges])

  const [branchFilter, setBranchFilter] = React.useState<string>('all')
  const [authorFilter, setAuthorFilter] = React.useState<string>('all')
  const [fromDate, setFromDate] = React.useState<string>('')
  const [toDate, setToDate] = React.useState<string>('')
  const [expandedCommit, setExpandedCommit] = React.useState<string | null>(null)
  const [diffStates, setDiffStates] = React.useState<Record<string, CommitDiffState>>({})

  React.useEffect(() => {
    if (branchFilter === 'all') return
    if (!branchOptions.some((branch) => branch.name === branchFilter)) {
      setBranchFilter('all')
    }
  }, [branchFilter, branchOptions])

  React.useEffect(() => {
    if (authorFilter === 'all') return
    if (!authorOptions.includes(authorFilter)) {
      setAuthorFilter('all')
    }
  }, [authorFilter, authorOptions])

  React.useEffect(() => {
    if (!expandedCommit) return
    const isVisible = commits.some((commit) => commit.sha === expandedCommit)
    if (!isVisible) {
      setExpandedCommit(null)
    }
  }, [commits, expandedCommit])

  const resetFilters = React.useCallback(() => {
    setBranchFilter('all')
    setAuthorFilter('all')
    setFromDate('')
    setToDate('')
    setExpandedCommit(null)
  }, [])

  const filteredCommits = React.useMemo(() => {
    const branchMap = new Map(branchOptions.map((branch) => [branch.name, branch.targetSha]))
    const fromTime = fromDate ? Date.parse(fromDate) : null
    const toTime = toDate ? Date.parse(toDate) : null

    return commits.filter((commit) => {
      if (branchFilter !== 'all') {
        const branchSha = branchMap.get(branchFilter)
        if (!branchSha || branchSha !== commit.sha) {
          return false
        }
      }

      if (authorFilter !== 'all') {
        const normalized = (commit.author_name ?? 'Unknown').trim() || 'Unknown'
        if (normalized !== authorFilter) {
          return false
        }
      }

      if (fromTime || toTime) {
        if (!commit.authored_at) return false
        const authored = Date.parse(commit.authored_at)
        if (Number.isNaN(authored)) return false
        if (fromTime && authored < fromTime) return false
        if (toTime) {
          const endOfDay = toTime + (24 * 60 * 60 * 1000 - 1)
          if (authored > endOfDay) return false
        }
      }

      return true
    })
  }, [authorFilter, branchFilter, branchOptions, commits, fromDate, toDate])

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

  const loadCommitDiff = React.useCallback(
    async (commitSha: string): Promise<DiffFilePreview[]> => {
      const changeRows = fileChangesByCommit.get(commitSha) ?? []
      const { parents } = await gitStore.getCommitInfo(commitSha)
      const parentSha = parents?.[0] ?? null

      const files: DiffFilePreview[] = []
      for (const change of changeRows) {
        const additions = change.additions ?? 0
        const deletions = change.deletions ?? 0
        const path = change.path ?? ''
        if (!path) continue

        let nextBytes: Uint8Array | null = null
        let prevBytes: Uint8Array | null = null

        try {
          const result = await gitStore.readFile(commitSha, path)
          nextBytes = result.content
        } catch {
          nextBytes = null
        }

        if (parentSha) {
          try {
            const prevResult = await gitStore.readFile(parentSha, path)
            prevBytes = prevResult.content
          } catch {
            prevBytes = null
          }
        }

        if (!nextBytes && !prevBytes) {
          files.push({
            path,
            additions,
            deletions,
            status: 'missing',
            message: 'File contents unavailable in this replica.',
          })
          continue
        }

        const candidate = nextBytes ?? prevBytes
        if (candidate && candidate.length > MAX_DIFF_PREVIEW_BYTES) {
          files.push({
            path,
            additions,
            deletions,
            status: 'too_large',
            message: 'File is too large for inline preview.',
          })
          continue
        }

        if ((nextBytes && isLikelyBinary(nextBytes)) || (prevBytes && isLikelyBinary(prevBytes))) {
          files.push({
            path,
            additions,
            deletions,
            status: 'binary',
            message: 'Binary file — download to inspect locally.',
          })
          continue
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

        files.push({ path, additions, deletions, status: 'text', lines })
      }

      return files
    },
    [decodeContent, fileChangesByCommit, isLikelyBinary],
  )

  React.useEffect(() => {
    if (!expandedCommit) return
    if (diffStates[expandedCommit]?.status === 'ready' || diffStates[expandedCommit]?.status === 'loading') return

    let cancelled = false
    setDiffStates((prev) => ({ ...prev, [expandedCommit]: { status: 'loading' } }))

    loadCommitDiff(expandedCommit)
      .then((files) => {
        if (cancelled) return
        setDiffStates((prev) => ({ ...prev, [expandedCommit]: { status: 'ready', files } }))
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        if (cancelled) return
        setDiffStates((prev) => ({ ...prev, [expandedCommit]: { status: 'error', message } }))
      })

    return () => {
      cancelled = true
    }
  }, [expandedCommit, diffStates, loadCommitDiff])

  const headingClass = isDark ? 'text-lg font-semibold text-slate-100' : 'text-lg font-semibold text-slate-900'
  const itemClass = isDark
    ? 'space-y-2 rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-200 shadow-sm shadow-slate-900/40'
    : 'space-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm'
  const metaClass = isDark ? 'text-sm text-slate-400' : 'text-sm text-slate-500'
  const messageClass = isDark ? 'text-base font-medium text-slate-100' : 'text-base font-medium text-slate-900'
  const authorClass = isDark ? 'text-sm text-slate-300' : 'text-sm text-slate-600'
  const shaClass = isDark ? 'font-mono text-slate-300' : 'font-mono text-slate-600'
  const toolbarClass = isDark
    ? 'rounded-3xl border border-slate-700 bg-slate-900 px-6 py-5 text-slate-100 shadow-xl shadow-slate-900/40'
    : 'rounded-3xl border border-slate-200 bg-white px-6 py-5 text-slate-900 shadow-lg'
  const controlGroupClass = 'flex flex-col gap-1 text-xs uppercase tracking-wide'
  const selectClass = isDark
    ? 'rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 focus:border-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
  const dateInputClass = isDark
    ? 'rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
  const resetButtonClass = isDark
    ? 'inline-flex items-center rounded-full border border-slate-600 px-3 py-1 text-xs font-medium text-slate-200 transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'inline-flex items-center rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'

  const diffContainerClass = isDark
    ? 'space-y-3 rounded-2xl border border-slate-700 bg-slate-900/60 p-4 text-sm'
    : 'space-y-3 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm'
  const diffHeaderClass = 'flex flex-wrap items-center justify-between gap-2 text-xs font-medium'
  const diffStatsClass = isDark ? 'text-slate-400' : 'text-slate-500'
  const diffBlockClass = isDark
    ? 'max-h-[60vh] overflow-auto rounded-xl border border-slate-700 bg-slate-950/70 font-mono text-[13px]'
    : 'max-h-[60vh] overflow-auto rounded-xl border border-slate-200 bg-slate-900/5 font-mono text-[13px]'

  const diffLineClass = (type: DiffLine['type']) => {
    const base = 'flex gap-3 px-4 py-1 whitespace-pre-wrap'
    if (type === 'add') {
      return `${base} ${isDark ? 'bg-emerald-500/10 text-emerald-100' : 'bg-emerald-50 text-emerald-800'}`
    }
    if (type === 'remove') {
      return `${base} ${isDark ? 'bg-red-500/10 text-red-100' : 'bg-red-50 text-red-800'}`
    }
    return `${base} ${isDark ? 'text-slate-200' : 'text-slate-700'}`
  }

  const renderDiff = (commitSha: string) => {
    const state = diffStates[commitSha]
    if (!state || state.status === 'idle') return null
    if (state.status === 'loading') {
      return <div className={diffContainerClass}>Loading diff…</div>
    }
    if (state.status === 'error') {
      return <div className={diffContainerClass}>Failed to load diff: {state.message}</div>
    }
    if (state.files.length === 0) {
      return <div className={diffContainerClass}>No tracked file changes for this commit.</div>
    }
    return (
      <div className={diffContainerClass}>
        {state.files.map((file) => (
          <div key={`${commitSha}-${file.path}`} className="space-y-2" data-testid="commit-diff-file">
            <div className={diffHeaderClass}>
              <span>{file.path}</span>
              <span className={diffStatsClass}>+{file.additions} / -{file.deletions}</span>
            </div>
            {file.status === 'text' ? (
              <div className={diffBlockClass}>
                {file.lines.map((line, index) => (
                  <div key={`${file.path}-line-${index}`} className={diffLineClass(line.type)}>
                    <span className="w-4 select-none text-xs">
                      {line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ''}
                    </span>
                    <span className="flex-1">{line.text || ' '}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className={`${diffBlockClass} flex items-center px-4 py-3 text-xs ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
                {file.message}
              </div>
            )}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="commit-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className={headingClass} data-testid="commit-heading">
          {repoId} - Commits
        </h3>
        <span className={isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'}>
          Showing {filteredCommits.length} commit{filteredCommits.length === 1 ? '' : 's'}
        </span>
      </div>

      <div className={toolbarClass}>
        <div className="flex flex-wrap items-end gap-4">
          <label className={controlGroupClass}>
            <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Branch</span>
            <select
              className={selectClass}
              value={branchFilter}
              onChange={(event) => setBranchFilter(event.target.value)}
              data-testid="commit-branch-filter"
            >
              <option value="all">All branches</option>
              {branchOptions.map((branch) => (
                <option key={branch.name} value={branch.name}>
                  {branch.name.replace(/^refs\/heads\//, '')}
                </option>
              ))}
            </select>
          </label>

          <label className={controlGroupClass}>
            <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>Author</span>
            <select
              className={selectClass}
              value={authorFilter}
              onChange={(event) => setAuthorFilter(event.target.value)}
              data-testid="commit-author-filter"
            >
              <option value="all">All contributors</option>
              {authorOptions.map((author) => (
                <option key={author} value={author}>
                  {author}
                </option>
              ))}
            </select>
          </label>

          <label className={controlGroupClass}>
            <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>From</span>
            <input
              type="date"
              className={dateInputClass}
              value={fromDate}
              onChange={(event) => setFromDate(event.target.value)}
              data-testid="commit-date-from"
            />
          </label>

          <label className={controlGroupClass}>
            <span className={isDark ? 'text-slate-400' : 'text-slate-500'}>To</span>
            <input
              type="date"
              className={dateInputClass}
              value={toDate}
              onChange={(event) => setToDate(event.target.value)}
              data-testid="commit-date-to"
            />
          </label>

          <button
            type="button"
            onClick={resetFilters}
            className={resetButtonClass}
            data-testid="commit-filter-reset"
          >
            Reset filters
          </button>
        </div>
      </div>

      <ul className="space-y-2" data-testid="commit-list">
        {filteredCommits.map((commit) => {
          const sha = commit.sha ?? ''
          const isExpanded = expandedCommit === sha
          return (
            <li key={sha} className={itemClass} data-testid="commit-item">
              <div className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div>
                    <div className={messageClass}>{commit.message ?? '(no message)'}</div>
                    <div className={metaClass}>
                      {commit.authored_at ?? 'unknown'} — <span className={shaClass}>{sha.slice(0, 7) || '———'}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => setExpandedCommit((prev) => (prev === sha ? null : sha))}
                    className="inline-flex items-center rounded-full border border-slate-400/40 px-3 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40 dark:border-slate-600 dark:text-slate-200 dark:hover:bg-slate-800"
                    data-testid="commit-diff-toggle"
                  >
                    {isExpanded ? 'Hide changes' : 'View changes'}
                  </button>
                </div>
                <div className={authorClass}>{commit.author_name ?? '—'}</div>
              </div>
              {isExpanded ? renderDiff(sha) : null}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

export { Commits as CommitsComponent }
