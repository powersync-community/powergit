
import * as React from 'react'
import { createFileRoute, useParams, Link } from '@tanstack/react-router'
import { useRepoStreams } from '../../ps/streams'
import { useCollections } from '../../tsdb/collections'
import { useLiveQuery } from '@tanstack/react-db'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/')({
  component: RepoOverview,
})

function RepoOverview() {
  const { orgId, repoId } = useParams({ from: '/org/$orgId/repo/$repoId/' })
  useRepoStreams(orgId, repoId)
  const { refs, eq } = useCollections()

  const { data: branches, isLoading } = useLiveQuery(q =>
    q.from({ r: refs })
     .where(({ r }) => eq(r.org_id, orgId))
     .where(({ r }) => eq(r.repo_id, repoId))
     .select(({ r }) => ({ name: r.name, target_sha: r.target_sha, updated_at: r.updated_at }))
  )

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Repo: {orgId}/{repoId}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border rounded-lg p-3 bg-white">
          <div className="font-semibold mb-2">Branches {isLoading ? '⟳' : ''}</div>
          <ul className="space-y-2">
            {branches?.map((b) => (
              <li key={b.name} className="flex items-center justify-between">
                <span className="font-mono text-xs">{b.target_sha?.slice(0,7)}</span>
                <span className="mx-2">{b.name}</span>
                <span className="text-xs text-gray-500">{b.updated_at}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="border rounded-lg p-3 bg-white">
          <div className="font-semibold mb-2">Views</div>
          <div className="space-x-3 text-sm">
            <Link className="text-blue-600 underline" to="/org/$orgId/repo/$repoId/commits" params={{orgId, repoId}}>Commits</Link>
            <Link className="text-blue-600 underline" to="/org/$orgId/repo/$repoId/files" params={{orgId, repoId}}>Files</Link>
            <Link className="text-blue-600 underline" to="/org/$orgId/repo/$repoId/branches" params={{orgId, repoId}}>Branches</Link>
          </div>
        </div>
      </div>
    </div>
  )
}
