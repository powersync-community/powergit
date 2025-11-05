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
      if (target.endsWith('/auth/status')) {
        return new Response(JSON.stringify({ status: 'ready' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response('not used', { status: 500 })
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const updates = [{ src: 'abc', dst: 'refs/heads/main' }]
    const pack = Buffer.from('pack')
    const summary = {
      head: 'abc',
      refs: [{ name: 'refs/heads/main', target: 'abc' }],
      commits: [],
    }

    const pushPackMock = vi.fn(async () => ({ ok: true, results: { 'refs/heads/main': { status: 'ok' } } }))
    const fakeClient = { pushPack: pushPackMock }

    const result = await __internals.pushViaDaemon(fakeClient as any, { org: 'acme', repo: 'infra' }, updates, pack, {
      summary,
      packOid: '123',
    })

    expect(result.ok).toBe(true)
    expect(pushPackMock).toHaveBeenCalledTimes(1)
    const [[pushArgs]] = pushPackMock.mock.calls as unknown as [
      [
        { org: string; repo: string; updates: unknown[]; pack: unknown; options?: Record<string, unknown> },
      ],
    ]
    expect(pushArgs.org).toBe('acme')
    expect(pushArgs.repo).toBe('infra')
    expect(Array.isArray(pushArgs.updates)).toBe(true)
    expect(Buffer.isBuffer(pushArgs.pack)).toBe(true)
    expect(pushArgs.options).toMatchObject({ packOid: '123', summary })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
