import * as React from 'react'
import { Link } from '@tanstack/react-router'
import type { PowerSyncImportJob } from '@shared/core'
import {
  getImportMode,
  isGithubActionsImportEnabled,
  isDaemonEnabled,
  requestGithubImport,
  fetchGithubImportJob,
  type DaemonGithubImportRequest,
} from '@ps/daemon-client'
import { useTheme } from '../ui/theme-context'

export const REPO_IMPORT_EVENT = '__powergit:repo-imported'

const POLL_INTERVAL_MS = 1_500

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
  const lastAnnouncedJob = React.useRef<string | null>(null)
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const workflowUrl = (job as { workflowUrl?: string } | null)?.workflowUrl

  React.useEffect(() => {
    if (!job) return undefined
    if (importMode !== 'daemon') return undefined
    if (job.status === 'success' || job.status === 'error') return undefined

    let cancelled = false
    const poll = window.setInterval(async () => {
      try {
        const next = await fetchGithubImportJob(job.id)
        if (!cancelled && next) {
          setJob(next)
          if (next.status === 'success' || next.status === 'error') {
            window.clearInterval(poll)
            setStatus(next.status === 'success' ? 'success' : 'error')
            if (next.status === 'error') {
              setError(next.error ?? 'Import failed unexpectedly.')
            }
          } else if (next.status === 'queued') {
            setStatus('queued')
          } else {
            setStatus('running')
          }
        }
      } catch (pollError) {
        console.warn('[Explorer] failed to poll import job', pollError)
      }
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(poll)
    }
  }, [job, importMode])

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
  const showSummary = Boolean(job && derived)
  const resultOrgId = job?.result?.orgId ?? job?.orgId ?? derived?.orgId ?? null
  const resultRepoId = job?.result?.repoId ?? job?.repoId ?? derived?.repoId ?? null
  const resultDefaultBranch = job?.result?.defaultBranch ?? job?.result?.branch ?? job?.branch ?? null

  React.useEffect(() => {
    if (
      typeof window === 'undefined' ||
      !job ||
      job.status !== 'success' ||
      !resultOrgId ||
      !resultRepoId ||
      lastAnnouncedJob.current === job.id
    ) {
      return
    }
    lastAnnouncedJob.current = job.id
    const detail = {
      orgId: resultOrgId,
      repoId: resultRepoId,
      branch: resultDefaultBranch,
      timestamp: new Date().toISOString(),
    }
    window.dispatchEvent(new CustomEvent(REPO_IMPORT_EVENT, { detail }))
  }, [job, resultDefaultBranch, resultOrgId, resultRepoId])

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
        return 'Paste a GitHub URL to clone and explore it locally.'
      case 'submitting':
        return 'Queuing import…'
      case 'queued':
        return importMode === 'actions'
          ? 'GitHub Actions workflow dispatched. Monitor the run in GitHub.'
          : 'Import queued — waiting for the daemon to start cloning.'
      case 'running':
        return importMode === 'actions'
          ? 'GitHub Actions run in progress. Data will sync when the workflow finishes.'
          : 'Cloning repository...'
      case 'success':
        return importMode === 'actions'
          ? 'GitHub Actions dispatch accepted. Watch the workflow to see progress.'
          : 'Repository imported successfully.'
      case 'error':
        return error ?? 'Import encountered an error.'
      default:
        return null
    }
  })()

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
        <div className={`${statusTextClass} mt-4`}>
          {statusMessage}{' '}
          {status === 'error' && error ? <span className="text-red-400">({error})</span> : null}
          {status === 'success' && importMode === 'daemon' && resultOrgId && resultRepoId ? (
            <span
              className={`inline-flex items-center gap-1 ${isDark ? 'text-emerald-200' : 'text-emerald-600'}`}
            >
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
          {importMode === 'actions' && workflowUrl ? (
            <span className="ml-2 inline-flex items-center gap-1">
              <a
                href={workflowUrl}
                target="_blank"
                rel="noreferrer"
                className={isDark ? 'text-emerald-200 underline' : 'text-emerald-700 underline'}
              >
                View GitHub Actions run
              </a>
              →
            </span>
          ) : null}
        </div>
      ) : null}

      {showSummary && resultOrgId && resultRepoId ? (
        <div className={`${summaryContainerClass} mt-3`}>
          <div className={isDark ? 'font-medium text-slate-100' : 'font-medium text-slate-800'}>
            Target: <code>{resultOrgId}/{resultRepoId}</code>
          </div>
          <div className={isDark ? 'text-slate-200' : 'text-slate-600'}>
            Status: <span className="uppercase tracking-wide text-[11px]">{job?.status ?? 'queued'}</span>
          </div>
          {importMode === 'actions' && workflowUrl ? (
            <div className={isDark ? 'text-slate-200' : 'text-slate-600'}>
              Workflow: <a className="underline" href={workflowUrl} target="_blank" rel="noreferrer">{workflowUrl}</a>
            </div>
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
  const orgId = slugify(parsed?.owner ?? slugifyFallback(url))
  const repoId = slugify(parsed?.repo ?? slugifyFallback(url, 'repo'))
  if (!orgId || !repoId) return null
  return { repoUrl: url, orgId, repoId, branch: null }
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

function slugifyFallback(url: string, type: 'org' | 'repo' = 'org'): string {
  try {
    const { pathname } = new URL(url)
    const parts = pathname.split('/').filter(Boolean)
    if (type === 'org') {
      return slugify(parts[0] ?? 'organisation')
    }
    return slugify(parts[1] ?? 'repository')
  } catch {
    return slugify(type === 'org' ? 'organisation' : 'repository')
  }
}

function deriveSlugs(repoUrl: string): { orgId: string; repoId: string } | null {
  const payload = buildImportPayload(repoUrl)
  if (!payload) return null
  if (!payload.orgId || !payload.repoId) return null
  return { orgId: payload.orgId, repoId: payload.repoId }
}
