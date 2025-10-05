
import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useRepoStreams } from '@ps/streams'
import { useCollections } from '@tsdb/collections'
import { useLiveQuery } from '@tanstack/react-db'
import type { Database } from '@ps/schema'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/' as any)({
  component: RepoOverview,
})

function RepoOverview() {
  const { orgId, repoId } = Route.useParams()
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

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Repo: {orgId}/{repoId}</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="border rounded-lg p-3 bg-white">
          <div className="font-semibold mb-2">Branches {isLoading ? '⟳' : ''}</div>
          <ul className="space-y-2">
            {branches.map((b) => (
              <li key={b.name ?? ''} className="flex items-center justify-between">
                <span className="font-mono text-xs">{b.target_sha?.slice(0,7) ?? '———'}</span>
                <span className="mx-2">{b.name ?? '(unnamed)'}</span>
                <span className="text-xs text-gray-500">{b.updated_at ?? 'unknown'}</span>
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
