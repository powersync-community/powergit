import { createClient } from '@supabase/supabase-js'
import { createSupabaseFileStorage, clearSupabaseFileStorage } from '@shared/core'
import { extractJwtMetadata } from './token.js'
import {
  clearStoredCredentials,
  saveStoredCredentials,
  resolveSupabaseSessionPath,
  type StoredCredentials,
} from './session.js'
import {
  extractDeviceChallenge,
  fetchDaemonAuthStatus,
  postDaemonAuthDevice,
  postDaemonAuthLogout,
  resolveDaemonBaseUrl,
  type DaemonAuthStatus,
  type DaemonDeviceChallenge,
} from './daemon-client.js'
import { DEFAULT_DAEMON_URL, normalizeBaseUrl } from '../index.js'

export interface LoginOptions {
  endpoint?: string
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
  source: 'supabase-password'
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

  const persistSession = options.persistSession ?? true
  const supabaseStoragePath = resolveSupabaseSessionPath(options.sessionPath)
  const storage = persistSession ? createSupabaseFileStorage(supabaseStoragePath) : null
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession,
      autoRefreshToken: true,
      storage: storage ?? undefined,
      storageKey: 'psgit',
    },
  })

  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    throw new Error(`Supabase login failed (${error.name ?? 'AuthError'}): ${error.message}`)
  }

  const session = data?.session ?? (await supabase.auth.getSession()).data.session
  const token = session?.access_token
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

  if (persistSession) {
    await saveStoredCredentials(credentials, options.sessionPath)
  }
  return { credentials, source: 'supabase-password' }
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
  const supabaseSessionPath = resolveSupabaseSessionPath(options.sessionPath)
  if (typeof clearSupabaseFileStorage === 'function') {
    await clearSupabaseFileStorage(supabaseSessionPath)
  }
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
