
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useRepoStreams } from '@ps/streams'
import { useCollections } from '@tsdb/collections'
import { useLiveQuery } from '@tanstack/react-db'
import type { Database } from '@ps/schema'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/files' as any)({
  component: Files,
})

function Files() {
  const { orgId, repoId } = Route.useParams()
  useRepoStreams(orgId, repoId)

  const { file_changes } = useCollections()
  // Temporarily disabled due to TanStack DB 0.4.3 API changes
  // const { data } = useLiveQuery(q =>
  //   q.from({ f: file_changes })
  //   .where(({ f }) => f.org_id === orgId)
  //   .where(({ f }) => f.repo_id === repoId)
  //    .select(({ f }) => ({ path: f.path, additions: f.additions, deletions: f.deletions, commit_sha: f.commit_sha }))
  // )
  const data: any[] = []
  type FileChangeRow = Pick<Database['file_changes'], 'path' | 'additions' | 'deletions' | 'commit_sha'>
  const rows = React.useMemo(() => (data ?? []) as Array<FileChangeRow>, [data])
  return (
    <div className="space-y-3">
      <h3 className="font-semibold text-lg">Recent file changes ({orgId}/{repoId})</h3>
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={`${r.commit_sha ?? ''}-${r.path ?? ''}`} className="border rounded p-2 bg-white">
            <span className="font-mono text-xs">{r.commit_sha?.slice(0,7) ?? '———'}</span> — {r.path ?? '(unknown path)'}
            <span className="ml-2 text-xs text-green-700">+{r.additions ?? 0}</span>
            <span className="ml-1 text-xs text-red-700">-{r.deletions ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
