
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

export const Route = createFileRoute('/org/$orgId/repo/$repoId/branches' as any)({
  component: Branches,
})

function Branches() {
  const { orgId, repoId } = Route.useParams()
  const navigate = Route.useNavigate()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  useRepoStreams(orgId, repoId)
  const fixture = useRepoFixture(orgId, repoId)
  if (import.meta.env.DEV) {
    console.debug('[Branches] render', orgId, repoId, fixture, (window as typeof window & { __powersyncGetRepoFixtures?: () => unknown }).__powersyncGetRepoFixtures?.())
  }

  const { refs, repositories } = useCollections()
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

  const { data: repositoryListRows = [] } = useLiveQuery(
    (q) =>
      q.from({ r: repositories }).select(({ r }) => ({
        org_id: r.org_id,
        repo_id: r.repo_id,
      })),
    [repositories],
  ) as { data: Array<{ org_id: string | null; repo_id: string | null }> }

  const orgMenuOptions = React.useMemo(() => {
    const orgs = new Set<string>()
    repositoryListRows.forEach((row) => {
      if (row.org_id) orgs.add(row.org_id)
    })
    orgs.add(orgId)
    return Array.from(orgs).map((org) => ({
      key: org,
      label: org,
      onSelect: () => {
        const repos = new Set<string>()
        repositoryListRows.forEach((row) => {
          if (row.org_id !== org) return
          if (row.repo_id) repos.add(row.repo_id)
        })
        if (org === orgId) repos.add(repoId)
        const nextRepoId = Array.from(repos).sort((a, b) => a.localeCompare(b))[0] ?? null
        if (!nextRepoId) {
          void navigate({ to: '/', search: { org } as any })
          return
        }
        void navigate({
          to: '/org/$orgId/repo/$repoId/branches',
          params: { orgId: org, repoId: nextRepoId } as any,
        })
      },
    }))
  }, [navigate, orgId, repositoryListRows])

  const repoMenuOptions = React.useMemo(() => {
    const repos = new Set<string>()
    repositoryListRows.forEach((row) => {
      if (row.org_id !== orgId) return
      if (row.repo_id) repos.add(row.repo_id)
    })
    repos.add(repoId)
    return Array.from(repos).map((repo) => ({
      key: repo,
      label: repo,
      onSelect: () => {
        void navigate({
          to: '/org/$orgId/repo/$repoId/branches',
          params: { orgId, repoId: repo } as any,
        })
      },
    }))
  }, [navigate, orgId, repoId, repositoryListRows])

  const branches = fixture?.branches?.length ? fixture.branches : liveBranches
  const headingClass = isDark ? 'text-lg font-semibold text-slate-100' : 'text-lg font-semibold text-slate-900'
  const listClass = 'space-y-1'
  const itemClass = isDark
    ? 'rounded-lg border border-slate-700 bg-slate-900/70 px-3 py-2 text-sm text-slate-200 shadow-sm shadow-slate-900/40'
    : 'rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm'
  const shaClass = isDark ? 'font-mono text-xs text-slate-400' : 'font-mono text-xs text-slate-500'

  return (
    <div className="mx-auto max-w-6xl space-y-3" data-testid="branch-view">
      <BreadcrumbChips
        isDark={isDark}
        items={[
          { key: 'home', label: 'Home', to: '/' },
          {
            key: `org-${orgId}`,
            label: orgId,
            menu: { placeholder: 'Filter orgs…', options: orgMenuOptions },
          },
          {
            key: `repo-${repoId}`,
            label: repoId,
            menu: { placeholder: 'Filter repos…', options: repoMenuOptions },
          },
          { key: 'branches', label: 'Branches', current: true },
        ]}
      />
      <h3 className={headingClass} data-testid="branch-heading">
        Branches
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
