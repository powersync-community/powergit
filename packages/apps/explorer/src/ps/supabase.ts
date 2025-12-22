import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js'
import { getRuntimeConfigString } from './runtime-config'

let cachedClient: SupabaseClient | null = null

const FALLBACK_ENV_KEYS: Record<string, string[]> = {
  VITE_SUPABASE_URL: ['POWERGIT_TEST_SUPABASE_URL'],
  VITE_SUPABASE_ANON_KEY: ['POWERGIT_TEST_SUPABASE_ANON_KEY'],
  VITE_SUPABASE_SCHEMA: [],
  VITE_POWERSYNC_ENDPOINT: ['POWERSYNC_URL', 'POWERGIT_TEST_ENDPOINT'],
}

const FALLBACK_DEFAULTS: Record<string, string> = {
  VITE_SUPABASE_URL: 'http://127.0.0.1:55431',
  VITE_SUPABASE_ANON_KEY:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0',
  VITE_POWERSYNC_ENDPOINT: 'http://127.0.0.1:55440',
  POWERSYNC_DAEMON_DEVICE_URL: 'http://localhost:5783/auth',
}

const PLACEHOLDER_VALUES = new Set([
  'dev-token-placeholder',
  'anon-placeholder',
  'service-role-placeholder',
  'powersync-remote-placeholder',
])

function isPlaceholder(value: string | undefined | null): boolean {
  if (!value) return true
  const trimmed = value.trim()
  if (!trimmed) return true
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return true
  if (/^https?:\/\/localhost(?::\d+)?\/?$/.test(trimmed.toLowerCase()) && trimmed.includes('8090')) return true
  return false
}

function readEnv(name: string): string | null {
  const runtimeValue =
    name === 'VITE_SUPABASE_URL'
      ? getRuntimeConfigString('supabaseUrl')
      : name === 'VITE_SUPABASE_ANON_KEY'
        ? getRuntimeConfigString('supabaseAnonKey')
        : name === 'VITE_SUPABASE_SCHEMA'
          ? getRuntimeConfigString('supabaseSchema')
          : null
  if (runtimeValue) {
    return runtimeValue
  }

  const env = import.meta.env as Record<string, string | undefined>
  const runtimeEnv = ((globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env) ?? {}

  const candidates: Array<string | undefined> = [env?.[name], runtimeEnv?.[name]]
  const fallbacks = FALLBACK_ENV_KEYS[name] ?? []
  for (const fallbackKey of fallbacks) {
    candidates.push(env?.[fallbackKey], runtimeEnv?.[fallbackKey])
  }
  candidates.push(FALLBACK_DEFAULTS[name])

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.trim()
    if (trimmed.length > 0 && !isPlaceholder(trimmed)) {
      return trimmed
    }
  }
  return null
}

function resolveAppRedirectUrl(pathname: string): string | null {
  if (typeof window === 'undefined') return null
  const base = typeof import.meta.env.BASE_URL === 'string' ? import.meta.env.BASE_URL : '/'
  const normalizedBase = base.replace(/\/$/, '')
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`
  try {
    return new URL(`${normalizedBase}${normalizedPath}`, window.location.origin).toString()
  } catch {
    return null
  }
}

function getInjectedSupabase(): SupabaseClient | null {
  const globalObj = globalThis as typeof globalThis & { __supabaseMock?: SupabaseClient }
  if (globalObj.__supabaseMock) {
    return globalObj.__supabaseMock
  }
  return null
}

export function getSupabase(): SupabaseClient | null {
  if (cachedClient) return cachedClient

  const injected = getInjectedSupabase()
  if (injected) {
    cachedClient = injected
    return cachedClient
  }

  const url = readEnv('VITE_SUPABASE_URL')
  const anonKey = readEnv('VITE_SUPABASE_ANON_KEY')
  if (!url || !anonKey) return null
  if (!cachedClient) {
    cachedClient = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        detectSessionInUrl: true,
      },
    })
  }
  return cachedClient
}

export async function getSession(): Promise<Session | null> {
  const client = getSupabase()
  if (!client) return null
  const { data, error } = await client.auth.getSession()
  if (error) {
    console.warn('[Explorer] failed to fetch Supabase session', error)
    return null
  }
  return data.session ?? null
}

export async function getAccessToken(): Promise<string | null> {
  const session = await getSession()
  return session?.access_token ?? null
}

export async function getCurrentUserId(): Promise<string | null> {
  const session = await getSession()
  return session?.user?.id ?? null
}

export async function signInWithPassword(email: string, password: string): Promise<void> {
  const client = getSupabase()
  if (!client) throw new Error('Supabase is not configured for this environment.')
  const { error } = await client.auth.signInWithPassword({ email, password })
  if (error) throw error
}

export async function signUpWithPassword(email: string, password: string): Promise<void> {
  const client = getSupabase()
  if (!client) throw new Error('Supabase is not configured for this environment.')
  const emailRedirectTo =
    readEnv('VITE_SUPABASE_EMAIL_REDIRECT_URL') ?? resolveAppRedirectUrl('/auth') ?? undefined
  const { error } = await client.auth.signUp({
    email,
    password,
    options: emailRedirectTo ? { emailRedirectTo } : undefined,
  })
  if (error) throw error
}

export async function sendPasswordResetEmail(email: string): Promise<void> {
  const client = getSupabase()
  if (!client) throw new Error('Supabase is not configured for this environment.')
  const redirectTo =
    readEnv('VITE_SUPABASE_RESET_REDIRECT_URL') ?? resolveAppRedirectUrl('/reset-password') ?? undefined
  const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo })
  if (error) throw error
}

export async function updateCurrentUserPassword(newPassword: string): Promise<void> {
  const client = getSupabase()
  if (!client) throw new Error('Supabase is not configured for this environment.')
  const { error } = await client.auth.updateUser({ password: newPassword })
  if (error) throw error
}

export async function signOut(): Promise<void> {
  const client = getSupabase()
  if (!client) return
  const { error } = await client.auth.signOut()
  if (error) throw error
}

export async function signInAnonymously(): Promise<void> {
  const client = getSupabase()
  if (!client) throw new Error('Supabase is not configured for this environment.')
  const auth = (client as unknown as {
    auth?: { signInAnonymously?: () => Promise<{ error: unknown }> }
  }).auth
  if (!auth || typeof auth.signInAnonymously !== 'function') {
    const error = new Error('Anonymous sign-in is not enabled for this Supabase project.')
    ;(error as Error & { code?: string }).code = 'ANON_UNAVAILABLE'
    throw error
  }
  const { error } = await auth.signInAnonymously()
  if (error) throw error as Error
}

export function isSupabaseConfigured(): boolean {
  if (getInjectedSupabase()) return true
  return Boolean(readEnv('VITE_SUPABASE_URL') && readEnv('VITE_SUPABASE_ANON_KEY'))
}

export function isAnonymousSignInSupported(): boolean {
  const client = getSupabase()
  if (!client) return false
  const auth: unknown = (client as unknown as { auth?: unknown }).auth
  const signInFn = auth && typeof (auth as { signInAnonymously?: unknown }).signInAnonymously === 'function'
  return Boolean(signInFn)
}

export function __resetSupabaseClientForTests(): void {
  cachedClient = null
}

declare global {
  interface Window {
    __supabaseMock?: SupabaseClient
  }

  // eslint-disable-next-line no-var
  var __supabaseMock: SupabaseClient | undefined
}

export {}
