
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/branches' as any)({
  component: Branches,
})

function Branches() {
  const { orgId, repoId } = Route.useParams()
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
  return (
    <div className="space-y-3" data-testid="branch-view">
      <h3 className="font-semibold text-lg" data-testid="branch-heading">
        Branches ({orgId}/{repoId})
      </h3>
      <ul className="space-y-1" data-testid="branch-list">
        {branches.map((b) => (
          <li key={b.name ?? ''} className="border rounded p-2 bg-white" data-testid="branch-item">
            {b.name ?? '(unnamed)'} — <span className="font-mono text-xs">{b.target_sha ?? '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export { Branches as BranchesComponent }
