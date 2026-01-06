import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'
import { useTheme } from '../ui/theme-context'
import { BreadcrumbChips } from '../components/BreadcrumbChips'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/analytics' as any)({
  component: Analytics,
})

type CommitRow = Pick<Database['commits'], 'sha' | 'author_name' | 'author_email' | 'authored_at'>
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

function Analytics() {
  const { orgId, repoId } = Route.useParams()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  useRepoStreams(orgId, repoId)
  const fixture = useRepoFixture(orgId, repoId)

  const {
    commits: commitsCollection,
    file_changes: fileChangesCollection,
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

  // File hotspot ignore patterns - demonstrates reactive filtering
  const defaultIgnorePatterns = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'CHANGELOG.md', 'CHANGELOG']
  const [ignoredPatterns, setIgnoredPatterns] = React.useState<string[]>(defaultIgnorePatterns)

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
            {dailyActivity.map((day) => (
              <div
                key={day.date}
                className="group relative flex-shrink-0"
                style={{ width: Math.max(4, Math.floor(800 / dailyActivity.length)) }}
              >
                <div
                  className={`${barClass} w-full rounded-t transition-all hover:opacity-80`}
                  style={{ height: `${(day.commit_count / maxDailyCommits) * 100}%`, minHeight: 2 }}
                  title={`${day.date}: ${day.commit_count} commit${day.commit_count === 1 ? '' : 's'}`}
                />
                <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-800 px-2 py-1 text-xs text-white group-hover:block">
                  {day.date}: {day.commit_count}
                </div>
              </div>
            ))}
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
                    <tr key={stat.author_email ?? index}>
                      <td className={tableCellClass}>{index + 1}</td>
                      <td className={tableCellClass}>
                        <div className="font-medium">{stat.author_name ?? 'Unknown'}</div>
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
                          {hotspot.path ?? 'unknown'}
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
    </div>
  )
}

export { Analytics as AnalyticsComponent }
