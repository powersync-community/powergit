
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/files' as any)({
  component: Files,
})

function Files() {
  const { orgId, repoId } = Route.useParams()
  useRepoStreams(orgId, repoId)
  const fixture = useRepoFixture(orgId, repoId)
  if (import.meta.env.DEV) {
    console.debug('[Files] render', orgId, repoId, fixture, (window as typeof window & { __powersyncGetRepoFixtures?: () => unknown }).__powersyncGetRepoFixtures?.())
  }

  const { file_changes: fileChangesCollection } = useCollections()
  type FileChangeRow = Pick<Database['file_changes'], 'path' | 'additions' | 'deletions' | 'commit_sha'>
  const { data: liveRows = [] } = useLiveQuery((q) =>
    q
      .from({ f: fileChangesCollection })
      .where(({ f }) => eq(f.org_id, orgId))
      .where(({ f }) => eq(f.repo_id, repoId))
      .orderBy(({ f }) => f.commit_sha ?? '', 'desc')
      .select(({ f }) => ({
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
        commit_sha: f.commit_sha,
      })),
    [fileChangesCollection, orgId, repoId]
  ) as { data: Array<FileChangeRow> }

  const rows = fixture?.fileChanges?.length ? fixture.fileChanges : liveRows
  return (
    <div className="space-y-3" data-testid="file-change-view">
      <h3 className="font-semibold text-lg" data-testid="file-change-heading">
        Recent file changes ({orgId}/{repoId})
      </h3>
      <ul className="space-y-1" data-testid="file-change-list">
        {rows.map((r) => (
          <li
            key={`${r.commit_sha ?? ''}-${r.path ?? ''}`}
            className="border rounded p-2 bg-white"
            data-testid="file-change-item"
          >
            <span className="font-mono text-xs">{r.commit_sha?.slice(0,7) ?? '———'}</span> — {r.path ?? '(unknown path)'}
            <span className="ml-2 text-xs text-green-700">+{r.additions ?? 0}</span>
            <span className="ml-1 text-xs text-red-700">-{r.deletions ?? 0}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export { Files as FilesComponent }
