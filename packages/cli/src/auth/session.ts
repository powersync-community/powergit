import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

const SESSION_RELATIVE_PATH = '.psgit/session.json'

export interface StoredCredentials {
  endpoint: string
  token: string
  expiresAt?: string
  obtainedAt?: string
}

function getSessionPath(customPath?: string): string {
  if (customPath) return resolve(customPath)
  return resolve(homedir(), SESSION_RELATIVE_PATH)
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
    return parsed
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
  await fs.writeFile(target, `${JSON.stringify(credentials, null, 2)}\n`, 'utf8')
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

export function isCredentialExpired(credentials: StoredCredentials, clock: () => number = () => Date.now()): boolean {
  if (!credentials.expiresAt) return false
  const expiryMs = new Date(credentials.expiresAt).getTime()
  if (Number.isNaN(expiryMs)) return false
  // Refresh one minute before expiry to avoid edge cases during sync
  return expiryMs - clock() <= 60_000
}
