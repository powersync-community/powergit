import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { eq } from '@tanstack/db'
import { useLiveQuery } from '@tanstack/react-db'
import { useCollections } from '@tsdb/collections'
import type { PowerSyncImportJob } from '@powersync-community/powergit-core'
import {
  getImportMode,
  isGithubActionsImportEnabled,
  isDaemonEnabled,
  requestGithubImport,
  type DaemonGithubImportRequest,
} from '@ps/daemon-client'
import type { Database } from '@ps/schema'
import { useTheme } from '../ui/theme-context'

export const REPO_IMPORT_EVENT = '__powergit:repo-imported'

type ImportPhase = 'idle' | 'submitting' | 'queued' | 'running' | 'success' | 'error'
type ImportMode = ReturnType<typeof getImportMode>

export function GithubImportCard(): React.JSX.Element | null {
  const daemonAvailable = React.useMemo(() => isDaemonEnabled(), [])
  const actionsImportAvailable = React.useMemo(() => isGithubActionsImportEnabled(), [])
  const importMode = React.useMemo<ImportMode>(() => getImportMode(), [])
  const [repoUrl, setRepoUrl] = React.useState('')
  const [status, setStatus] = React.useState<ImportPhase>('idle')
  const [error, setError] = React.useState<string | null>(null)
  const [job, setJob] = React.useState<PowerSyncImportJob | null>(null)
  const { import_jobs } = useCollections()
  type ImportJobRow = Pick<
    Database['import_jobs'],
    | 'id'
    | 'status'
    | 'error'
    | 'org_id'
    | 'repo_id'
    | 'repo_url'
    | 'branch'
    | 'default_branch'
    | 'workflow_url'
    | 'updated_at'
  >
  const jobId = job?.id ?? ''
  const { data: importJobRows = [] } = useLiveQuery(
    (q) =>
      q
        .from({ j: import_jobs })
        .where(({ j }) => eq(j.id, jobId))
        .select(({ j }) => ({
          id: j.id,
          status: j.status,
          error: j.error,
          org_id: j.org_id,
          repo_id: j.repo_id,
          repo_url: j.repo_url,
          branch: j.branch,
          default_branch: j.default_branch,
          workflow_url: j.workflow_url,
          updated_at: j.updated_at,
        })),
    [import_jobs, jobId],
  ) as { data: Array<ImportJobRow> }
  const liveJob = importJobRows[0] ?? null
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const workflowUrl =
    liveJob?.workflow_url ??
    (job as { workflowUrl?: string } | null)?.workflowUrl

  React.useEffect(() => {
    if (!liveJob) return
    const nextPhase: ImportPhase =
      liveJob.status === 'success'
        ? 'success'
        : liveJob.status === 'error'
          ? 'error'
          : liveJob.status === 'running'
            ? 'running'
            : liveJob.status === 'queued'
              ? 'queued'
              : status
    setStatus((prev) => (prev === nextPhase ? prev : nextPhase))
    if (liveJob.status === 'error') {
      setError((prev) => prev ?? liveJob.error ?? 'Import failed unexpectedly.')
    }
  }, [liveJob?.status, liveJob?.error])

  if (!daemonAvailable && !actionsImportAvailable) {
    const disabledClasses = isDark
      ? 'rounded-2xl border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-200'
      : 'rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600'
    return (
      <div className={disabledClasses}>
        Imports are disabled. Enable <code className="font-mono">VITE_POWERSYNC_USE_DAEMON=true</code> or{' '}
        <code className="font-mono">VITE_POWERSYNC_ACTIONS_IMPORT=true</code> to queue GitHub clones.
      </div>
    )
  }

  const derived = React.useMemo(() => deriveSlugs(repoUrl), [repoUrl])
  const isSubmitting = status === 'submitting'
  const showSummary = Boolean(job)
  const resultOrgId = liveJob?.org_id ?? job?.result?.orgId ?? job?.orgId ?? derived?.orgId ?? null
  const resultRepoId = liveJob?.repo_id ?? job?.result?.repoId ?? job?.repoId ?? derived?.repoId ?? null
  const resultDefaultBranch =
    liveJob?.default_branch ??
    liveJob?.branch ??
    job?.result?.defaultBranch ??
    job?.result?.branch ??
    job?.branch ??
    null

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError(null)
    setStatus('submitting')

    const payload = buildImportPayload(repoUrl)
    if (!payload) {
      setStatus('error')
      setError('Enter a valid GitHub repository URL (e.g. https://github.com/org/repo).')
      return
    }

    try {
      const queued = await requestGithubImport(payload)
      setJob(queued)
      if (queued.status === 'success') {
        setStatus('success')
      } else if (queued.status === 'error') {
        setStatus('error')
        setError(queued.error ?? 'Import failed unexpectedly.')
      } else if (queued.status === 'queued') {
        setStatus(importMode === 'actions' ? 'queued' : 'queued')
      } else {
        setStatus('running')
      }
    } catch (submitError) {
      setStatus('error')
      setError(submitError instanceof Error ? submitError.message : 'Failed to start import.')
    }
  }

  const statusMessage = (() => {
    switch (status) {
      case 'idle':
        return ''
      case 'submitting':
        return 'Queuing import…'
      case 'queued':
        return importMode === 'actions'
          ? 'GitHub Actions run queued.'
          : 'Import queued — waiting for the daemon.'
      case 'running':
        return importMode === 'actions'
          ? 'GitHub Actions run in progress.'
          : 'Cloning repository...'
      case 'success':
        return importMode === 'actions'
          ? 'Import finished.'
          : 'Repository imported successfully.'
      case 'error':
        return error ?? 'Import encountered an error.'
      default:
        return null
    }
  })()
  const actionsRunLink =
    importMode === 'actions' && workflowUrl ? (
      <a
        href={workflowUrl}
        target="_blank"
        rel="noreferrer"
        className={isDark ? 'text-emerald-200 underline' : 'text-emerald-700 underline'}
      >
        View GitHub Actions run →
      </a>
    ) : null
  const displayStatus = (liveJob?.status ?? job?.status ?? status ?? 'queued').toUpperCase()
  const canOpenRepo = status === 'success' && resultOrgId && resultRepoId

  const cardClasses = isDark
    ? 'rounded-3xl border border-slate-700 bg-slate-900 px-6 py-6 text-slate-100 shadow-xl shadow-slate-900/40'
    : 'rounded-3xl border border-slate-200 bg-white px-6 py-6 text-slate-900 shadow-lg'
  const labelClasses = `text-sm font-medium uppercase tracking-wide ${isDark ? 'text-slate-400' : 'text-slate-500'}`
  const inputWrapperClasses = 'flex flex-col gap-2'
  const inputRowClasses = 'flex flex-col gap-3 sm:flex-row sm:items-end'
  const inputFieldClasses = isDark
    ? 'w-full rounded-xl border border-slate-700 bg-slate-900 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-300/40'
    : 'w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200'

  const statusTextClass = isDark ? 'text-sm text-slate-200/80' : 'text-sm text-slate-600'
  const summaryContainerClass = isDark
    ? 'rounded-xl bg-slate-900/70 px-4 py-3 text-xs text-slate-200 shadow-inner shadow-slate-900/50'
    : 'rounded-xl bg-white/80 px-4 py-3 text-xs text-slate-700 shadow-inner shadow-slate-200/60'

  return (
    <div className={cardClasses}>
      <form className={inputWrapperClasses} onSubmit={handleSubmit}>
        <label className={labelClasses} htmlFor="github-repo-url">
          Explore a Git repository
        </label>
        <div className={inputRowClasses}>
          <input
            id="github-repo-url"
            type="url"
            required
            autoComplete="off"
            value={repoUrl}
            onChange={(event) => setRepoUrl(event.target.value)}
            placeholder="https://github.com/powersync/powergit"
            className={inputFieldClasses}
            data-testid="explore-repo-input"
          />
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-xl bg-emerald-400 px-6 py-3 text-sm font-semibold text-emerald-950 shadow-lg shadow-emerald-500/40 transition hover:bg-emerald-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-200 disabled:cursor-not-allowed disabled:opacity-70"
            disabled={isSubmitting}
            data-testid="explore-repo-submit"
          >
            {isSubmitting ? 'Exploring…' : 'Explore'}
          </button>
        </div>
      </form>

      {statusMessage ? (
        <div className={`${statusTextClass} mt-4 flex flex-wrap items-center gap-3`}>
          <span>{statusMessage}</span>
          {status === 'error' && error ? <span className="text-red-400">({error})</span> : null}
          {canOpenRepo ? (
            <span className={`inline-flex items-center gap-1 ${isDark ? 'text-emerald-200' : 'text-emerald-600'}`}>
              <Link
                to="/org/$orgId/repo/$repoId/files"
                params={{ orgId: resultOrgId as string, repoId: resultRepoId as string }}
                className={`font-medium underline-offset-2 hover:underline ${
                  isDark ? 'text-emerald-200' : 'text-emerald-700'
                }`}
              >
                Open repository
              </Link>
              →
            </span>
          ) : null}
          {actionsRunLink}
        </div>
      ) : null}

      {showSummary && resultOrgId && resultRepoId ? (
        <div className={`${summaryContainerClass} mt-3 flex flex-wrap items-center gap-2`} data-testid="import-summary">
          <div className={isDark ? 'font-medium text-slate-100' : 'font-medium text-slate-800'}>
            Target: <code>{resultOrgId}/{resultRepoId}</code>
          </div>
          <div className={isDark ? 'text-slate-200' : 'text-slate-600'}>
            Status: <span className="uppercase tracking-wide text-[11px]">{displayStatus}</span>
          </div>
          {resultDefaultBranch ? (
            <div className={isDark ? 'text-slate-200' : 'text-slate-600'}>Branch: {resultDefaultBranch}</div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function buildImportPayload(repoUrl: string): DaemonGithubImportRequest | null {
  const url = repoUrl.trim()
  if (!url) return null
  const parsed = parseGithubUrl(url)
  if (!parsed) return null
  return { repoUrl: url, branch: null }
}

function parseGithubUrl(value: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(value.trim())
    if (!/github\.com$/i.test(url.host)) return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/i, '') }
  } catch {
    return null
  }
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function deriveSlugs(repoUrl: string): { orgId: string; repoId: string } | null {
  const url = repoUrl.trim()
  if (!url) return null
  const parsed = parseGithubUrl(url)
  if (!parsed) return null
  const orgId = `gh-${slugify(parsed.owner)}`
  const repoId = slugify(parsed.repo)
  if (!orgId || !repoId) return null
  return { orgId, repoId }
}
