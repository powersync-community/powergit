
import * as React from 'react'
import { createFileRoute, useParams } from '@tanstack/react-router'
import { useRepoStreams } from '../../ps/streams'
import { useLiveQuery } from '@tanstack/react-db'
import { useCollections } from '../../tsdb/collections'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/branches')({
  component: Branches,
})

function Branches() {
  const { orgId, repoId } = useParams({ from: '/org/$orgId/repo/$repoId/branches' })
  useRepoStreams(orgId, repoId)

  const { refs, eq } = useCollections()
  const { data: branches } = useLiveQuery(q =>
    q.from({ r: refs })
     .where(({ r }) => eq(r.org_id, orgId))
     .where(({ r }) => eq(r.repo_id, repoId))
     .select(({ r }) => ({ name: r.name, target_sha: r.target_sha }))
  )
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-lg">Branches ({orgId}/{repoId})</h3>
      <ul className="space-y-1">
        {branches?.map((b) => (
          <li key={b.name} className="border rounded p-2 bg-white">{b.name} — <span className="font-mono text-xs">{b.target_sha}</span></li>
        ))}
      </ul>
    </div>
  )
}
