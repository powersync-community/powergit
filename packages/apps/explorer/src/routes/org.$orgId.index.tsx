
import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useCollections } from '@tsdb/collections'
import { useOrgStreams } from '@ps/streams'
import type { Database } from '@ps/schema'
import { useTheme } from '../ui/theme-context'

export const Route = createFileRoute('/org/$orgId/' as any)({
  component: OrgActivity,
})

export function OrgActivity() {
  const { orgId } = Route.useParams()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const { refs } = useCollections()
  type RefRow = Pick<Database['refs'], 'org_id' | 'repo_id' | 'name' | 'target_sha' | 'updated_at'>
  const { data: rows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ r: refs })
        .where(({ r }) => eq(r.org_id, orgId))
        .select(({ r }) => ({
          org_id: r.org_id,
          repo_id: r.repo_id,
          name: r.name,
          target_sha: r.target_sha,
          updated_at: r.updated_at,
        })),
    [refs, orgId],
  ) as { data: Array<RefRow> }

  const repoIds = React.useMemo(() => {
    if (rows.length === 0) return [] as string[]
    return Array.from(new Set(rows.map((ref) => ref.repo_id ?? '').filter(Boolean)))
  }, [rows])
  useOrgStreams(orgId, repoIds)

  const grouped = React.useMemo(() => {
    const map = new Map<
      string,
      {
        branches: Array<{
          name: string | null
          targetSha: string | null
          updatedAt: string | null
        }>
      }
    >()
    for (const row of rows) {
      const repoId = row.repo_id ?? ''
      if (!repoId) continue
      const entry = map.get(repoId) ?? { branches: [] }
      entry.branches.push({
        name: row.name ?? null,
        targetSha: row.target_sha ?? null,
        updatedAt: row.updated_at ?? null,
      })
      map.set(repoId, entry)
    }
    return Array.from(map.entries()).map(([repoId, value]) => ({
      repoId,
      branches: value.branches.sort((a, b) => {
        const safeA = a.updatedAt ?? ''
        const safeB = b.updatedAt ?? ''
        if (safeA === safeB) return 0
        return safeA > safeB ? -1 : 1
      }),
    }))
  }, [rows])

  const isLoading = rows.length === 0

  const headingClass = isDark ? 'text-xl font-semibold text-slate-100' : 'text-xl font-semibold text-slate-900'
  const loadingClass = isDark
    ? 'rounded-lg border border-dashed border-slate-700/70 bg-slate-900/60 px-4 py-6 text-center text-sm text-slate-300 shadow-inner shadow-slate-900/40'
    : 'rounded-lg border border-dashed border-slate-300 bg-white/70 px-4 py-6 text-center text-sm text-slate-500'
  const repoCardClass = isDark
    ? 'rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-4 shadow-lg shadow-slate-900/40'
    : 'rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm'
  const repoTitleClass = isDark ? 'text-lg font-semibold text-slate-100' : 'text-lg font-semibold text-slate-900'
  const repoBadgeLabel = isDark ? 'text-xs uppercase tracking-wide text-slate-400' : 'text-xs uppercase tracking-wide text-slate-500'
  const repoLinkClass = isDark
    ? 'text-sm font-medium text-emerald-300 hover:text-emerald-200'
    : 'text-sm font-medium text-emerald-600 hover:text-emerald-500'
  const branchItemClass = isDark
    ? 'flex items-center justify-between rounded-lg bg-slate-800/60 px-3 py-2 text-slate-200'
    : 'flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-slate-600'
  const branchNameClass = isDark ? 'font-medium text-slate-100' : 'font-medium text-slate-800'
  const branchTimestampClass = isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'
  const branchShaClass = isDark ? 'font-mono text-xs text-slate-300' : 'font-mono text-xs text-slate-500'

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <h2 className={headingClass}>Org: {orgId} — Activity</h2>
      {isLoading ? (
        <div className={loadingClass}>Loading repository refs…</div>
      ) : (
        <ul className="space-y-3">
          {grouped.map((repo) => (
            <li key={repo.repoId} className={repoCardClass}>
              <div className="flex items-baseline justify-between">
                <div>
                  <h3 className={repoTitleClass}>{repo.repoId}</h3>
                  <p className={repoBadgeLabel}>Tracked branches</p>
                </div>
                <Link
                  className={repoLinkClass}
                  to="/org/$orgId/repo/$repoId"
                  params={{ orgId, repoId: repo.repoId }}
                >
                  Open repo →
                </Link>
              </div>
              <ul className="mt-3 space-y-1 text-sm">
                {repo.branches.map((branch, index) => (
                  <li key={`${branch.name ?? 'branch'}-${index}`} className={branchItemClass}>
                    <div>
                      <div className={branchNameClass}>{branch.name ?? '(unnamed ref)'}</div>
                      <div className={branchTimestampClass}>
                        {branch.updatedAt ? new Date(branch.updatedAt).toLocaleString() : '—'}
                      </div>
                    </div>
                    <span className={branchShaClass}>{branch.targetSha?.slice(0, 7) ?? '———'}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export { OrgActivity as OrgActivityComponent }
