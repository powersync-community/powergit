
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useRepoStreams } from '@ps/streams'
import { useCollections } from '@tsdb/collections'
import { useLiveQuery } from '@tanstack/react-db'
import type { Database } from '@ps/schema'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/commits' as any)({
  component: Commits,
})

function Commits() {
  const { orgId, repoId } = Route.useParams()
  useRepoStreams(orgId, repoId)

  const { commits } = useCollections()
  // Temporarily disabled due to TanStack DB 0.4.3 API changes
  // const { data } = useLiveQuery(q =>
  //   q.from({ c: commits })
  //   .where(({ c }) => c.org_id === orgId)
  //   .where(({ c }) => c.repo_id === repoId)
  //    .select(({ c }) => ({ sha: c.sha, author_name: c.author_name, authored_at: c.authored_at, message: c.message }))
  // )
  const data: any[] = []
  type CommitRow = Pick<Database['commits'], 'sha' | 'author_name' | 'authored_at' | 'message'>
  const commitsData = React.useMemo(() => (data ?? []) as Array<CommitRow>, [data])

  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-lg">Commits ({orgId}/{repoId})</h3>
      <ul className="space-y-2">
        {commitsData.map((c) => (
          <li key={c.sha ?? ''} className="border rounded p-2 bg-white">
            <div className="text-sm text-gray-500">{c.authored_at ?? 'unknown'} — <span className="font-mono">{c.sha?.slice(0,7) ?? '———'}</span></div>
            <div className="font-medium">{c.message ?? '(no message)'}</div>
            <div className="text-sm">{c.author_name ?? '—'}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
