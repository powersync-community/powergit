import { DEFAULT_DAEMON_URL, ensureDaemonReady, normalizeBaseUrl } from '../index.js'

const REQUEST_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_REQUEST_TIMEOUT_MS ?? '5000', 10)

export type DaemonAuthStatus =
  | { status: 'ready'; token: string; expiresAt?: string | null; context?: Record<string, unknown> | null }
  | { status: 'pending'; reason?: string | null; context?: Record<string, unknown> | null }
  | { status: 'auth_required'; reason?: string | null; context?: Record<string, unknown> | null }
  | { status: 'error'; reason?: string | null; context?: Record<string, unknown> | null }

export interface ResolveDaemonOptions {
  daemonUrl?: string
}

export interface AuthDevicePayload {
  mode?: 'device-code' | 'browser'
  endpoint?: string
  metadata?: Record<string, unknown> | null
  challengeId?: string
  session?: {
    access_token: string
    refresh_token: string
    expires_in?: number | null
    expires_at?: number | null
  }
}

interface JsonResponse<T> {
  status: number
  ok: boolean
  body: T | null
}

async function request<T>(baseUrl: string, path: string, init: RequestInit = {}): Promise<JsonResponse<T>> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        ...(init.headers ?? {}),
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    })
    let body: T | null = null
    try {
      body = (await response.json()) as T
    } catch {
      body = null
    }
    return { status: response.status, ok: response.ok, body }
  } finally {
    clearTimeout(timeout)
  }
}

function normalizeContext(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== 'object') return null
  if (Array.isArray(payload)) return null
  return payload as Record<string, unknown>
}

type DaemonAuthStatusBody = {
  status?: string
  token?: unknown
  expiresAt?: string | null
  reason?: string | null
  context?: unknown
}

function normalizeAuthStatus(payload: unknown): DaemonAuthStatus | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }
  const status = (payload as { status?: unknown }).status
  if (status === 'ready') {
    const tokenCandidate = (payload as { token?: unknown }).token
    const token =
      typeof tokenCandidate === 'string'
        ? tokenCandidate.trim()
        : typeof tokenCandidate === 'object' && tokenCandidate !== null
          ? typeof (tokenCandidate as { token?: unknown }).token === 'string'
            ? ((tokenCandidate as { token?: unknown }).token as string).trim()
            : typeof (tokenCandidate as { value?: unknown }).value === 'string'
              ? ((tokenCandidate as { value?: unknown }).value as string).trim()
              : ''
          : ''
    if (!token) return null
    const expiresAtCandidate = (payload as { expiresAt?: unknown }).expiresAt
    const expiresAt = typeof expiresAtCandidate === 'string' ? expiresAtCandidate : null
    const context = normalizeContext((payload as { context?: unknown }).context)
    return { status: 'ready', token, expiresAt, context }
  }
  const reasonCandidate = (payload as { reason?: unknown }).reason
  const reason = typeof reasonCandidate === 'string' ? reasonCandidate : null
  if (status === 'pending' || status === 'auth_required' || status === 'error') {
    const context = normalizeContext((payload as { context?: unknown }).context)
    return { status, reason, context } as DaemonAuthStatus
  }
  return null
}

export async function resolveDaemonBaseUrl(options: ResolveDaemonOptions = {}): Promise<string> {
  const baseUrl = normalizeBaseUrl(options.daemonUrl ?? DEFAULT_DAEMON_URL)
  await ensureDaemonReady(baseUrl)
  return baseUrl
}

export async function fetchDaemonAuthStatus(baseUrl: string): Promise<DaemonAuthStatus | null> {
  const result = await request<DaemonAuthStatusBody>(
    baseUrl,
    '/auth/status',
  )
  return normalizeAuthStatus(result.body)
}

export async function postDaemonAuthDevice(
  baseUrl: string,
  payload: AuthDevicePayload = {},
): Promise<DaemonAuthStatus | null> {
  const result = await request<DaemonAuthStatusBody>(
    baseUrl,
    '/auth/device',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  )
  return normalizeAuthStatus(result.body)
}

export async function postDaemonAuthLogout(baseUrl: string): Promise<DaemonAuthStatus | null> {
  const result = await request<DaemonAuthStatusBody>(
    baseUrl,
    '/auth/logout',
    {
      method: 'POST',
    },
  )
  return normalizeAuthStatus(result.body)
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
  if (typeof challengeIdValue !== 'string' || !challengeIdValue.trim()) return null
  const challengeId = challengeIdValue.trim()
  const verificationUrl = typeof context.verificationUrl === 'string' ? context.verificationUrl : null
  const expiresAt = typeof context.expiresAt === 'string' ? context.expiresAt : null
  const mode = typeof context.mode === 'string' ? context.mode : null
  return { challengeId, verificationUrl, expiresAt, mode }
}

export interface CompleteDeviceLoginPayload {
  challengeId: string
  session: {
    access_token: string
    refresh_token: string
    expires_in?: number | null
    expires_at?: number | null
  }
  endpoint?: string | null
  metadata?: Record<string, unknown> | null
}

export async function completeDaemonDeviceLogin(
  baseUrl: string,
  payload: CompleteDeviceLoginPayload,
): Promise<DaemonAuthStatus | null> {
  return postDaemonAuthDevice(baseUrl, {
    challengeId: payload.challengeId,
    endpoint: payload.endpoint ?? undefined,
    metadata: payload.metadata ?? null,
    session: payload.session,
  })
}
