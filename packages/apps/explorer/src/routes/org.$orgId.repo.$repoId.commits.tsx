
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'
import { useTheme } from '../ui/theme-context'

type BranchRow = Pick<Database['refs'], 'name' | 'target_sha'>
type CommitRow = Pick<Database['commits'], 'sha' | 'author_name' | 'authored_at' | 'message'>

export const Route = createFileRoute('/org/$orgId/repo/$repoId/commits' as any)({
  component: Commits,
})

function Commits() {
  const { orgId, repoId } = Route.useParams()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  useRepoStreams(orgId, repoId)
  const fixture = useRepoFixture(orgId, repoId)
  if (import.meta.env.DEV) {
    console.debug('[Commits] render', orgId, repoId, fixture, (window as typeof window & { __powersyncGetRepoFixtures?: () => unknown }).__powersyncGetRepoFixtures?.())
  }

  const { commits: commitsCollection, refs } = useCollections()
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

  const commits = fixture?.commits?.length ? fixture.commits : liveCommits

  const branchOptions = React.useMemo(
    () =>
      (fixture?.branches?.length ? fixture.branches : branchRows)
        .filter((branch) => branch.name && branch.target_sha)
        .map((branch) => ({
          name: branch.name!,
          targetSha: branch.target_sha!,
        })),
    [branchRows, fixture],
  )

  const authorOptions = React.useMemo(() => {
    const labels = new Set<string>()
    for (const commit of commits) {
      const normalized = (commit.author_name ?? 'Unknown').trim() || 'Unknown'
      labels.add(normalized)
    }
    return Array.from(labels).sort((a, b) => a.localeCompare(b))
  }, [commits])

  const [branchFilter, setBranchFilter] = React.useState<string>('all')
  const [authorFilter, setAuthorFilter] = React.useState<string>('all')
  const [fromDate, setFromDate] = React.useState<string>('')
  const [toDate, setToDate] = React.useState<string>('')

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

  const resetFilters = React.useCallback(() => {
    setBranchFilter('all')
    setAuthorFilter('all')
    setFromDate('')
    setToDate('')
  }, [])

  const filteredCommits = React.useMemo(() => {
    const branchMap = new Map(branchOptions.map((branch) => [branch.name, branch.targetSha]))
    const fromTime = fromDate ? Date.parse(fromDate) : null
    const toTime = toDate ? Date.parse(toDate) : null

    return commits.filter((commit) => {
      if (branchFilter !== 'all') {
        const branchSha = branchMap.get(branchFilter)
        if (!branchSha || commit.sha !== branchSha) {
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

  return (
    <div className="mx-auto max-w-6xl space-y-4" data-testid="commit-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className={headingClass} data-testid="commit-heading">
          Commits ({orgId}/{repoId})
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
        {filteredCommits.map((c) => (
          <li key={c.sha ?? ''} className={itemClass} data-testid="commit-item">
            <div className={metaClass}>
              {c.authored_at ?? 'unknown'} — <span className={shaClass}>{c.sha?.slice(0, 7) ?? '———'}</span>
            </div>
            <div className={messageClass}>{c.message ?? '(no message)'}</div>
            <div className={authorClass}>{c.author_name ?? '—'}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export { Commits as CommitsComponent }
