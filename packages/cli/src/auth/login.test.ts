import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loginWithExplicitToken, loginViaSupabaseFunction, logout } from './login.js'
import { invokeSupabaseEdgeFunction } from '@shared/core'

const tempRoots: string[] = []

vi.mock('@shared/core', () => ({
  invokeSupabaseEdgeFunction: vi.fn(),
}))

const invokeSupabaseEdgeFunctionMock = invokeSupabaseEdgeFunction as unknown as ReturnType<typeof vi.fn>

describe('cli auth login', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function createSessionPath() {
    const dir = await mkdtemp(join(tmpdir(), 'psgit-auth-test-'))
    tempRoots.push(dir)
    return join(dir, 'session.json')
  }

  it('stores manual credentials', async () => {
    const sessionPath = await createSessionPath()
    const fakeToken = [
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9',
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600, iat: Math.floor(Date.now() / 1000) })).toString('base64url'),
      'signature',
    ].join('.')

    const result = await loginWithExplicitToken({
      endpoint: 'https://api.example.dev',
      token: fakeToken,
      sessionPath,
    })

    expect(result.credentials.endpoint).toBe('https://api.example.dev')
    const stored = JSON.parse(await readFile(sessionPath, 'utf8'))
    expect(stored.token).toBe(fakeToken)
    expect(typeof stored.expiresAt).toBe('string')
  })

  it('calls Supabase function and stores credentials', async () => {
    const sessionPath = await createSessionPath()
    const fakeToken = [
      'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9',
      Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 1800 })).toString('base64url'),
      'signature',
    ].join('.')
  invokeSupabaseEdgeFunctionMock.mockResolvedValue({ endpoint: 'https://svc.dev', token: fakeToken })

    const result = await loginViaSupabaseFunction({
      functionsUrl: 'http://localhost:54321/functions/v1',
      serviceRoleKey: 'service-role',
      sessionPath,
    })

  expect(invokeSupabaseEdgeFunctionMock).toHaveBeenCalledWith('powersync-creds', undefined, {
      functionsBaseUrl: 'http://localhost:54321/functions/v1',
      serviceRoleKey: 'service-role',
    })
    expect(result.credentials.endpoint).toBe('https://svc.dev')
    const stored = JSON.parse(await readFile(sessionPath, 'utf8'))
    expect(stored.endpoint).toBe('https://svc.dev')
  })

  it('clears stored session on logout', async () => {
    const sessionPath = await createSessionPath()
    await loginWithExplicitToken({
      endpoint: 'https://api.example.dev',
      token: 'abc.def.ghi',
      sessionPath,
    })

    await logout({ sessionPath })
    await expect(readFile(sessionPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
