
import * as React from 'react'
import { createFileRoute, useParams } from '@tanstack/react-router'
import { useRepoStreams } from '../../ps/streams'
import { useCollections } from '../../tsdb/collections'
import { useLiveQuery } from '@tanstack/react-db'
import { desc } from '@tanstack/react-db'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/commits')({
  component: Commits,
})

function Commits() {
  const { orgId, repoId } = useParams({ from: '/org/$orgId/repo/$repoId/commits' })
  useRepoStreams(orgId, repoId)

  const { commits, eq } = useCollections()
  const { data } = useLiveQuery(q =>
    q.from({ c: commits })
      .where(({ c }) => eq(c.org_id, orgId))
      .where(({ c }) => eq(c.repo_id, repoId))
      .orderBy(({ c }) => desc(c.authored_at))
      .select(({ c }) => ({ sha: c.sha, author_name: c.author_name, authored_at: c.authored_at, message: c.message }))
  )

  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-lg">Commits ({orgId}/{repoId})</h3>
      <ul className="space-y-2">
        {data?.map((c) => (
          <li key={c.sha} className="border rounded p-2 bg-white">
            <div className="text-sm text-gray-500">{c.authored_at} — <span className="font-mono">{c.sha.slice(0,7)}</span></div>
            <div className="font-medium">{c.message}</div>
            <div className="text-sm">{c.author_name}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}
