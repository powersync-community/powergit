import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { Buffer } from 'node:buffer'

import { __internals } from './index.js'

const originalFetch = globalThis.fetch

describe('remote helper internals', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = originalFetch
  })

  it('parses push directives', () => {
    const { parsePush } = __internals
    expect(parsePush(['push', 'abc', 'refs/heads/main'])).toEqual({ src: 'abc', dst: 'refs/heads/main', force: false })
    expect(parsePush(['push', 'abc:refs/heads/main'])).toEqual({ src: 'abc', dst: 'refs/heads/main', force: false })
    expect(parsePush(['push', '+abc', 'refs/heads/main'])).toEqual({ src: 'abc', dst: 'refs/heads/main', force: true })
    expect(parsePush(['push', '+abc:+refs/heads/main'])).toEqual({ src: 'abc', dst: 'refs/heads/main', force: true })
    expect(parsePush(['push'])).toBeNull()
  })

  it('pushViaDaemon forwards payload to PowerSync client', async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url)
      if (target.endsWith('/health')) {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(
        JSON.stringify({ ok: true, results: { 'refs/heads/main': { status: 'ok' } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const updates = [{ src: 'abc', dst: 'refs/heads/main' }]
    const pack = Buffer.from('pack')
    const summary = {
      head: 'abc',
      refs: [{ name: 'refs/heads/main', target: 'abc' }],
      commits: [],
    }

    const result = await __internals.pushViaDaemon(null, { org: 'acme', repo: 'infra' }, updates, pack, {
      summary,
      packOid: '123',
    })

    expect(result.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const pushCall = fetchMock.mock.calls[1] as unknown[] | undefined
    expect(pushCall).toBeDefined()
    const url = String(pushCall?.[0])
    const init = pushCall?.[1] as RequestInit | undefined
    expect(url).toMatch(/\/orgs\/acme\/repos\/infra\/git\/push$/)
    expect(init?.method).toBe('POST')
  })
})
