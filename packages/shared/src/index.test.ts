import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { parsePowerSyncUrl } from './index.js'
import { PowerSyncRemoteClient } from './node.js'

describe('parsePowerSyncUrl', () => {
  it('parses org/repo slugs from a remote URL', () => {
    const parsed = parsePowerSyncUrl('powersync::https://api.example.com/orgs/acme/repos/infra')
    expect(parsed).toEqual({ endpoint: 'https://api.example.com', org: 'acme', repo: 'infra' })
  })

  it('throws on malformed URL', () => {
    expect(() => parsePowerSyncUrl('https://api.example.com/repos-only/foo')).toThrow(/Invalid powersync URL/)
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
      getToken: async () => 'token-from-provider',
      fetchImpl: fetchMock as unknown as typeof fetch,
    })

    await client.listRefs('acme', 'infra')
    expect(fetchMock).toHaveBeenCalled()
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers)
    expect(headers.get('authorization')).toBe('Bearer token-from-provider')
  })
})
