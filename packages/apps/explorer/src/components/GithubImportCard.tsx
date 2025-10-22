import * as React from 'react'
import { Link } from '@tanstack/react-router'
import type { PowerSyncImportJob, PowerSyncImportStep } from '@shared/core'
import {
  isDaemonEnabled,
  requestGithubImport,
  fetchGithubImportJob,
  type DaemonGithubImportRequest,
} from '@ps/daemon-client'

type StepStatus = PowerSyncImportStep['status']

const POLL_INTERVAL_MS = 1_500

interface GithubImportFormState {
  repoUrl: string
  orgId: string
  repoId: string
  branch: string
}

const INITIAL_FORM: GithubImportFormState = {
  repoUrl: '',
  orgId: '',
  repoId: '',
  branch: '',
}

export function GithubImportCard(): React.JSX.Element | null {
  const daemonAvailable = React.useMemo(() => isDaemonEnabled(), [])
  const [form, setForm] = React.useState<GithubImportFormState>(INITIAL_FORM)
  const [touched, setTouched] = React.useState<{ org: boolean; repo: boolean }>({ org: false, repo: false })
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = React.useState(false)
  const [job, setJob] = React.useState<PowerSyncImportJob | null>(null)

  React.useEffect(() => {
    if (!job) return undefined
    if (job.status === 'success' || job.status === 'error') return undefined

    let cancelled = false
    const interval = window.setInterval(async () => {
      try {
        const next = await fetchGithubImportJob(job.id)
        if (!cancelled && next) {
          setJob(next)
        }
      } catch (error) {
        console.warn('[Explorer] failed to poll import job', error)
      }
    }, POLL_INTERVAL_MS)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [job])

  if (!daemonAvailable) {
    return (
      <div
        className="rounded-xl border border-dashed border-slate-300 bg-white/70 px-6 py-6 text-sm text-slate-600 shadow-sm"
        data-testid="github-import-card-disabled"
      >
        <h3 className="text-base font-semibold text-slate-800">Import GitHub repository</h3>
        <p className="mt-2">
          Enable the PowerSync daemon (`VITE_POWERSYNC_USE_DAEMON=true`) to import public GitHub repositories directly from the
          explorer.
        </p>
      </div>
    )
  }

  const handleRepoUrlChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value
    setForm((prev) => ({ ...prev, repoUrl: value }))
    const parsed = parseGithubUrl(value)
    if (parsed) {
      if (!touched.org) {
        setForm((prev) => ({ ...prev, orgId: slugify(parsed.owner) }))
      }
      if (!touched.repo) {
        setForm((prev) => ({ ...prev, repoId: slugify(parsed.repo) }))
      }
    }
  }

  const handleOrgChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTouched((prev) => ({ ...prev, org: true }))
    setForm((prev) => ({ ...prev, orgId: event.target.value }))
  }

  const handleRepoChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setTouched((prev) => ({ ...prev, repo: true }))
    setForm((prev) => ({ ...prev, repoId: event.target.value }))
  }

  const handleBranchChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({ ...prev, branch: event.target.value }))
  }

  const resetState = () => {
    setForm(INITIAL_FORM)
    setTouched({ org: false, repo: false })
    setSubmitError(null)
    setJob(null)
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSubmitError(null)

    const repoUrl = form.repoUrl.trim()
    if (!repoUrl) {
      setSubmitError('Provide a GitHub repository URL.')
      return
    }

    const payload: DaemonGithubImportRequest = {
      repoUrl,
      orgId: slugify(form.orgId || slugifyFallback(repoUrl)),
      repoId: slugify(form.repoId || slugifyFallback(repoUrl, 'repo')),
      branch: form.branch.trim() || null,
    }

    if (!payload.orgId || !payload.repoId) {
      setSubmitError('Provide org and repo slugs.')
      return
    }

    setIsSubmitting(true)
    try {
      const queuedJob = await requestGithubImport(payload)
      setJob(queuedJob)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to enqueue import.'
      setSubmitError(message)
    } finally {
      setIsSubmitting(false)
    }
  }

  const activeJobStatus = job?.status ?? null
  const showStatus = Boolean(job)
  const importCompleted = activeJobStatus === 'success'
  const importFailed = activeJobStatus === 'error'
  const resultOrgId = job?.result?.orgId ?? job?.orgId
  const resultRepoId = job?.result?.repoId ?? job?.repoId

  return (
    <div className="rounded-xl border border-slate-200 bg-white/90 p-6 shadow-sm" data-testid="github-import-card">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h3 className="text-lg font-semibold text-slate-900" data-testid="github-import-heading">
            Import a GitHub repository
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            Paste the URL of a public GitHub repository. The daemon will clone it locally, push into PowerSync, and the explorer will
            stream the repo automatically.
          </p>
        </div>
        {(importCompleted || importFailed) && (
          <button
            type="button"
            onClick={resetState}
            className="inline-flex items-center justify-center rounded-md border border-slate-200 px-3 py-1.5 text-sm font-medium text-slate-700 transition hover:border-slate-300 hover:text-slate-900"
          >
            Import another repo
          </button>
        )}
      </div>

      <form className="mt-4 space-y-4" onSubmit={handleSubmit}>
        <div>
          <label className="text-sm font-medium text-slate-700" htmlFor="github-url">
            GitHub URL
          </label>
          <input
            id="github-url"
            name="github-url"
            type="url"
            value={form.repoUrl}
            onChange={handleRepoUrlChange}
            placeholder="https://github.com/powersync/powergit"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            data-testid="github-import-url"
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="text-sm font-medium text-slate-700" htmlFor="import-org">
              PowerSync org slug
            </label>
            <input
              id="import-org"
              name="import-org"
              value={form.orgId}
              onChange={handleOrgChange}
              placeholder="acme"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
              data-testid="github-import-org"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-700" htmlFor="import-repo">
              PowerSync repo slug
            </label>
            <input
              id="import-repo"
              name="import-repo"
              value={form.repoId}
              onChange={handleRepoChange}
              placeholder="infra"
              className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
              data-testid="github-import-repo"
            />
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-slate-700" htmlFor="import-branch">
            Default branch (optional)
          </label>
          <input
            id="import-branch"
            name="import-branch"
            value={form.branch}
            onChange={handleBranchChange}
            placeholder="main"
            className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm text-slate-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-200"
            data-testid="github-import-branch"
          />
          <p className="mt-1 text-xs text-slate-500">
            Leave blank to use the repo&apos;s default branch. All branches and tags are pushed to PowerSync.
          </p>
        </div>

        {submitError ? <p className="text-sm text-red-600">{submitError}</p> : null}

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={isSubmitting}
            className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-blue-500 disabled:cursor-not-allowed disabled:bg-blue-300"
            data-testid="github-import-submit"
          >
            {isSubmitting ? 'Starting import…' : 'Start import'}
          </button>
          <p className="text-xs text-slate-500">
            The daemon performs the clone locally and reports progress here.
          </p>
        </div>
      </form>

      {showStatus ? <ImportStatus job={job!} /> : null}

      {importCompleted && resultOrgId && resultRepoId ? (
        <div
          className="mt-4 flex flex-wrap items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
          data-testid="github-import-success"
        >
          <span className="font-semibold">Import complete.</span>
          <Link
            to="/org/$orgId/repo/$repoId"
            params={{ orgId: resultOrgId, repoId: resultRepoId }}
            className="rounded-md bg-emerald-600 px-3 py-1 text-xs font-medium text-white shadow-sm transition hover:bg-emerald-500"
            data-testid="github-import-open-repo"
          >
            Open repository →
          </Link>
        </div>
      ) : null}

      {importFailed && submitError === null ? (
        <div className="mt-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Import failed. Expand the steps below for more detail and try again.
        </div>
      ) : null}
    </div>
  )
}

function ImportStatus({ job }: { job: PowerSyncImportJob }) {
  const statusLabel = React.useMemo(() => {
    switch (job.status) {
      case 'queued':
        return 'Queued'
      case 'running':
        return 'In progress'
      case 'success':
        return 'Complete'
      case 'error':
        return 'Failed'
      default:
        return job.status
    }
  }, [job.status])

  return (
    <div
      className="mt-6 rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-inner"
      data-testid="github-import-status"
      data-status={job.status}
    >
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium text-slate-700">Import status</p>
          <p className="text-xs text-slate-500">{new Date(job.updatedAt).toLocaleString()}</p>
        </div>
        <StatusBadge status={job.status} label={statusLabel} />
      </div>
      <ul className="mt-4 space-y-2">
        {job.steps.map((step) => (
          <li
            key={step.id}
            className={stepClassName(step.status)}
            data-testid="github-import-step"
            data-step-id={step.id}
            data-status={step.status}
          >
            <div className="flex h-8 w-8 flex-none items-center justify-center rounded-full text-sm font-semibold text-white">
              {statusIndicator(step.status)}
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-800">{step.label}</p>
              {step.detail ? <p className="text-xs text-slate-500">{step.detail}</p> : null}
            </div>
          </li>
        ))}
      </ul>
      {job.logs.length > 0 ? (
        <details className="mt-3 text-xs text-slate-500">
          <summary className="cursor-pointer select-none text-slate-600">View daemon logs</summary>
          <ul className="mt-2 space-y-1">
            {job.logs.slice(-6).map((entry) => (
              <li key={entry.id}>
                <span className="font-semibold uppercase text-slate-400">{entry.level}</span> ·{' '}
                <span>{new Date(entry.timestamp).toLocaleTimeString()}</span> · <span>{entry.message}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {job.status === 'error' && job.error ? <p className="mt-3 text-sm text-red-600">{job.error}</p> : null}
    </div>
  )
}

function StatusBadge({ status, label }: { status: PowerSyncImportJob['status']; label: string }) {
  const styles: Record<PowerSyncImportJob['status'], string> = {
    queued: 'bg-slate-100 text-slate-700',
    running: 'bg-blue-100 text-blue-700',
    success: 'bg-emerald-100 text-emerald-700',
    error: 'bg-red-100 text-red-700',
  }
  return <span className={`inline-flex rounded-full px-3 py-1 text-xs font-semibold ${styles[status]}`}>{label}</span>
}

function statusIndicator(status: StepStatus): string {
  switch (status) {
    case 'done':
      return '✓'
    case 'active':
      return '…'
    case 'error':
      return '!'
    default:
      return '•'
  }
}

function stepClassName(status: StepStatus): string {
  switch (status) {
    case 'done':
      return 'flex items-start gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800'
    case 'active':
      return 'flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800'
    case 'error':
      return 'flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800'
    default:
      return 'flex items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700'
  }
}

function parseGithubUrl(raw: string): { owner: string; repo: string } | null {
  const candidate = raw.trim()
  if (!candidate) return null

  let normalized = candidate
  if (!/^[a-z]+:\/\//i.test(normalized)) {
    if (normalized.startsWith('github.com/')) {
      normalized = `https://${normalized}`
    } else if (/^[\w.-]+\/[\w.-]+(?:\.git)?$/i.test(normalized)) {
      normalized = `https://github.com/${normalized}`
    } else {
      normalized = `https://${normalized}`
    }
  }

  try {
    const url = new URL(normalized)
    const host = url.hostname.toLowerCase()
    if (host !== 'github.com' && host !== 'www.github.com') return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    let repo = parts[1] ?? ''
    if (!repo) return null
    if (repo.toLowerCase().endsWith('.git')) {
      repo = repo.slice(0, -4)
    }
    return { owner: parts[0] ?? '', repo }
  } catch {
    return null
  }
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

function slugifyFallback(repoUrl: string, type: 'org' | 'repo' = 'org'): string {
  const parsed = parseGithubUrl(repoUrl)
  if (!parsed) return ''
  return slugify(type === 'org' ? parsed.owner : parsed.repo)
}
