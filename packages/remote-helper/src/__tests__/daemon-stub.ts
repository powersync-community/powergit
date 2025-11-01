import http from 'node:http'
import type { AddressInfo } from 'node:net'

interface StreamTarget {
  id: string
  parameters?: Record<string, unknown> | null
}

interface ListRefsPayload {
  refs: unknown[]
  head?: Record<string, unknown> | null
}

interface FetchPackPayload {
  status?: number
  body?: Record<string, unknown>
  headers?: Record<string, string>
}

interface PushResponsePayload {
  status?: number
  body?: Record<string, unknown>
}

const DEFAULT_HEADERS = {
  'content-type': 'application/json',
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown, headers?: Record<string, string>) {
  const body = JSON.stringify(payload ?? {})
  res.writeHead(status, headers ?? DEFAULT_HEADERS)
  res.end(body)
}

function keyFor(orgId: string, repoId: string): string {
  return `${orgId}::${repoId}`
}

function normalizeStreamTargets(raw: unknown): StreamTarget[] {
  if (!Array.isArray(raw)) return []
  const targets: StreamTarget[] = []
  for (const entry of raw) {
    if (typeof entry === 'string') {
      const id = entry.trim()
      if (id) targets.push({ id })
      continue
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, unknown>
      const idCandidate =
        typeof record.id === 'string'
          ? record.id
          : typeof record.stream === 'string'
            ? record.stream
            : ''
      const id = idCandidate.trim()
      if (!id) continue
      const paramsRaw = record.parameters ?? record.params ?? null
      let parameters: Record<string, unknown> | null = null
      if (paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw)) {
        parameters = Object.fromEntries(
          Object.entries(paramsRaw as Record<string, unknown>).map(([key, value]) => [key.trim(), value]),
        )
      }
      targets.push({ id, parameters })
    }
  }
  return targets
}

export interface DaemonStub {
  baseUrl: string
  close(): Promise<void>
  setListRefs(orgId: string, repoId: string, payload: ListRefsPayload): void
  setFetchPack(orgId: string, repoId: string, payload: FetchPackPayload): void
  setPushResponse(orgId: string, repoId: string, payload: PushResponsePayload): void
  recordStreamSubscriptions(): StreamTarget[][]
  recordedFetchRequests(): Array<{ orgId: string; repoId: string; body: Record<string, unknown> | null }>
  recordedPushRequests(): Array<{ orgId: string; repoId: string; metadata: Record<string, unknown>; bodySize: number }>
}

export async function createDaemonStub(): Promise<DaemonStub> {
  const refs = new Map<string, ListRefsPayload>()
  const fetchPacks = new Map<string, FetchPackPayload>()
  const pushResponses = new Map<string, PushResponsePayload>()
  const streamRequests: StreamTarget[][] = []
  const fetchRequests: Array<{ orgId: string; repoId: string; body: Record<string, unknown> | null }> = []
  const pushRequests: Array<{ orgId: string; repoId: string; metadata: Record<string, unknown>; bodySize: number }> = []

  const server = http.createServer(async (req, res) => {
    if (!req.url) {
      res.statusCode = 404
      res.end()
      return
    }

    const url = new URL(req.url, 'http://127.0.0.1')
    const { pathname } = url

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' && pathname === '/auth/status') {
      sendJson(res, 200, { status: 'ready' })
      return
    }

    if (pathname === '/streams') {
      if (req.method === 'POST') {
        const body = await readBody(req).catch(() => Buffer.alloc(0))
        let payload: { streams?: unknown } = {}
        if (body.length > 0) {
          try {
            payload = JSON.parse(body.toString('utf8')) as { streams?: unknown }
          } catch {
            payload = {}
          }
        }
        const targets = normalizeStreamTargets(payload.streams ?? [])
        if (targets.length > 0) {
          streamRequests.push(targets)
        }
        sendJson(res, 200, { added: targets.map((target) => target.id), alreadyActive: [], queued: [] })
        return
      }
      if (req.method === 'DELETE') {
        sendJson(res, 200, { removed: [], notFound: [] })
        return
      }
    }

    const repoMatch =
      /^\/orgs\/([^/]+)\/repos\/([^/]+)(?:\/(refs|git\/fetch|git\/push|summary))?$/.exec(pathname)

    if (!repoMatch) {
      res.statusCode = 404
      res.end()
      return
    }

    const [, rawOrg, rawRepo, action] = repoMatch
    const orgId = decodeURIComponent(rawOrg)
    const repoId = decodeURIComponent(rawRepo)
    const key = keyFor(orgId, repoId)

    if (!action || action === 'refs') {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.end()
        return
      }
      const payload = refs.get(key) ?? { refs: [], head: null }
      sendJson(res, 200, payload)
      return
    }

    if (action === 'summary') {
      if (req.method !== 'GET') {
        res.statusCode = 405
        res.end()
        return
      }
      sendJson(res, 200, { orgId, repoId, counts: {} })
      return
    }

    if (action === 'git/fetch') {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end()
        return
      }
      const body = await readBody(req).catch(() => Buffer.alloc(0))
      let payload: Record<string, unknown> | null = null
      try {
        payload = body.length > 0 ? (JSON.parse(body.toString('utf8')) as Record<string, unknown>) : null
      } catch {
        payload = null
      }
      fetchRequests.push({ orgId, repoId, body: payload })
      const response = fetchPacks.get(key) ?? {}
      const status = response.status ?? 200
      sendJson(res, status, response.body ?? { pack: null })
      return
    }

    if (action === 'git/push') {
      if (req.method !== 'POST') {
        res.statusCode = 405
        res.end()
        return
      }
      const body = await readBody(req).catch(() => Buffer.alloc(0))
      pushRequests.push({
        orgId,
        repoId,
        metadata: { boundary: req.headers['content-type'] ?? '' },
        bodySize: body.length,
      })
      const response = pushResponses.get(key) ?? {}
      const status = response.status ?? 200
      sendJson(res, status, response.body ?? { ok: true })
      return
    }

    res.statusCode = 404
    res.end()
  })

  await new Promise<void>((resolve, reject) => {
    server.listen({ host: '127.0.0.1', port: 0 }, () => resolve())
    server.once('error', reject)
  })

  const address = server.address() as AddressInfo
  const baseUrl = `http://${address.address}:${address.port}`

  return {
    baseUrl,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    },
    setListRefs(orgId, repoId, payload) {
      refs.set(keyFor(orgId, repoId), payload)
    },
    setFetchPack(orgId, repoId, payload) {
      fetchPacks.set(keyFor(orgId, repoId), payload)
    },
    setPushResponse(orgId, repoId, payload) {
      pushResponses.set(keyFor(orgId, repoId), payload)
    },
    recordStreamSubscriptions() {
      return streamRequests.slice()
    },
    recordedFetchRequests() {
      return fetchRequests.slice()
    },
    recordedPushRequests() {
      return pushRequests.slice()
    },
  }
}
