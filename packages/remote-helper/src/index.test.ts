import { describe, expect, it, vi, afterEach } from 'vitest'
import { Buffer } from 'node:buffer'

describe('remote helper Supabase integration', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.unmock('@shared/core')
    process.env = { ...originalEnv }
  })

  it('fetches token via Supabase edge function when configured', async () => {
    const invokeSupabaseEdgeFunction = vi.fn().mockResolvedValue({ token: 'from-supabase' })

    vi.doMock('@shared/core', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@shared/core')>()
      return {
        ...actual,
        invokeSupabaseEdgeFunction,
      }
    })

    process.env.POWERSYNC_SUPABASE_URL = 'https://supabase.local'
    process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY = 'service-key'

    const { __internals } = await import('./index.js')
    const token = await __internals.requestSupabaseToken({ endpoint: 'https://ps.example', org: 'acme', repo: 'infra' })

    expect(token).toBe('from-supabase')
    expect(invokeSupabaseEdgeFunction).toHaveBeenCalledWith(
      'powersync-remote-token',
      { remoteUrl: 'https://ps.example/orgs/acme/repos/infra' },
      { url: 'https://supabase.local', serviceRoleKey: 'service-key' },
    )
  })

  it('parses push directives correctly', async () => {
    const { __internals } = await import('./index.js')
    const parsePush = __internals.parsePush
    expect(parsePush(['push', 'abc', 'def'])).toEqual({ src: 'abc', dst: 'def', force: false })
    expect(parsePush(['push', 'abc:def'])).toEqual({ src: 'abc', dst: 'def', force: false })
    expect(parsePush(['push', '+abc', 'def'])).toEqual({ src: 'abc', dst: 'def', force: true })
    expect(parsePush(['push', 'abc', '+def'])).toEqual({ src: 'abc', dst: 'def', force: true })
    expect(parsePush(['push', '+abc:+def'])).toEqual({ src: 'abc', dst: 'def', force: true })
    expect(parsePush(['push'])).toBeNull()
  })

  it('invokes Supabase push function', async () => {
    const invokeSupabaseEdgeFunction = vi.fn().mockResolvedValue({ ok: true, results: { 'refs/heads/main': { status: 'ok' } } })

    vi.doMock('@shared/core', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@shared/core')>()
      return {
        ...actual,
        invokeSupabaseEdgeFunction,
      }
    })

    process.env.POWERSYNC_SUPABASE_URL = 'http://supabase.local'
    process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY = 'service-role'
    process.env.POWERSYNC_SUPABASE_PUSH_FN = 'powersync-push'

    const { __internals } = await import('./index.js')
    const buffer = Buffer.from('packdata')
    const result = await __internals.uploadPushPack({ org: 'acme', repo: 'infra' }, [{ src: 'abc', dst: 'refs/heads/main' }], buffer)

    expect(result.ok).toBe(true)
    expect(invokeSupabaseEdgeFunction).toHaveBeenCalledWith('powersync-push', {
      org: 'acme',
      repo: 'infra',
      updates: [{ src: 'abc', dst: 'refs/heads/main' }],
      pack: buffer.toString('base64'),
      packEncoding: 'base64',
    }, { url: 'http://supabase.local', serviceRoleKey: 'service-role' })
  })
})
