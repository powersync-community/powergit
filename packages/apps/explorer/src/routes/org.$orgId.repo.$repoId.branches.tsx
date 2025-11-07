
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'
import { useTheme } from '../ui/theme-context'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/branches' as any)({
  component: Branches,
})

function Branches() {
  const { orgId, repoId } = Route.useParams()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  useRepoStreams(orgId, repoId)
  const fixture = useRepoFixture(orgId, repoId)
  if (import.meta.env.DEV) {
    console.debug('[Branches] render', orgId, repoId, fixture, (window as typeof window & { __powersyncGetRepoFixtures?: () => unknown }).__powersyncGetRepoFixtures?.())
  }

  const { refs } = useCollections()
  type BranchRow = Pick<Database['refs'], 'name' | 'target_sha'>
  const { data: liveBranches = [] } = useLiveQuery((q) =>
    q
      .from({ r: refs })
      .where(({ r }) => eq(r.org_id, orgId))
      .where(({ r }) => eq(r.repo_id, repoId))
      .orderBy(({ r }) => r.name ?? '', 'asc')
      .select(({ r }) => ({
        name: r.name,
        target_sha: r.target_sha,
      })),
    [refs, orgId, repoId]
  ) as { data: Array<BranchRow> }

  const branches = fixture?.branches?.length ? fixture.branches : liveBranches
  const headingClass = isDark ? 'text-lg font-semibold text-slate-100' : 'text-lg font-semibold text-slate-900'
  const listClass = 'space-y-1'
  const itemClass = isDark
    ? 'rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 shadow-sm shadow-slate-900/40'
    : 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm'
  const shaClass = isDark ? 'font-mono text-xs text-slate-400' : 'font-mono text-xs text-slate-500'

  return (
    <div className="mx-auto max-w-6xl space-y-3" data-testid="branch-view">
      <h3 className={headingClass} data-testid="branch-heading">
        Branches ({orgId}/{repoId})
      </h3>
      <ul className={listClass} data-testid="branch-list">
        {branches.map((b) => (
          <li key={b.name ?? ''} className={itemClass} data-testid="branch-item">
            {b.name ?? '(unnamed)'} — <span className={shaClass}>{b.target_sha ?? '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export { Branches as BranchesComponent }
