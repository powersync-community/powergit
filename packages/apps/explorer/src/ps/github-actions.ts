import type { PowerSyncImportJob } from '@powersync-community/powergit-core'
import { getAccessToken } from './supabase'

const DEFAULT_SUPABASE_URL = 'http://127.0.0.1:55431'

function readEnvString(name: string): string | null {
  const env = import.meta.env as Record<string, string | undefined>
  const value = env[name]
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function resolveFunctionUrl(): string {
  const baseUrl = readEnvString('VITE_SUPABASE_URL') ?? DEFAULT_SUPABASE_URL
  return `${baseUrl.replace(/\/$/, '')}/functions/v1/github-import`
}

function resolveEdgeBaseUrl(): string | null {
  return readEnvString('VITE_POWERSYNC_EDGE_BASE_URL') ?? null
}

export interface GithubActionsImportRequest {
  repoUrl: string
  orgId?: string | null
  repoId?: string | null
  branch?: string | null
}

export async function dispatchGithubImport(
  payload: GithubActionsImportRequest,
): Promise<PowerSyncImportJob> {
  const url = resolveFunctionUrl()
  const token = await getAccessToken().catch(() => null)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  const body = {
    repoUrl: payload.repoUrl,
    orgId: payload.orgId ?? null,
    repoId: payload.repoId ?? null,
    branch: payload.branch ?? null,
    edgeBaseUrl: resolveEdgeBaseUrl(),
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const reason = text ? ` — ${text}` : ''
    throw new Error(`GitHub Actions dispatch failed (${res.status})${reason}`)
  }

  const data = (await res.json().catch(() => null)) as { job?: PowerSyncImportJob; error?: string } | null
  if (data?.error) {
    throw new Error(data.error)
  }
  if (!data?.job) {
    throw new Error('GitHub Actions dispatch did not return a job payload.')
  }
  return data.job
}
