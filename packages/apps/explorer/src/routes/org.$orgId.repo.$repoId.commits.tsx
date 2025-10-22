
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/commits' as any)({
  component: Commits,
})

function Commits() {
  const { orgId, repoId } = Route.useParams()
  useRepoStreams(orgId, repoId)
  const fixture = useRepoFixture(orgId, repoId)
  if (import.meta.env.DEV) {
    console.debug('[Commits] render', orgId, repoId, fixture, (window as typeof window & { __powersyncGetRepoFixtures?: () => unknown }).__powersyncGetRepoFixtures?.())
  }

  const { commits: commitsCollection } = useCollections()
  type CommitRow = Pick<Database['commits'], 'sha' | 'author_name' | 'authored_at' | 'message'>
  const { data: liveCommits = [] } = useLiveQuery((q) =>
    q
      .from({ c: commitsCollection })
      .where(({ c }) => eq(c.org_id, orgId))
      .where(({ c }) => eq(c.repo_id, repoId))
      .orderBy(({ c }) => c.authored_at ?? '', 'desc'),
    [commitsCollection, orgId, repoId]
  ) as { data: Array<CommitRow> }

  const commits = fixture?.commits?.length ? fixture.commits : liveCommits

  return (
    <div className="space-y-3" data-testid="commit-view">
      <h3 className="font-semibold text-lg" data-testid="commit-heading">
        Commits ({orgId}/{repoId})
      </h3>
      <ul className="space-y-2" data-testid="commit-list">
        {commits.map((c) => (
          <li key={c.sha ?? ''} className="border rounded p-2 bg-white" data-testid="commit-item">
            <div className="text-sm text-gray-500">
              {c.authored_at ?? 'unknown'} —{' '}
              <span className="font-mono">{c.sha?.slice(0, 7) ?? '———'}</span>
            </div>
            <div className="font-medium">{c.message ?? '(no message)'}</div>
            <div className="text-sm">{c.author_name ?? '—'}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export { Commits as CommitsComponent }
