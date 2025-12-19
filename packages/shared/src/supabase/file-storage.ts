import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

export type SupabaseStorageRecord = Record<string, string>

async function readStorage(filePath: string): Promise<SupabaseStorageRecord> {
  try {
    const raw = await fs.readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as SupabaseStorageRecord
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {}
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        ([key, value]) => typeof key === 'string' && typeof value === 'string',
      ),
    )
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

async function writeStorage(filePath: string, data: SupabaseStorageRecord): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

export class SupabaseFileStorage {
  constructor(private readonly filePath: string) {}

  private async load(): Promise<SupabaseStorageRecord> {
    return readStorage(this.filePath)
  }

  private async persist(data: SupabaseStorageRecord): Promise<void> {
    await writeStorage(this.filePath, data)
  }

  async getItem(key: string): Promise<string | null> {
    const store = await this.load()
    return store[key] ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    const store = await this.load()
    store[key] = value
    await this.persist(store)
  }

  async removeItem(key: string): Promise<void> {
    const store = await this.load()
    if (key in store) {
      delete store[key]
      await this.persist(store)
    }
  }

  async clear(): Promise<void> {
    await writeStorage(this.filePath, {})
  }

  get path(): string {
    return resolve(this.filePath)
  }
}

export function createSupabaseFileStorage(filePath: string): SupabaseFileStorage {
  return new SupabaseFileStorage(filePath)
}

export async function clearSupabaseFileStorage(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath)
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return
    }
    throw error
  }
}

export function resolveSupabaseSessionPath(basePath?: string): string {
  const override = process.env.POWERGIT_HOME
  const defaultDir =
    override && override.trim().length > 0 ? resolve(override.trim()) : resolve(homedir(), '.powergit')
  if (!basePath || basePath.trim().length === 0) {
    return resolve(defaultDir, 'supabase-auth.json')
  }
  const normalized = resolve(basePath)
  const targetDir = normalized.endsWith('.json') ? dirname(normalized) : normalized
  return resolve(targetDir, 'supabase-auth.json')
}
