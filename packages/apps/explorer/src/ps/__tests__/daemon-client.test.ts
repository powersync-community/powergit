import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

const ORIGINAL_FETCH = globalThis.fetch

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  if (ORIGINAL_FETCH) {
    globalThis.fetch = ORIGINAL_FETCH
  } else {
    delete (globalThis as Partial<typeof globalThis>).fetch
  }
})

describe('daemon-client', () => {
  it('returns null when daemon support disabled', async () => {
    vi.unstubAllEnvs()
    vi.doMock('../supabase', () => ({
      getAccessToken: vi.fn().mockResolvedValue('supabase-token'),
    }))
    const mod = await import('../daemon-client')
    expect(mod.isDaemonPreferred()).toBe(false)
    expect(await mod.getDaemonToken()).toBeNull()
    expect(await mod.obtainPowerSyncToken()).toBe('supabase-token')
  })

  it('prefers daemon token when available', async () => {
    vi.stubEnv('VITE_POWERSYNC_USE_DAEMON', 'true')
    vi.stubEnv('VITE_POWERSYNC_DAEMON_URL', 'http://127.0.0.1:9999')

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ready', token: 'daemon-token' }),
    }) as unknown as typeof fetch

    globalThis.fetch = mockFetch

    vi.doMock('../supabase', () => ({
      getAccessToken: vi.fn().mockResolvedValue('supabase-token'),
    }))

    const mod = await import('../daemon-client')
    expect(mod.isDaemonPreferred()).toBe(true)
    await expect(mod.getDaemonToken()).resolves.toBe('daemon-token')
    await expect(mod.obtainPowerSyncToken()).resolves.toBe('daemon-token')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('normalizes nested token payloads from daemon status', async () => {
    vi.stubEnv('VITE_POWERSYNC_USE_DAEMON', 'true')
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'ready', token: { token: 'nested-token', value: 'ignored' }, expiresAt: '2099-01-01T00:00:00Z' }),
    }) as unknown as typeof fetch

    globalThis.fetch = mockFetch

    vi.doMock('../supabase', () => ({ getAccessToken: vi.fn() }))

    const mod = await import('../daemon-client')
    const status = await mod.fetchDaemonAuthStatus()
    expect(status).toEqual({ status: 'ready', token: 'nested-token', expiresAt: '2099-01-01T00:00:00Z', context: null })
    await expect(mod.getDaemonToken()).resolves.toBe('nested-token')
  })

  it('returns null when daemon reports auth_required (no Supabase fallback)', async () => {
    vi.stubEnv('VITE_POWERSYNC_USE_DAEMON', 'true')
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'auth_required' }),
    }) as unknown as typeof fetch
    globalThis.fetch = mockFetch

    const getAccessToken = vi.fn().mockResolvedValue('supabase-token')
    vi.doMock('../supabase', () => ({ getAccessToken }))

    const mod = await import('../daemon-client')
    expect(mod.isDaemonPreferred()).toBe(true)
    await expect(mod.getDaemonToken()).resolves.toBeNull()
    await expect(mod.obtainPowerSyncToken()).resolves.toBeNull()
    expect(getAccessToken).not.toHaveBeenCalled()
  })

  it('notifies daemon on logout when enabled', async () => {
    vi.stubEnv('VITE_POWERSYNC_USE_DAEMON', 'true')
    const mockFetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch
    globalThis.fetch = mockFetch

    vi.doMock('../supabase', () => ({ getAccessToken: vi.fn() }))

    const mod = await import('../daemon-client')
    expect(mod.isDaemonPreferred()).toBe(true)
    await expect(mod.notifyDaemonLogout()).resolves.toBe(true)
    expect(mockFetch).toHaveBeenCalledWith('http://127.0.0.1:5030/auth/logout', expect.objectContaining({ method: 'POST' }))
  })

  it('extracts device challenges from daemon context', async () => {
    vi.stubEnv('VITE_POWERSYNC_USE_DAEMON', 'true')

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        status: 'pending',
        reason: 'complete login',
        context: {
          challengeId: 'abc123',
          verificationUrl: 'http://localhost:5783/auth?device_code=abc123',
        },
      }),
    }) as unknown as typeof fetch

    globalThis.fetch = mockFetch

    vi.doMock('../supabase', () => ({ getAccessToken: vi.fn() }))

    const mod = await import('../daemon-client')
    const status = await mod.fetchDaemonAuthStatus()
    expect(status?.status).toBe('pending')
    expect(mod.extractDeviceChallenge(status)).toEqual({
      challengeId: 'abc123',
      verificationUrl: 'http://localhost:5783/auth?device_code=abc123',
      expiresAt: null,
      mode: null,
    })
  })

  it('completes device login even when daemon mode is disabled', async () => {
    vi.unstubAllEnvs()
    const mockFetch = vi.fn().mockResolvedValue({ ok: true })
    globalThis.fetch = mockFetch as unknown as typeof fetch

    vi.doMock('../supabase', () => ({ getAccessToken: vi.fn() }))

    const mod = await import('../daemon-client')
    const ok = await mod.completeDaemonDeviceLogin({
      challengeId: 'abc123',
      session: {
        access_token: 'access-token',
        refresh_token: 'refresh-token',
      },
    })
    expect(ok).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:5030/auth/device',
      expect.objectContaining({
        method: 'POST',
      }),
    )
    const body = (mockFetch.mock.calls[0]?.[1] as { body?: string } | undefined)?.body ?? ''
    expect(body).toContain('"challengeId":"abc123"')
    expect(body).toContain('"access_token":"access-token"')
    expect(body).toContain('"refresh_token":"refresh-token"')
  })
})
