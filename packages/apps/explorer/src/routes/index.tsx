
import * as React from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { useLiveQuery } from '@tanstack/react-db'
import { useCollections } from '@tsdb/collections'
import { useStatus } from '@powersync/react'
import { GithubImportCard } from '../components/GithubImportCard'
import type { Database } from '@ps/schema'
import { useTheme } from '../ui/theme-context'
import { deleteDaemonRepo, isDaemonPreferred } from '@ps/daemon-client'
import { useSupabaseAuth } from '@ps/auth-context'
import { getSupabase } from '@ps/supabase'
import { IoTrashOutline } from 'react-icons/io5'
import { FaGithub } from 'react-icons/fa'
import { InlineSpinner } from '../components/InlineSpinner'

type HomeSearch = {
  org?: string | null
  sort?: 'updated' | 'name'
}

export const Route = createFileRoute('/' as any)({
  component: Home,
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    org: typeof search.org === 'string' && search.org.length > 0 ? search.org : null,
    sort: search.sort === 'name' ? 'name' : 'updated',
  }),
})

type RepoSummary = {
  orgId: string
  repoId: string
  branches: Set<string>
  updatedAt: string | null
  status?: string | null
  defaultBranch?: string | null
}

type SortKey = 'updated' | 'name'

const REPO_PAGE_SIZE = 50

export function Home() {
  const { theme } = useTheme()
  const { refs, repositories } = useCollections()
  const { org: orgFilter, sort: sortSearch } = Route.useSearch()
  const navigate = Route.useNavigate()
  const status = useStatus()
  const { status: authStatus, session } = useSupabaseAuth()
  const preferDaemon = React.useMemo(() => isDaemonPreferred(), [])
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

  const [deletingRepos, setDeletingRepos] = React.useState<Record<string, boolean>>({})

  type MyOrgRow = { org_id: string }
  const [myOrgIds, setMyOrgIds] = React.useState<string[]>([])
  const [loadingMyOrgs, setLoadingMyOrgs] = React.useState(false)

  React.useEffect(() => {
    if (authStatus !== 'authenticated' || !session?.user?.id) {
      setMyOrgIds([])
      setLoadingMyOrgs(false)
      return
    }

    const supabase = getSupabase()
    if (!supabase || typeof (supabase as unknown as { rpc?: unknown }).rpc !== 'function') {
      setMyOrgIds([])
      setLoadingMyOrgs(false)
      return
    }

    let disposed = false
    setLoadingMyOrgs(true)

    const load = async () => {
      try {
        const { data, error } = await supabase.rpc('powergit_list_my_orgs')
        if (disposed) return
        if (error) {
          console.warn('[Explorer] failed to load org memberships', error)
          setMyOrgIds([])
          return
        }
        const rows = Array.isArray(data) ? (data as MyOrgRow[]) : []
        const ids = rows
          .map((row) => (typeof row?.org_id === 'string' ? row.org_id.trim() : ''))
          .filter(Boolean)
        setMyOrgIds(Array.from(new Set(ids)))
      } catch (error) {
        if (disposed) return
        console.warn('[Explorer] failed to load org memberships', error)
        setMyOrgIds([])
      } finally {
        if (disposed) return
        setLoadingMyOrgs(false)
      }
    }

    void load()

    return () => {
      disposed = true
    }
  }, [authStatus, session?.user?.id])

  type RepoRow = Pick<
    Database['repositories'],
    'org_id' | 'repo_id' | 'repo_url' | 'created_at' | 'updated_at' | 'default_branch' | 'last_status'
  >
  const { data: repoRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ repo: repositories })
        .select(({ repo }) => ({
          org_id: repo.org_id,
          repo_id: repo.repo_id,
          repo_url: repo.repo_url,
          created_at: repo.created_at,
          updated_at: repo.updated_at,
          default_branch: repo.default_branch,
          last_status: repo.last_status,
        })),
    [repositories],
  ) as { data: Array<RepoRow> }

  const combinedSummaries = React.useMemo(() => {
    const map = new Map<string, RepoSummary>()
    for (const row of repoRows) {
      const orgId = row.org_id?.trim()
      const repoId = row.repo_id?.trim()
      if (!orgId || !repoId) continue
      const key = `${orgId}/${repoId}`
      map.set(key, {
        orgId,
        repoId,
        branches: new Set<string>(),
        updatedAt: row.updated_at ?? row.created_at ?? null,
        status: row.last_status ?? null,
        defaultBranch: row.default_branch ?? null,
      })
    }
    for (const row of refRows) {
      const orgId = row.org_id?.trim()
      const repoId = row.repo_id?.trim()
      if (!orgId || !repoId) continue
      const key = `${orgId}/${repoId}`
      const entry = map.get(key) ?? { orgId, repoId, branches: new Set<string>(), updatedAt: null }
      if (row.name) {
        entry.branches.add(row.name)
      }
      if (row.updated_at) {
        if (!entry.updatedAt || entry.updatedAt < row.updated_at) {
          entry.updatedAt = row.updated_at
        }
      }
      map.set(key, entry)
    }
    return Array.from(map.values()).sort((a, b) => {
      const aTime = a.updatedAt ? Date.parse(a.updatedAt) : 0
      const bTime = b.updatedAt ? Date.parse(b.updatedAt) : 0
      if (aTime === bTime) {
        return `${a.orgId}/${a.repoId}`.localeCompare(`${b.orgId}/${b.repoId}`)
      }
      return bTime - aTime
    })
  }, [repoRows, refRows])

  const [sortKey, setSortKey] = React.useState<SortKey>(sortSearch ?? 'updated')
  React.useEffect(() => {
    setSortKey(sortSearch ?? 'updated')
  }, [sortSearch])

  const myOrgIdSet = React.useMemo(() => new Set(myOrgIds), [myOrgIds])

  const mySummaries = React.useMemo(() => {
    if (myOrgIdSet.size === 0) {
      return [] as RepoSummary[]
    }
    const list = combinedSummaries.filter((repo) => myOrgIdSet.has(repo.orgId))
    if (sortKey === 'name') {
      return list.sort((a, b) => `${a.orgId}/${a.repoId}`.localeCompare(`${b.orgId}/${b.repoId}`))
    }
    return list
  }, [combinedSummaries, myOrgIdSet, sortKey])

  const [myVisibleCount, setMyVisibleCount] = React.useState(REPO_PAGE_SIZE)
  React.useEffect(() => {
    setMyVisibleCount(REPO_PAGE_SIZE)
  }, [sortKey, myOrgIds])

  const visibleMySummaries = React.useMemo(
    () => mySummaries.slice(0, myVisibleCount),
    [mySummaries, myVisibleCount],
  )

  const sortedSummaries = React.useMemo(() => {
    const list = [...combinedSummaries]
    const filtered = orgFilter ? list.filter((repo) => repo.orgId === orgFilter) : list
    if (sortKey === 'name') {
      return filtered.sort((a, b) => `${a.orgId}/${a.repoId}`.localeCompare(`${b.orgId}/${b.repoId}`))
    }
    return filtered
  }, [combinedSummaries, sortKey, orgFilter])

  const [allVisibleCount, setAllVisibleCount] = React.useState(REPO_PAGE_SIZE)
  React.useEffect(() => {
    setAllVisibleCount(REPO_PAGE_SIZE)
  }, [sortKey, orgFilter])

  const visibleAllSummaries = React.useMemo(
    () => sortedSummaries.slice(0, allVisibleCount),
    [sortedSummaries, allVisibleCount],
  )

  const orgOptions = React.useMemo(() => {
    const ids = new Set<string>()
    for (const repo of combinedSummaries) {
      ids.add(repo.orgId)
    }
    return Array.from(ids).sort((a, b) => a.localeCompare(b))
  }, [combinedSummaries])

  const formatTimestamp = React.useCallback((iso: string | null | undefined) => {
    if (!iso) return '–'
    try {
      return new Date(iso).toLocaleString()
    } catch {
      return iso
    }
  }, [])

  const isDark = theme === 'dark'
  const repoCardBase = isDark
    ? 'group flex items-center justify-between rounded-2xl border border-slate-700 bg-slate-900 px-5 py-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-xl hover:shadow-slate-900/40'
    : 'group flex items-center justify-between rounded-2xl border border-slate-200 bg-white px-5 py-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-lg'
  const repoBadge = isDark
    ? 'rounded-full bg-slate-800 px-3 py-1 text-xs font-medium text-slate-300'
    : 'rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600'
  const openButtonClasses = isDark
    ? 'inline-flex items-center gap-2 rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
  const deleteButtonClasses = isDark
    ? 'inline-flex items-center justify-center rounded-xl border border-red-500/40 px-3 py-2 text-sm text-red-200 transition hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400'
    : 'inline-flex items-center justify-center rounded-xl border border-red-200 px-3 py-2 text-sm text-red-600 transition hover:bg-red-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-200'
  const paginationButtonClasses = isDark
    ? 'inline-flex items-center justify-center rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40 disabled:cursor-not-allowed disabled:opacity-60'
    : 'inline-flex items-center justify-center rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 transition hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-60'
  const paginationMetaClass = isDark ? 'text-xs text-slate-400' : 'text-xs text-slate-500'
  const showSyncPlaceholder = combinedSummaries.length === 0 && (!status.connected || status.connecting || !status.hasSynced)
  const syncLabel = status.connected ? 'Syncing repositories…' : status.connecting ? 'Connecting to PowerSync…' : 'Waiting for PowerSync…'
  const showMySyncPlaceholder =
    !loadingMyOrgs &&
    myOrgIdSet.size > 0 &&
    mySummaries.length === 0 &&
    (!status.connected || status.connecting || !status.hasSynced)

  const sortSelector = (
    <label className="flex items-center gap-2 text-xs uppercase tracking-wide">
      <span className={isDark ? 'text-slate-400' : 'text-slate-600'}>Sort</span>
      <select
        value={sortKey}
        onChange={(event) => {
          const nextSort = event.target.value as SortKey
          navigate({
            search: { org: orgFilter ?? null, sort: nextSort } as any,
            replace: true,
          } as any)
        }}
        className={
          isDark
            ? 'rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs text-slate-100 shadow-sm focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
            : 'rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm focus:border-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
        }
      >
        <option value="updated">Latest updated</option>
        <option value="name">Name</option>
      </select>
    </label>
  )

  const handleDeleteRepo = React.useCallback(
    async (repo: RepoSummary) => {
      if (!preferDaemon) return
      const repoKey = `${repo.orgId}/${repo.repoId}`
      const confirmed = typeof window === 'undefined' ? true : window.confirm(`Remove ${repoKey} from the local daemon?`)
      if (!confirmed) return
      setDeletingRepos((prev) => ({ ...prev, [repoKey]: true }))
      const ok = await deleteDaemonRepo(repo.orgId, repo.repoId)
      setDeletingRepos((prev) => {
        const next = { ...prev }
        delete next[repoKey]
        return next
      })
      if (!ok) {
        if (typeof window !== 'undefined') {
          window.alert('Failed to remove repo from daemon. Check daemon logs for details.')
        }
        return
      }
    },
    [preferDaemon],
  )

  const renderRepoList = (repos: RepoSummary[]) => (
    <ul className="space-y-3">
      {repos.map((repo) => {
        const branchCount = Array.from(repo.branches).filter((name) => name && name !== 'HEAD').length
        const importStatus = repo.status?.trim().toLowerCase() ?? null
        const isGithubMirror = repo.orgId.startsWith('gh-') && repo.orgId.length > 3
        const displayOrgId = isGithubMirror ? repo.orgId.slice(3) : repo.orgId
        const branchSummary = (() => {
          if (branchCount > 0) return `${branchCount} branch${branchCount === 1 ? '' : 'es'}`
          if (importStatus === 'queued') return 'Import queued'
          if (importStatus === 'running') return 'Importing…'
          if (importStatus === 'error') return 'Import failed'
          if (status.connected && !status.hasSynced) return 'Syncing…'
          return 'Not synced yet'
        })()
        const repoKey = `${repo.orgId}/${repo.repoId}`
        return (
          <li key={repoKey} className={repoCardBase}>
            <div className="space-y-1">
              <div className={`text-base font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
                <span className="inline-flex items-center gap-2">
                  {isGithubMirror ? (
                    <FaGithub
                      className={`${isDark ? 'text-slate-300' : 'text-slate-500'} text-[16px]`}
                      title="GitHub mirror"
                      aria-hidden
                    />
                  ) : null}
                  <span>
                    {displayOrgId}
                    <span className="text-slate-400">/</span>
                    {repo.repoId}
                  </span>
                </span>
              </div>
              <div className={`text-xs ${isDark ? 'text-slate-400' : 'text-slate-500'}`}>
                {branchSummary} · Updated {formatTimestamp(repo.updatedAt)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {preferDaemon ? (
                <button
                  type="button"
                  className={deleteButtonClasses}
                  title="Remove from daemon"
                  aria-label={`Remove ${repoKey}`}
                  disabled={Boolean(deletingRepos[repoKey])}
                  onClick={() => handleDeleteRepo(repo)}
                  data-testid="repository-delete-button"
                >
                  {deletingRepos[repoKey] ? <span className="text-xs">…</span> : <IoTrashOutline />}
                </button>
              ) : null}
              <Link
                to="/org/$orgId/repo/$repoId/files"
                params={{ orgId: repo.orgId, repoId: repo.repoId }}
                className={openButtonClasses}
                data-testid="repository-open-button"
              >
                Open
                <span
                  aria-hidden
                  className={`${
                    isDark ? 'text-slate-500 group-hover:text-slate-300' : 'text-slate-400 group-hover:text-slate-500'
                  }`}
                >
                  →
                </span>
              </Link>
            </div>
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <GithubImportCard />

      <section className="space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className={`text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>My repositories</h2>
          </div>
          <div className="flex items-center gap-3">
            {sortSelector}
            <span className={repoBadge}>
              {mySummaries.length} repo{mySummaries.length === 1 ? '' : 's'}
            </span>
          </div>
        </header>

        {mySummaries.length === 0 ? (
          <div
            className={`rounded-2xl border border-dashed px-6 py-8 text-center text-sm ${
              isDark ? 'border-slate-700 text-slate-400 bg-slate-900/60' : 'border-slate-200 text-slate-500 bg-white/80'
            }`}
            data-testid="my-repositories-empty-state"
          >
            {loadingMyOrgs ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <InlineSpinner size={14} color={isDark ? '#cbd5f5' : '#0f172a'} aria-label="Loading orgs" />
                  Loading orgs…
                </span>
              </div>
            ) : showMySyncPlaceholder ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <InlineSpinner size={14} color={isDark ? '#cbd5f5' : '#0f172a'} aria-label="Syncing repositories" />
                  {syncLabel}
                </span>
                <p className="text-xs">
                  This list updates automatically once the initial sync completes.
                </p>
              </div>
            ) : (
              <p>No repos found</p>
            )}
          </div>
        ) : (
          <>
            {renderRepoList(visibleMySummaries)}
            {mySummaries.length > visibleMySummaries.length ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className={paginationMetaClass}>
                  Showing {visibleMySummaries.length} of {mySummaries.length}
                </div>
                <button
                  type="button"
                  className={paginationButtonClasses}
                  onClick={() => setMyVisibleCount((prev) => prev + REPO_PAGE_SIZE)}
                  data-testid="my-repositories-load-more"
                >
                  Load more
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>

      <section className="space-y-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className={`text-lg font-semibold ${isDark ? 'text-slate-100' : 'text-slate-900'}`}>
              All repositories
            </h2>
          </div>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs uppercase tracking-wide">
              <span className={isDark ? 'text-slate-400' : 'text-slate-600'}>Org</span>
              <select
                value={orgFilter ?? ''}
                onChange={(event) => {
                  const nextOrg = event.target.value || null
                  navigate({
                    search: { org: nextOrg, sort: sortKey } as any,
                    replace: true,
                  } as any)
                }}
                className={
                  isDark
                    ? 'rounded-full border border-slate-700 bg-slate-900/70 px-3 py-1 text-xs text-slate-100 shadow-sm focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
                    : 'rounded-full border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 shadow-sm focus:border-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'
                }
              >
                <option value="">All orgs</option>
                {orgOptions.map((org) => (
                  <option key={org} value={org}>
                    {org}
                  </option>
                ))}
              </select>
            </label>
            {sortSelector}
            <span className={repoBadge}>
              {sortedSummaries.length} repo{sortedSummaries.length === 1 ? '' : 's'}
            </span>
          </div>
        </header>

        {sortedSummaries.length === 0 ? (
          <div
            className={`rounded-2xl border border-dashed px-6 py-8 text-center text-sm ${
              isDark ? 'border-slate-700 text-slate-400 bg-slate-900/60' : 'border-slate-200 text-slate-500 bg-white/80'
            }`}
            data-testid="repositories-empty-state"
          >
            {showSyncPlaceholder ? (
              <div className="flex flex-col items-center justify-center gap-3">
                <span className="flex items-center gap-2 text-sm font-medium">
                  <InlineSpinner size={14} color={isDark ? '#cbd5f5' : '#0f172a'} aria-label="Syncing repositories" />
                  {syncLabel}
                </span>
                <p className="text-xs">
                  This list updates automatically once the initial sync completes.
                </p>
              </div>
            ) : (
              <p>No repos found</p>
            )}
          </div>
        ) : (
          <>
            {renderRepoList(visibleAllSummaries)}
            {sortedSummaries.length > visibleAllSummaries.length ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className={paginationMetaClass}>
                  Showing {visibleAllSummaries.length} of {sortedSummaries.length}
                </div>
                <button
                  type="button"
                  className={paginationButtonClasses}
                  onClick={() => setAllVisibleCount((prev) => prev + REPO_PAGE_SIZE)}
                  data-testid="repositories-load-more"
                >
                  Load more
                </button>
              </div>
            ) : null}
          </>
        )}
      </section>
    </div>
  )
}

export { Home as HomeComponent }
