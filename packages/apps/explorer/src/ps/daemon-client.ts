import type { PowerSyncImportJob } from '@powersync-community/powergit-core'
import { getAccessToken } from './supabase'
import { dispatchGithubImport, type GithubActionsImportRequest } from './github-actions'

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:8787'
const REQUEST_TIMEOUT_MS = 5_000

function readEnvFlag(name: string, fallback = 'false') {
  const env = import.meta.env as Record<string, string | undefined>
  return (env[name]?.trim() ?? fallback).toLowerCase() === 'true'
}

function readEnvString(name: string): string | null {
  const env = import.meta.env as Record<string, string | undefined>
  const value = env[name]
  if (!value) return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

const daemonBaseUrl = readEnvString('VITE_POWERSYNC_DAEMON_URL') ?? DEFAULT_DAEMON_URL
const daemonEnabled = readEnvFlag('VITE_POWERSYNC_USE_DAEMON')
const actionsImportEnabled = readEnvFlag('VITE_POWERSYNC_ACTIONS_IMPORT', 'true')
export function isDaemonEnabled(): boolean {
  return daemonEnabled
}

export function isGithubActionsImportEnabled(): boolean {
  return !daemonEnabled && actionsImportEnabled
}

export type ImportMode = 'daemon' | 'actions'

declare global {
  interface Window {
    __powersyncImportModeOverride?: ImportMode
  }
}

export function getImportMode(): ImportMode {
  const override =
    typeof window !== 'undefined'
      ? (window as typeof window & { __powersyncImportModeOverride?: ImportMode }).__powersyncImportModeOverride
      : undefined
  if (override === 'daemon' || override === 'actions') {
    return override
  }
  if (daemonEnabled) return 'daemon'
  return actionsImportEnabled ? 'actions' : 'daemon'
}

type DaemonAuthStatusPayload = {
  status: 'ready' | 'pending' | 'auth_required' | 'error'
  token?: string | { token?: string; value?: string }
  expiresAt?: string | null
  reason?: string | null
  context?: Record<string, unknown> | null
}

export type DaemonAuthStatus =
  | { status: 'ready'; token: string; expiresAt?: string | null; context?: Record<string, unknown> | null }
  | { status: 'pending'; reason?: string | null; context?: Record<string, unknown> | null }
  | { status: 'auth_required'; reason?: string | null; context?: Record<string, unknown> | null }
  | { status: 'error'; reason?: string | null; context?: Record<string, unknown> | null }

function normalizeToken(raw: DaemonAuthStatusPayload['token']): string | null {
  if (!raw) return null
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (typeof raw === 'object') {
    const fromToken = typeof raw.token === 'string' ? raw.token.trim() : ''
    if (fromToken) return fromToken
    const fromValue = typeof raw.value === 'string' ? raw.value.trim() : ''
    if (fromValue) return fromValue
  }
  return null
}

function normalizeContext(raw: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!raw) return null
  if (typeof raw !== 'object') return null
  if (Array.isArray(raw)) return null
  return raw
}

function normalizeAuthStatus(payload: DaemonAuthStatusPayload | null): DaemonAuthStatus | null {
  if (!payload) return null
  switch (payload.status) {
    case 'ready': {
      const token = normalizeToken(payload.token)
      if (!token) {
        console.warn('[Explorer][daemon] ready status missing token payload')
        return null
      }
      return { status: 'ready', token, expiresAt: payload.expiresAt ?? null, context: normalizeContext(payload.context) }
    }
    case 'pending':
      return { status: 'pending', reason: payload.reason ?? null, context: normalizeContext(payload.context) }
    case 'auth_required':
      return { status: 'auth_required', reason: payload.reason ?? null, context: normalizeContext(payload.context) }
    case 'error':
      return { status: 'error', reason: payload.reason ?? null, context: normalizeContext(payload.context) }
    default:
      console.warn('[Explorer][daemon] unknown auth status received', payload)
      return null
  }
}

async function fetchJson<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T | null> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(input, { ...init, signal: controller.signal })
    if (!res.ok) {
      return null
    }
    return (await res.json()) as T
  } catch (error) {
    console.warn('[Explorer][daemon] request failed', error)
    return null
  } finally {
    clearTimeout(timeout)
  }
}

async function postJson(path: string, body?: Record<string, unknown>): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(`${daemonBaseUrl}${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    return res.ok
  } catch (error) {
    console.warn('[Explorer][daemon] POST request failed', error)
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function fetchDaemonJson<T>(path: string, init?: RequestInit): Promise<{ status: number; data: T | null }> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(`${daemonBaseUrl}${path}`, { ...init, signal: controller.signal })
    const status = res.status
    let data: T | null = null
    try {
      data = (await res.json()) as T
    } catch {
      data = null
    }
    return { status, data }
  } catch (error) {
    console.warn('[Explorer][daemon] request failed', error)
    return { status: 0, data: null }
  } finally {
    clearTimeout(timeout)
  }
}

export async function fetchDaemonAuthStatus(): Promise<DaemonAuthStatus | null> {
  if (!daemonEnabled) {
    return null
  }
  const payload = await fetchJson<DaemonAuthStatusPayload>(`${daemonBaseUrl}/auth/status`)
  return normalizeAuthStatus(payload)
}

export interface DaemonDeviceChallenge {
  challengeId: string
  verificationUrl?: string | null
  expiresAt?: string | null
  mode?: string | null
}

export function extractDeviceChallenge(status: DaemonAuthStatus | null): DaemonDeviceChallenge | null {
  if (!status || !status.context) return null
  const context = status.context as Record<string, unknown>
  const challengeIdValue =
    context.challengeId ??
    context.deviceCode ??
    (context as { device_code?: unknown }).device_code ??
    (context as { state?: unknown }).state
  if (typeof challengeIdValue !== 'string' || !challengeIdValue.trim()) {
    return null
  }
  const challengeId = challengeIdValue.trim()
  const verificationUrl = typeof context.verificationUrl === 'string' ? context.verificationUrl : null
  const expiresAt = typeof context.expiresAt === 'string' ? context.expiresAt : null
  const mode = typeof context.mode === 'string' ? context.mode : null
  return { challengeId, verificationUrl, expiresAt, mode }
}

export async function getDaemonToken(): Promise<string | null> {
  if (!daemonEnabled) {
    return null
  }

  const status = await fetchDaemonAuthStatus()

  if (!status) {
    return null
  }

  if (status.status === 'ready') {
    return status.token
  }

  if (status.status === 'auth_required') {
    console.warn('[Explorer][daemon] authentication required; daemon has no PowerSync token available')
  } else if (status.status === 'pending') {
    console.info('[Explorer][daemon] authentication pending; waiting for daemon to complete login flow')
  } else if (status.status === 'error') {
    console.warn('[Explorer][daemon] daemon reported auth error', status.reason ?? '')
  }

  return null
}

export async function obtainPowerSyncToken(): Promise<string | null> {
  if (daemonEnabled) {
    return getDaemonToken()
  }
  return getAccessToken()
}

export async function notifyDaemonLogout(): Promise<boolean> {
  if (!daemonEnabled) {
    return false
  }
  return postJson('/auth/logout').catch(() => false)
}

export function isDaemonPreferred(): boolean {
  return daemonEnabled
}

type PackUrlResponse = { url?: string; expiresAt?: string | null; sizeBytes?: number | null }

export async function requestPackDownloadUrl(orgId: string, repoId: string, packOid: string): Promise<PackUrlResponse | null> {
  if (!daemonEnabled) return null
  const path = `/orgs/${encodeURIComponent(orgId)}/repos/${encodeURIComponent(repoId)}/packs/${encodeURIComponent(packOid)}`
  const { status, data } = await fetchDaemonJson<PackUrlResponse>(path)
  if (status !== 200 || !data?.url) {
    return null
  }
  return data
}

export async function downloadPackBytes(orgId: string, repoId: string, packOid: string): Promise<Uint8Array | null> {
  const maxAttempts = 5
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const info = await requestPackDownloadUrl(orgId, repoId, packOid)
    if (info?.url) {
      try {
        const res = await fetch(info.url)
        if (!res.ok) {
          console.warn('[Explorer][daemon] pack download returned', res.status, packOid)
        } else {
          const buffer = await res.arrayBuffer()
          return new Uint8Array(buffer)
        }
      } catch (error) {
        console.error('[Explorer][daemon] failed to download pack', error)
      }
    }
    if (attempt < maxAttempts) {
      await delay(400 * attempt)
    }
  }
  return null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

export async function deleteDaemonRepo(orgId: string, repoId: string): Promise<boolean> {
  if (!daemonEnabled) return false
  const path = `/orgs/${encodeURIComponent(orgId)}/repos/${encodeURIComponent(repoId)}`
  try {
    const res = await fetch(`${daemonBaseUrl}${path}`, { method: 'DELETE' })
    return res.ok
  } catch (error) {
    console.warn('[Explorer][daemon] failed to delete repo', error)
    return false
  }
}

export async function completeDaemonDeviceLogin(payload: {
  challengeId: string
  token: string
  endpoint?: string | null
  expiresAt?: string | null
  obtainedAt?: string | null
  metadata?: Record<string, unknown> | null
}): Promise<boolean> {
  if (!daemonEnabled) return false
  return postJson('/auth/device', {
    challengeId: payload.challengeId,
    token: payload.token,
    endpoint: payload.endpoint ?? null,
    expiresAt: payload.expiresAt ?? null,
    obtainedAt: payload.obtainedAt ?? null,
    metadata: payload.metadata ?? null,
  })
}

export interface DaemonGithubImportRequest {
  repoUrl: string
  orgId?: string | null
  repoId?: string | null
  branch?: string | null
}

export async function requestGithubImport(payload: DaemonGithubImportRequest): Promise<PowerSyncImportJob> {
  if (daemonEnabled) {
    const { status, data } = await fetchDaemonJson<{ job?: PowerSyncImportJob; error?: string }>('/repos/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        repoUrl: payload.repoUrl,
        orgId: payload.orgId ?? null,
        repoId: payload.repoId ?? null,
        branch: payload.branch ?? null,
      }),
    })

    if (status === 202 || status === 200) {
      const job = data?.job ?? null
      if (!job) {
        throw new Error('Daemon did not return an import job payload.')
      }
      return job
    }

    if (status === 400) {
      const message =
        typeof data?.error === 'string' && data.error.trim().length > 0 ? data.error : 'Invalid GitHub repository details.'
      throw new Error(message)
    }

    if (status === 0) {
      throw new Error('PowerSync daemon is unreachable. Ensure it is running locally.')
    }

    throw new Error(`Daemon import request failed (${status}).`)
  }

  if (!actionsImportEnabled) {
    throw new Error('GitHub Actions import is disabled in this environment.')
  }

  return dispatchGithubImport(payload as GithubActionsImportRequest)
}

export async function fetchGithubImportJob(jobId: string): Promise<PowerSyncImportJob | null> {
  if (!daemonEnabled) {
    return null
  }
  const { status, data } = await fetchDaemonJson<{ job?: PowerSyncImportJob }>(`/repos/import/${encodeURIComponent(jobId)}`, {
    method: 'GET',
  })
  if (status === 200) {
    return data?.job ?? null
  }
  if (status === 404 || status === 0) {
    return null
  }
  return null
}

export async function listGithubImportJobs(): Promise<PowerSyncImportJob[]> {
  if (!daemonEnabled) {
    return []
  }
  const { status, data } = await fetchDaemonJson<{ jobs?: PowerSyncImportJob[] }>('/repos/import', {
    method: 'GET',
  })
  if (status === 200 && Array.isArray(data?.jobs)) {
    return data.jobs
  }
  return []
}
