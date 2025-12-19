import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { loginWithSupabasePassword, logout } from './login.js'
import { saveStoredCredentials } from './session.js'

const createClientMock = vi.hoisted(() => vi.fn())
const sharedCoreMock = vi.hoisted(() => ({
  createSupabaseFileStorage: vi.fn(() => ({ path: '/tmp/supabase-auth.json' })),
  clearSupabaseFileStorage: vi.fn(),
  resolveSupabaseSessionPath: vi.fn(() => '/tmp/supabase-auth.json'),
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: createClientMock,
}))

vi.mock('@powersync-community/powergit-core', () => sharedCoreMock)

const tempRoots: string[] = []

describe('cli auth login', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    createClientMock.mockReset()
  })

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  async function createSessionPath() {
    const dir = await mkdtemp(join(tmpdir(), 'powergit-auth-test-'))
    tempRoots.push(dir)
    return join(dir, 'session.json')
  }

  it('retrieves credentials via Supabase password login', async () => {
    const sessionPath = await createSessionPath()
    const fakeToken = 'supabase-access-token'
    const session = {
      access_token: fakeToken,
      expires_at: Math.floor(Date.now() / 1000) + 1800,
    }
    const signInWithPassword = vi.fn().mockResolvedValue({ data: { session }, error: null })
    const getSession = vi.fn().mockResolvedValue({ data: { session } })
    createClientMock.mockReturnValue({
      auth: {
        signInWithPassword,
        getSession,
      },
    })

    const result = await loginWithSupabasePassword({
      endpoint: 'https://powersync.dev',
      supabaseUrl: 'https://example.supabase.co',
      supabaseAnonKey: 'anon-key',
      supabaseEmail: 'user@example.com',
      supabasePassword: 'password123',
      sessionPath,
    })

    expect(createClientMock).toHaveBeenCalledWith(
      'https://example.supabase.co',
      'anon-key',
      expect.objectContaining({
        auth: expect.objectContaining({
          persistSession: true,
          autoRefreshToken: true,
        }),
      }),
    )
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: 'user@example.com',
      password: 'password123',
    })
    expect(result.credentials.endpoint).toBe('https://powersync.dev')
    const stored = JSON.parse(await readFile(sessionPath, 'utf8'))
    expect(stored.endpoint).toBe('https://powersync.dev')
  })

  it('clears stored session on logout', async () => {
    const sessionPath = await createSessionPath()
    await saveStoredCredentials(
      {
        endpoint: 'https://api.example.dev',
        token: 'placeholder-token',
      },
      sessionPath,
    )

    await logout({ sessionPath })
    await expect(readFile(sessionPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
