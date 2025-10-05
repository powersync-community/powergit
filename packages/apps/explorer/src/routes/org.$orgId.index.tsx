
import * as React from 'react'
import { createFileRoute, useParams, Link } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useCollections } from '../tsdb/collections'
import { useOrgStreams } from '../ps/streams'

export const Route = createFileRoute('/org/$orgId/')({
  component: OrgActivity,
})

function OrgActivity() {
  const { orgId } = useParams({ from: '/org/$orgId/' })
  const { refs, eq } = useCollections()
  const { data, isLoading } = useLiveQuery(q =>
    q.from({ r: refs })
     .where(({ r }) => eq(r.org_id, orgId))
     .select(({ r }) => ({ org_id: r.org_id, repo_id: r.repo_id, name: r.name, target_sha: r.target_sha, updated_at: r.updated_at }))
  )
  const repoIds = React.useMemo(() => {
    if (!data || data.length === 0) return [] as string[]
    return Array.from(new Set(data.map((ref) => ref.repo_id)))
  }, [data])
  useOrgStreams(orgId, repoIds)

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">Org: {orgId} — Activity</h2>
      {isLoading && <div className="text-sm text-gray-500">Loading…</div>}
      <ul className="space-y-2">
        {data?.map((r) => (
          <li key={r.repo_id + r.name} className="border rounded-lg p-3 bg-white">
            <div className="text-sm text-gray-500">
              {r.updated_at} — <span className="font-mono">{r.target_sha?.slice(0,7)}</span>
            </div>
            <div className="font-medium">{r.name}</div>
            <Link className="text-blue-600 underline text-sm"
              to="/org/$orgId/repo/$repoId"
              params={{orgId, repoId: r.repo_id}}>Open repo →</Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
