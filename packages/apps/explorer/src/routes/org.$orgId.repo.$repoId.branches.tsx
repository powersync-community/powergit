
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useRepoStreams } from '@ps/streams'
import { useLiveQuery } from '@tanstack/react-db'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/branches' as any)({
  component: Branches,
})

function Branches() {
  const { orgId, repoId } = Route.useParams()
  useRepoStreams(orgId, repoId)

  const { refs } = useCollections()
  // Temporarily disabled due to TanStack DB 0.4.3 API changes
  // const { data } = useLiveQuery(q =>
  //   q.from({ r: refs })
  //   .where(({ r }) => r.org_id === orgId)
  //   .where(({ r }) => r.repo_id === repoId)
  //    .select(({ r }) => ({ name: r.name, target_sha: r.target_sha }))
  // )
  const data: any[] = []
  type BranchRow = Pick<Database['refs'], 'name' | 'target_sha'>
  const branches = React.useMemo(() => (data ?? []) as Array<BranchRow>, [data])
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-lg">Branches ({orgId}/{repoId})</h3>
      <ul className="space-y-1">
        {branches.map((b) => (
          <li key={b.name ?? ''} className="border rounded p-2 bg-white">{b.name ?? '(unnamed)'} — <span className="font-mono text-xs">{b.target_sha ?? '—'}</span></li>
        ))}
      </ul>
    </div>
  )
}
