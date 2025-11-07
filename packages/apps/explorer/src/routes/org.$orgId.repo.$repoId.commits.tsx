
import * as React from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useRepoStreams } from '@ps/streams'
import { useRepoFixture } from '@ps/test-fixture-bridge'
import { useCollections } from '@tsdb/collections'
import type { Database } from '@ps/schema'
import { useTheme } from '../ui/theme-context'

export const Route = createFileRoute('/org/$orgId/repo/$repoId/commits' as any)({
  component: Commits,
})

function Commits() {
  const { orgId, repoId } = Route.useParams()
  const { theme } = useTheme()
  const isDark = theme === 'dark'
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

  const headingClass = isDark ? 'text-lg font-semibold text-slate-100' : 'text-lg font-semibold text-slate-900'
  const itemClass = isDark
    ? 'space-y-2 rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-200 shadow-sm shadow-slate-900/40'
    : 'space-y-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 shadow-sm'
  const metaClass = isDark ? 'text-sm text-slate-400' : 'text-sm text-slate-500'
  const messageClass = isDark ? 'text-base font-medium text-slate-100' : 'text-base font-medium text-slate-900'
  const authorClass = isDark ? 'text-sm text-slate-300' : 'text-sm text-slate-600'
  const shaClass = isDark ? 'font-mono text-slate-300' : 'font-mono text-slate-600'

  return (
    <div className="mx-auto max-w-6xl space-y-3" data-testid="commit-view">
      <h3 className={headingClass} data-testid="commit-heading">
        Commits ({orgId}/{repoId})
      </h3>
      <ul className="space-y-2" data-testid="commit-list">
        {commits.map((c) => (
          <li key={c.sha ?? ''} className={itemClass} data-testid="commit-item">
            <div className={metaClass}>
              {c.authored_at ?? 'unknown'} — <span className={shaClass}>{c.sha?.slice(0, 7) ?? '———'}</span>
            </div>
            <div className={messageClass}>{c.message ?? '(no message)'}</div>
            <div className={authorClass}>{c.author_name ?? '—'}</div>
          </li>
        ))}
      </ul>
    </div>
  )
}

export { Commits as CommitsComponent }
