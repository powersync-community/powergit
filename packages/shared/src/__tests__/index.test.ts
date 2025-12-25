import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { parsePowerSyncUrl } from '../index.js'
import { PowerSyncRemoteClient } from '../node.js'

describe('parsePowerSyncUrl', () => {
  it('parses org/repo slugs from a remote URL', () => {
    const parsed = parsePowerSyncUrl('powergit::https://api.example.com/orgs/acme/repos/infra')
    expect(parsed).toEqual({ endpoint: 'https://api.example.com', basePath: '', org: 'acme', repo: 'infra' })
  })

  it('captures path prefix before org/repo', () => {
    const parsed = parsePowerSyncUrl('powergit::https://api.example.com/functions/v1/powersync-remote/orgs/acme/repos/infra')
    expect(parsed).toEqual({ endpoint: 'https://api.example.com', basePath: '/functions/v1/powersync-remote', org: 'acme', repo: 'infra' })
  })

  it('throws on malformed URL', () => {
    expect(() => parsePowerSyncUrl('https://api.example.com/repos-only/foo')).toThrow(/Invalid powergit URL/)
  })
})

describe('PowerSyncRemoteClient', () => {
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    vi.resetAllMocks()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('uses async token provider on demand', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ refs: [] }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new PowerSyncRemoteClient({
      endpoint: 'https://api.example.com',
      basePath: '/custom/base',
      getToken: async () => 'token-from-provider',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await client.listRefs('acme', 'infra')
    expect(fetchMock).toHaveBeenCalled()
    const call = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined] | undefined
    expect(call?.[0]).toBe('https://api.example.com/custom/base/orgs/acme/repos/infra/refs')
    const requestInit = (call?.[1] ?? {}) as RequestInit
    const headers = new Headers(requestInit.headers ?? {})
    expect(headers.get('authorization')).toBe('Bearer token-from-provider')
  })

  it('routes via query parameter for Supabase function base paths', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ refs: [] }), { status: 200 }))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const client = new PowerSyncRemoteClient({
      endpoint: 'http://127.0.0.1:55431',
      basePath: '/functions/v1/powersync-remote',
      token: 'supabase-token',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await client.listRefs('demo', 'infra')
    expect(fetchMock).toHaveBeenCalled()
    const [url] = fetchMock.mock.calls[0] as unknown as [RequestInfo | URL, RequestInit | undefined]
    const parsedUrl = new URL(String(url))
    expect(parsedUrl.origin + parsedUrl.pathname).toBe('http://127.0.0.1:55431/functions/v1/powersync-remote')
    expect(parsedUrl.searchParams.get('path')).toBe('/orgs/demo/repos/infra/refs')
  })
})
