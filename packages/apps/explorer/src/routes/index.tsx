
import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useCollections } from '@tsdb/collections'
import { GithubImportCard } from '../components/GithubImportCard'
import type { Database } from '@ps/schema'
import { useTheme } from '../ui/theme-context'

export const Route = createFileRoute('/' as any)({
  component: Home,
})

export function Home() {
  const { theme } = useTheme()
  const { refs } = useCollections()
  type RefRow = Pick<Database['refs'], 'org_id' | 'repo_id' | 'name' | 'updated_at'>
  const { data: refRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ r: refs })
        .select(({ r }) => ({
          org_id: r.org_id,
          repo_id: r.repo_id,
          name: r.name,
          updated_at: r.updated_at,
        })),
    [refs],
  ) as { data: Array<RefRow> }

  const repoSummaries = React.useMemo(() => {
    const map = new Map<
      string,
      {
        orgId: string
        repoId: string
        branches: Set<string>
        updatedAt: string | null
      }
    >()

    for (const row of refRows) {
      const orgId = row.org_id?.trim()
      const repoId = row.repo_id?.trim()
      if (!orgId || !repoId) continue
      const key = `${orgId}/${repoId}`
      const entry =
        map.get(key) ?? { orgId, repoId, branches: new Set<string>(), updatedAt: null }
      if (row.name) {
        entry.branches.add(row.name)
      }
      if (row.updated_at) {
        if (!entry.updatedAt || entry.updatedAt < row.updated_at) {
          entry.updatedAt = row.updated_at
        }
      }
      map.set(key, entry)
    }

    return Array.from(map.values()).sort((a, b) => {
      const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0
      const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0
      if (aTime === bTime) {
        return `${a.orgId}/${a.repoId}`.localeCompare(`${b.orgId}/${b.repoId}`)
      }
      return bTime - aTime
    })
  }, [refRows])

  const formatTimestamp = React.useCallback((iso: string | null | undefined) => {
    if (!iso) return '–'
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }, [])

  const isDark = theme === 'dark'
  const repoCardBase = isDark
    ? 'group flex items-center justify-between rounded-2xl border border-slate-700 bg-slate-900 px-5 py-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-900/40'
    : 'group flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg'
  const repoBadge = isDark
    ? 'rounded-full bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300'
    : 'rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600'
  const openButtonClasses = isDark
    ? 'inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <GithubImportCard />

      <section className="space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className={`text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              Recently explored repositories
            </h2>
          </div>
          <span className={repoBadge}>
            {repoSummaries.length} repo{repoSummaries.length === 1 ? '' : 's'}
          </span>
        </header>

        {repoSummaries.length === 0 ? (
          <div
            className={`rounded-2xl border border-dashed px-6 py-8 text-center text-sm ${
              isDark ? 'border-slate-700 text-slate-400 bg-slate-900/60' : 'border-slate-200 text-slate-500 bg-white/80'
            }`}
          >
            <p>
              Nothing here yet.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {repoSummaries.map((repo) => {
              const branchCount = Array.from(repo.branches).filter((name) => name && name !== 'HEAD').length
              const repoKey = `${repo.orgId}/${repo.repoId}`
              return (
                <li key={repoKey} className={repoCardBase}>
                  <div className="space-y-1">
                    <div className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                      {repo.orgId}
                      <span className="text-slate-400">/</span>
                      {repo.repoId}
                    </div>
                    <div className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                      {branchCount} branch{branchCount === 1 ? '' : 'es'} · Updated {formatTimestamp(repo.updatedAt)}
                    </div>
                  </div>
                  <Link
                    to="/org/$orgId/repo/$repoId/files"
                    params={{ orgId: repo.orgId, repoId: repo.repoId }}
                    className={openButtonClasses}
                    data-testid="repository-open-button"
                  >
                    Open
                    <span
                      aria-hidden
                      className={`${
                        isDark ? 'text-slate-500 group-hover:text-slate-300' : 'text-slate-400 group-hover:text-slate-500'
                      }`}
                    >
                      →
                    </span>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

export { Home as HomeComponent }
