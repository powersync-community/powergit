
import * as React from 'react'
import { createFileRoute, useParams } from '@tanstack/react-router'
import { useRepoStreams } from '../../ps/streams'
import { useCollections } from '../../tsdb/collections'
import { useLiveQuery } from '@tanstack/react-db'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/files')({
  component: Files,
})

function Files() {
  const { orgId, repoId } = useParams({ from: '/org/$orgId/repo/$repoId/files' })
  useRepoStreams(orgId, repoId)

  const { file_changes, eq } = useCollections()
  const { data } = useLiveQuery(q =>
    q.from({ f: file_changes })
     .where(({ f }) => eq(f.org_id, orgId))
     .where(({ f }) => eq(f.repo_id, repoId))
     .select(({ f }) => ({ path: f.path, additions: f.additions, deletions: f.deletions, commit_sha: f.commit_sha }))
  )
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-lg">Recent file changes ({orgId}/{repoId})</h3>
      <ul className="space-y-1">
        {data?.map((r) => (
          <li key={r.commit_sha + r.path} className="border rounded p-2 bg-white">
            <span className="font-mono text-xs">{r.commit_sha.slice(0,7)}</span> — {r.path}
            <span className="ml-2 text-xs text-green-700">+{r.additions}</span>
            <span className="ml-1 text-xs text-red-700">-{r.deletions}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
