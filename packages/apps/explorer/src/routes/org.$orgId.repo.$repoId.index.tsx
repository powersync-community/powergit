
import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useRepoStreams } from '@ps/streams'
import { useCollections } from '@tsdb/collections'
import { useLiveQuery } from '@tanstack/react-db'
import type { Database } from '@ps/schema'
import { useTheme } from '../ui/theme-context'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/' as any)({
  component: RepoOverview,
})

function RepoOverview() {
  const { orgId, repoId } = Route.useParams()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  useRepoStreams(orgId, repoId)
  const { refs } = useCollections()

  // Temporarily disabled due to TanStack DB 0.4.3 API changes
  // const { data } = useLiveQuery(q =>
  //   q.from({ r: refs })
  //   .where(({ r }) => r.org_id === orgId)
  //   .where(({ r }) => r.repo_id === repoId)
  //    .select(({ r }) => ({ name: r.name, target_sha: r.target_sha, updated_at: r.updated_at }))
  // )
  const data: any[] = []
  type BranchRow = Pick<Database['refs'], 'name' | 'target_sha' | 'updated_at'>
  const branches = React.useMemo(() => (data ?? []) as Array<BranchRow>, [data])
  const isLoading = branches.length === 0

  const headingClass = isDark ? 'text-xl font-semibold text-slate-100' : 'text-xl font-semibold text-slate-900'
  const cardClass = isDark
    ? 'rounded-xl border border-slate-700 bg-slate-900/70 p-4 shadow-lg shadow-slate-900/40'
    : 'rounded-xl border border-slate-200 bg-white p-4 shadow-sm'
  const labelClass = isDark ? 'font-semibold mb-2 text-slate-100' : 'font-semibold mb-2 text-slate-900'
  const branchRowClass = isDark
    ? 'flex items-center justify-between rounded-lg bg-slate-800/60 px-3 py-2 text-xs text-slate-300'
    : 'flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600'
  const branchNameClass = isDark ? 'mx-2 text-slate-100' : 'mx-2 text-slate-800'
  const branchShaClass = isDark ? 'font-mono text-[11px] text-slate-400' : 'font-mono text-[11px] text-slate-500'
  const branchTimestampClass = isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'
  const linkClass = isDark
    ? 'text-sm font-medium text-emerald-300 underline-offset-2 hover:text-emerald-200'
    : 'text-sm font-medium text-emerald-600 underline-offset-2 hover:text-emerald-500'

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <h2 className={headingClass}>
        Repo: {orgId}/{repoId}
      </h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <div className={cardClass}>
          <div className={labelClass}>Branches {isLoading ? '⟳' : ''}</div>
          <ul className="space-y-2">
            {branches.map((b) => (
              <li key={b.name ?? ''} className={branchRowClass}>
                <span className={branchShaClass}>{b.target_sha?.slice(0, 7) ?? '———'}</span>
                <span className={branchNameClass}>{b.name ?? '(unnamed)'}</span>
                <span className={branchTimestampClass}>{b.updated_at ?? 'unknown'}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className={cardClass}>
          <div className={labelClass}>Views</div>
          <div className="flex flex-wrap gap-3 text-sm">
            <Link className={linkClass} to="/org/$orgId/repo/$repoId/commits" params={{ orgId, repoId }}>
              Commits
            </Link>
            <Link className={linkClass} to="/org/$orgId/repo/$repoId/files" params={{ orgId, repoId }}>
              Files
            </Link>
            <Link className={linkClass} to="/org/$orgId/repo/$repoId/branches" params={{ orgId, repoId }}>
              Branches
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}

export { RepoOverview as RepoOverviewComponent }
