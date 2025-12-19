import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { resolveSupabaseSessionPath as resolveSupabaseSessionPathShared } from '@powersync-community/powergit-core'

export interface StoredCredentials {
  endpoint: string
  token: string
  expiresAt?: string
  obtainedAt?: string
}

function resolvePowergitHome(): string {
  const override = process.env.POWERGIT_HOME
  if (override && override.trim().length > 0) {
    return resolve(override)
  }
  return resolve(homedir(), '.powergit')
}

function getSessionPath(customPath?: string): string {
  if (customPath) return resolve(customPath)
  return resolve(resolvePowergitHome(), 'session.json')
}

async function ensureDirectory(path: string) {
  await fs.mkdir(dirname(path), { recursive: true })
}

export async function loadStoredCredentials(filePath?: string): Promise<StoredCredentials | null> {
  const target = getSessionPath(filePath)
  try {
    const raw = await fs.readFile(target, 'utf8')
    const parsed = JSON.parse(raw) as StoredCredentials
    if (!parsed || typeof parsed.endpoint !== 'string' || typeof parsed.token !== 'string') {
      return null
    }
    return {
      endpoint: parsed.endpoint,
      token: parsed.token,
      expiresAt: parsed.expiresAt,
      obtainedAt: parsed.obtainedAt,
    }
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

export async function saveStoredCredentials(credentials: StoredCredentials, filePath?: string): Promise<void> {
  const target = getSessionPath(filePath)
  await ensureDirectory(target)
  const payload: Record<string, unknown> = {
    endpoint: credentials.endpoint,
    token: credentials.token,
    expiresAt: credentials.expiresAt,
    obtainedAt: credentials.obtainedAt,
  }
  await fs.writeFile(target, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
}

export async function clearStoredCredentials(filePath?: string): Promise<void> {
  const target = getSessionPath(filePath)
  try {
    await fs.unlink(target)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return
    }
    throw error
  }
}

export function resolveSupabaseSessionPath(customPath?: string): string {
  const base = getSessionPath(customPath)
  try {
    if (typeof resolveSupabaseSessionPathShared === 'function') {
      return resolveSupabaseSessionPathShared(base)
    }
  } catch (error) {
    // fall back to local resolution when the shared helper is mocked without the function
    if (process.env.POWERSYNC_DEBUG_SUPABASE === '1') {
      console.warn('[powergit] resolveSupabaseSessionPathShared invocation failed; using local path fallback.', error)
    }
  }
  const normalized = resolve(base)
  if (normalized.endsWith('.json')) {
    return normalized
  }
  return resolve(dirname(normalized), 'supabase-auth.json')
}

export function isCredentialExpired(credentials: StoredCredentials, clock: () => number = () => Date.now()): boolean {
  if (!credentials.expiresAt) return false
  const expiryMs = new Date(credentials.expiresAt).getTime()
  if (Number.isNaN(expiryMs)) return false
  // Refresh one minute before expiry to avoid edge cases during sync
  return expiryMs - clock() <= 60_000
}
