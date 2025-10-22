import { extractJwtMetadata } from './token.js'
import { clearStoredCredentials, saveStoredCredentials, type StoredCredentials } from './session.js'
import {
  extractDeviceChallenge,
  fetchDaemonAuthStatus,
  postDaemonAuthDevice,
  postDaemonAuthGuest,
  postDaemonAuthLogout,
  resolveDaemonBaseUrl,
  type DaemonAuthStatus,
  type DaemonDeviceChallenge,
} from './daemon-client.js'
import { DEFAULT_DAEMON_URL, normalizeBaseUrl } from '../index.js'

export interface LoginOptions {
  endpoint?: string
  token?: string
  sessionPath?: string
  verbose?: boolean
  supabaseEmail?: string
  supabasePassword?: string
  supabaseUrl?: string
  supabaseAnonKey?: string
  persistSession?: boolean
}

export interface LoginResult {
  credentials: StoredCredentials
  source: 'manual' | 'supabase-password'
}

export interface DaemonGuestLoginOptions {
  daemonUrl?: string
  endpoint?: string
  token?: string
  expiresAt?: string | null
  obtainedAt?: string | null
  metadata?: Record<string, unknown> | null
}

export interface DaemonGuestLoginResult {
  baseUrl: string
  status: DaemonAuthStatus | null
}

export interface DaemonDeviceLoginOptions {
  daemonUrl?: string
  endpoint?: string
  metadata?: Record<string, unknown> | null
  mode?: 'device-code' | 'browser'
  pollIntervalMs?: number
  timeoutMs?: number
  onStatus?: (status: DaemonAuthStatus | null, attempts: number) => void
}

export interface DaemonDeviceLoginResult {
  baseUrl: string
  initialStatus: DaemonAuthStatus | null
  finalStatus: DaemonAuthStatus | null
  attempts: number
  timedOut: boolean
  challenge?: DaemonDeviceChallenge | null
}

const DEFAULT_POLL_INTERVAL_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_AUTH_POLL_INTERVAL_MS ?? '2000', 10)
const DEFAULT_POLL_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_AUTH_TIMEOUT_MS ?? '120000', 10)

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function inferSupabaseUrl(explicit?: string): string | undefined {
  if (explicit) return explicit
  return process.env.POWERSYNC_SUPABASE_URL ?? process.env.PSGIT_TEST_SUPABASE_URL ?? process.env.SUPABASE_URL
}

function inferSupabaseAnonKey(explicit?: string): string | undefined {
  if (explicit) return explicit
  return process.env.POWERSYNC_SUPABASE_ANON_KEY ?? process.env.PSGIT_TEST_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY
}

function inferSupabaseEmail(explicit?: string): string | undefined {
  if (explicit) return explicit
  return process.env.POWERSYNC_SUPABASE_EMAIL ?? process.env.PSGIT_TEST_SUPABASE_EMAIL
}

function inferSupabasePassword(explicit?: string): string | undefined {
  if (explicit) return explicit
  return process.env.POWERSYNC_SUPABASE_PASSWORD ?? process.env.PSGIT_TEST_SUPABASE_PASSWORD
}

export async function loginWithExplicitToken(options: LoginOptions): Promise<LoginResult> {
  const endpoint = options.endpoint ?? process.env.POWERSYNC_ENDPOINT ?? process.env.PSGIT_TEST_ENDPOINT
  const token = options.token ?? process.env.POWERSYNC_TOKEN ?? process.env.PSGIT_TEST_REMOTE_TOKEN
  if (!endpoint || !token) {
    throw new Error('Endpoint and token are required. Provide --endpoint/--token or set POWERSYNC_ENDPOINT + POWERSYNC_TOKEN.')
  }

  const metadata = extractJwtMetadata(token)
  const credentials: StoredCredentials = {
    endpoint,
    token,
    expiresAt: metadata.expiresAt,
    obtainedAt: metadata.issuedAt ?? new Date().toISOString(),
  }
  if (options.persistSession ?? true) {
    await saveStoredCredentials(credentials, options.sessionPath)
  }
  return { credentials, source: 'manual' }
}

export async function loginWithSupabasePassword(options: LoginOptions = {}): Promise<LoginResult> {
  const supabaseUrl = inferSupabaseUrl(options.supabaseUrl)
  const supabaseAnonKey = inferSupabaseAnonKey(options.supabaseAnonKey)
  const email = inferSupabaseEmail(options.supabaseEmail)
  const password = inferSupabasePassword(options.supabasePassword)
  const endpoint = options.endpoint ?? process.env.POWERSYNC_ENDPOINT ?? process.env.PSGIT_TEST_ENDPOINT

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase URL and anon key are required for Supabase login. Set POWERSYNC_SUPABASE_URL and POWERSYNC_SUPABASE_ANON_KEY.')
  }
  if (!email || !password) {
    throw new Error('Supabase email and password are required. Use --supabase-email/--supabase-password or set POWERSYNC_SUPABASE_EMAIL/POWERSYNC_SUPABASE_PASSWORD.')
  }
  if (!endpoint) {
    throw new Error('PowerSync endpoint is required. Set POWERSYNC_ENDPOINT or provide --endpoint.')
  }

  const tokenUrl = `${supabaseUrl.replace(/\/$/, '')}/auth/v1/token?grant_type=password`
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`,
    },
    body: JSON.stringify({ email, password }),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Supabase login failed (${response.status} ${response.statusText}) ${text}`)
  }

  const result = (await response.json().catch(() => ({}))) as { access_token?: string }
  const token = result?.access_token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Supabase login response did not include an access_token.')
  }

  const metadata = extractJwtMetadata(token)
  const credentials: StoredCredentials = {
    endpoint,
    token,
    expiresAt: metadata.expiresAt,
    obtainedAt: metadata.issuedAt ?? new Date().toISOString(),
  }

  if (options.persistSession ?? true) {
    await saveStoredCredentials(credentials, options.sessionPath)
  }
  return { credentials, source: 'supabase-password' }
}

export async function loginWithDaemonGuest(options: DaemonGuestLoginOptions = {}): Promise<DaemonGuestLoginResult> {
  const baseUrl = await resolveDaemonBaseUrl({ daemonUrl: options.daemonUrl })
  let status = await postDaemonAuthGuest(baseUrl, {
    token: options.token,
    endpoint: options.endpoint,
    expiresAt: options.expiresAt ?? null,
    obtainedAt: options.obtainedAt ?? null,
    metadata: options.metadata ?? null,
  })

  if (!status || status.status !== 'ready' || !status.token) {
    const refreshed = await fetchDaemonAuthStatus(baseUrl)
    if (refreshed && refreshed.status === 'ready' && refreshed.token) {
      status = refreshed
    }
  }

  return { baseUrl, status }
}

export async function loginWithDaemonDevice(options: DaemonDeviceLoginOptions = {}): Promise<DaemonDeviceLoginResult> {
  const baseUrl = await resolveDaemonBaseUrl({ daemonUrl: options.daemonUrl })
  const initialStatus = await postDaemonAuthDevice(baseUrl, {
    mode: options.mode ?? 'device-code',
    endpoint: options.endpoint,
    metadata: options.metadata ?? null,
  })
  options.onStatus?.(initialStatus, 0)
  let challenge = extractDeviceChallenge(initialStatus)
  if (initialStatus?.status === 'ready') {
    return { baseUrl, initialStatus, finalStatus: initialStatus, attempts: 0, timedOut: false, challenge }
  }

  const pollInterval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS
  const deadline = Date.now() + timeoutMs

  let attempts = 0
  let finalStatus: DaemonAuthStatus | null = initialStatus

  while (Date.now() < deadline) {
    await delay(pollInterval)
    attempts += 1
    finalStatus = await fetchDaemonAuthStatus(baseUrl)
    options.onStatus?.(finalStatus, attempts)
    if (!finalStatus) {
      continue
    }
    const currentChallenge = extractDeviceChallenge(finalStatus)
    if (currentChallenge) {
      challenge = currentChallenge
    }
    if (finalStatus.status === 'ready' || finalStatus.status === 'error' || finalStatus.status === 'auth_required') {
      return { baseUrl, initialStatus, finalStatus, attempts, timedOut: false, challenge }
    }
  }

  finalStatus = await fetchDaemonAuthStatus(baseUrl)
  const finalChallenge = extractDeviceChallenge(finalStatus)
  if (finalChallenge) {
    challenge = finalChallenge
  }
  return { baseUrl, initialStatus, finalStatus, attempts, timedOut: true, challenge }
}

export async function logout(options: { sessionPath?: string; daemonUrl?: string } = {}) {
  await clearStoredCredentials(options.sessionPath)
  const baseUrl = normalizeBaseUrl(options.daemonUrl ?? DEFAULT_DAEMON_URL)
  try {
    await postDaemonAuthLogout(baseUrl)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (process.env.POWERSYNC_DEBUG_LOGOUT === '1') {
      console.warn('[psgit] failed to notify daemon logout', message)
    }
  }
}
