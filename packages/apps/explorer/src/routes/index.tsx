
import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useCollections } from '@tsdb/collections'
import { GithubImportCard } from '../components/GithubImportCard'
import type { Database } from '@ps/schema'

export const Route = createFileRoute('/' as any)({
  component: Home,
})

export function Home() {
  const { refs } = useCollections()
  type RefRow = Pick<Database['refs'], 'org_id' | 'repo_id' | 'name' | 'updated_at'>
  const { data: refRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ r: refs })
        .select(({ r }) => ({
          org_id: r.org_id,
          repo_id: r.repo_id,
          name: r.name,
          updated_at: r.updated_at,
        })),
    [refs],
  ) as { data: Array<RefRow> }

  const orgSummaries = React.useMemo(() => {
    const map = new Map<
      string,
      {
        repoIds: Set<string>
        latestUpdatedAt: string | null
      }
    >()

    for (const row of refRows) {
      const orgId = row.org_id ?? ''
      if (!orgId) continue
      const repoId = row.repo_id ?? ''
      const entry = map.get(orgId) ?? { repoIds: new Set<string>(), latestUpdatedAt: null }
      if (repoId) {
        entry.repoIds.add(repoId)
      }
      if (row.updated_at) {
        if (!entry.latestUpdatedAt || entry.latestUpdatedAt < row.updated_at) {
          entry.latestUpdatedAt = row.updated_at
        }
      }
      map.set(orgId, entry)
    }

    return Array.from(map.entries())
      .map(([orgId, value]) => ({
        orgId,
        repoIds: Array.from(value.repoIds).sort(),
        repoCount: value.repoIds.size,
        lastUpdatedAt: value.latestUpdatedAt,
      }))
      .sort((a, b) => a.orgId.localeCompare(b.orgId))
  }, [refRows])

  const isEmpty = orgSummaries.length === 0

  const formatTimestamp = React.useCallback((iso: string | null | undefined) => {
    if (!iso) return '—'
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }, [])

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <h2 className="text-xl font-semibold text-slate-900">Your PowerSync Repositories</h2>
        <p className="text-sm text-slate-600">
          Explore organisations and repositories replicated into your local PowerSync database. Run <code>psgit demo-seed</code> after
          authentication to populate a sample repo.
        </p>
      </header>

      <GithubImportCard />

      {isEmpty ? (
        <div className="rounded-xl border border-dashed border-slate-300 bg-white/70 px-6 py-8 text-center text-slate-500">
          <p className="text-sm">
            No organisations found yet. Push a repository via the PowerSync remote or run <code>psgit demo-seed</code> to load demo data.
          </p>
        </div>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {orgSummaries.map((org) => (
            <li
              key={org.orgId}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:shadow-md focus-within:ring-2 focus-within:ring-blue-200"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">{org.orgId}</h3>
                  <p className="text-xs uppercase tracking-wide text-slate-400">PowerSync Organisation</p>
                </div>
                <span className="rounded-full bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700">
                  {org.repoCount} repo{org.repoCount === 1 ? '' : 's'}
                </span>
              </div>
              {org.repoIds.length > 0 ? (
                <div className="mt-3 space-y-1 text-sm text-slate-600">
                  <div className="font-medium text-slate-700">Repositories</div>
                  <ul className="list-disc pl-4">
                    {org.repoIds.map((repoId) => (
                      <li key={repoId} className="leading-relaxed">
                        {repoId}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="mt-3 text-xs text-slate-500">
                Last updated: <span className="font-medium text-slate-600">{formatTimestamp(org.lastUpdatedAt)}</span>
              </div>
              <div className="mt-4">
                <Link
                  to="/org/$orgId"
                  params={{ orgId: org.orgId }}
                  className="text-sm font-medium text-blue-600 hover:text-blue-500"
                >
                  View activity →
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export { Home as HomeComponent }
