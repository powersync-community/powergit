import { describe, expect, it, vi, beforeEach } from 'vitest'

type DaemonAuthStatus =
  | { status: 'ready'; token: string; expiresAt?: string | null; context?: Record<string, unknown> | null }
  | { status: 'pending'; reason?: string | null; context?: Record<string, unknown> | null }
  | { status: 'auth_required'; reason?: string | null; context?: Record<string, unknown> | null }
  | { status: 'error'; reason?: string | null; context?: Record<string, unknown> | null }

const mocks = vi.hoisted(() => {
  const resolveDaemonBaseUrlMock = vi.fn(async () => 'http://127.0.0.1:5030')
  const postDaemonAuthDeviceMock = vi.fn(async () => ({
    status: 'pending',
    reason: 'Open browser',
    context: { challengeId: 'abc123' },
  }) as DaemonAuthStatus)
  const fetchDaemonAuthStatusMock = vi.fn(async () => ({
    status: 'ready',
    token: 'ready-token',
    expiresAt: null,
    context: null,
  }) as DaemonAuthStatus)
  const postDaemonAuthLogoutMock = vi.fn(async () => ({
    status: 'auth_required',
    reason: 'logged out',
    context: null,
  }) as DaemonAuthStatus)
  const extractDeviceChallengeMock = vi.fn((status: DaemonAuthStatus | null) => {
    if (!status || !status.context) return null
    const context = status.context as Record<string, unknown>
    const challengeId = typeof context.challengeId === 'string' ? context.challengeId : null
    if (!challengeId) return null
    const verificationUrl = typeof context.verificationUrl === 'string' ? context.verificationUrl : undefined
    const expiresAt = typeof context.expiresAt === 'string' ? context.expiresAt : undefined
    const mode = typeof context.mode === 'string' ? context.mode : undefined
    return { challengeId, verificationUrl, expiresAt, mode }
  })

  return {
    resolveDaemonBaseUrlMock,
    postDaemonAuthDeviceMock,
    fetchDaemonAuthStatusMock,
    postDaemonAuthLogoutMock,
    extractDeviceChallengeMock,
  }
})

vi.mock('./daemon-client.js', () => ({
  resolveDaemonBaseUrl: mocks.resolveDaemonBaseUrlMock,
  postDaemonAuthDevice: mocks.postDaemonAuthDeviceMock,
  fetchDaemonAuthStatus: mocks.fetchDaemonAuthStatusMock,
  postDaemonAuthLogout: mocks.postDaemonAuthLogoutMock,
  extractDeviceChallenge: mocks.extractDeviceChallengeMock,
}))

import { loginWithDaemonDevice, logout } from './login.js'

describe('daemon auth helpers', () => {
  beforeEach(() => {
    mocks.resolveDaemonBaseUrlMock.mockClear()
    mocks.postDaemonAuthDeviceMock.mockClear()
    mocks.fetchDaemonAuthStatusMock.mockClear()
    mocks.postDaemonAuthLogoutMock.mockClear()
    mocks.extractDeviceChallengeMock.mockClear()
  })

  it('polls daemon device flow until ready', async () => {
    mocks.fetchDaemonAuthStatusMock.mockResolvedValueOnce({ status: 'pending', reason: 'waiting', context: null })
    mocks.fetchDaemonAuthStatusMock.mockResolvedValueOnce({
      status: 'ready',
      token: 'final-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      context: null,
    })

    const result = await loginWithDaemonDevice({
      pollIntervalMs: 1,
      timeoutMs: 50,
    })

    expect(mocks.resolveDaemonBaseUrlMock).toHaveBeenCalledTimes(1)
    expect(mocks.postDaemonAuthDeviceMock).toHaveBeenCalledWith('http://127.0.0.1:5030', {
      mode: 'device-code',
      endpoint: undefined,
      metadata: null,
    })
    expect(mocks.fetchDaemonAuthStatusMock).toHaveBeenCalled()
    expect(result.finalStatus).toEqual({
      status: 'ready',
      token: 'final-token',
      expiresAt: '2099-01-01T00:00:00.000Z',
      context: null,
    })
    expect(result.challenge).toEqual({
      challengeId: 'abc123',
      verificationUrl: undefined,
      expiresAt: undefined,
      mode: undefined,
    })
  })

  it('invokes daemon logout hook', async () => {
    await logout()
    expect(mocks.postDaemonAuthLogoutMock).toHaveBeenCalledWith('http://127.0.0.1:5030')
  })
})
