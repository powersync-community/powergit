import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  SupabaseFileStorage,
  createSupabaseFileStorage,
  clearSupabaseFileStorage,
} from '../file-storage.js'

async function createTempFilePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'supabase-storage-test-'))
  return join(dir, 'supabase-auth.json')
}

describe('SupabaseFileStorage', () => {
  const tempDirs: string[] = []

  beforeEach(() => {
    tempDirs.splice(0)
  })

  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        rm(dir, { recursive: true, force: true }),
      ),
    )
  })

  it('reads and writes values via setItem/getItem', async () => {
    const filePath = await createTempFilePath()
    tempDirs.push(resolve(filePath, '..'))
    const storage = new SupabaseFileStorage(filePath)

    expect(await storage.getItem('access_token')).toBeNull()
    await storage.setItem('access_token', 'abc123')
    expect(await storage.getItem('access_token')).toBe('abc123')

    const contents = JSON.parse(await readFile(filePath, 'utf8'))
    expect(contents).toEqual({ access_token: 'abc123' })
  })

  it('removes values and clears the underlying file', async () => {
    const filePath = await createTempFilePath()
    tempDirs.push(resolve(filePath, '..'))
    const storage = createSupabaseFileStorage(filePath)

    await storage.setItem('refresh_token', 'refresh-xyz')
    await storage.setItem('access_token', 'access-xyz')
    await storage.removeItem('refresh_token')

    expect(await storage.getItem('refresh_token')).toBeNull()
    expect(await storage.getItem('access_token')).toBe('access-xyz')

    await storage.clear()
    expect(await storage.getItem('access_token')).toBeNull()
    const contents = JSON.parse(await readFile(filePath, 'utf8'))
    expect(contents).toEqual({})
  })

  it('exposes absolute path and supports explicit clear helper', async () => {
    const filePath = await createTempFilePath()
    tempDirs.push(resolve(filePath, '..'))
    const storage = createSupabaseFileStorage(filePath)
    await storage.setItem('value', '1')
    expect(storage.path).toBe(resolve(filePath))

    await clearSupabaseFileStorage(filePath)
    await expect(readFile(filePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
