import { Readable } from 'node:stream'
import { ReadableStream as NodeReadableStream } from 'node:stream/web'
import type { RefRow } from './index.js'

export interface PowerSyncRemoteConfig {
  endpoint: string
  token?: string
  getToken?: () => Promise<string | undefined>
  fetchImpl?: typeof fetch
}

export interface ListRefsResult {
  refs: RefRow[]
  head?: { target?: string | null; oid?: string | null }
}

export interface FetchPackParams {
  org: string
  repo: string
  wants: string[]
  haves?: string[]
  shallow?: string[]
  depth?: number
}

export interface FetchPackResult {
  stream: NodeJS.ReadableStream
  size?: number
  keep?: string
}

export interface PushUpdate {
  src: string
  dst: string
  force?: boolean
}

export interface PushPackParams {
  org: string
  repo: string
  updates: PushUpdate[]
  pack: Uint8Array | ArrayBuffer | Buffer | NodeJS.ReadableStream
  dryRun?: boolean
  options?: Record<string, unknown>
}

export interface PushPackResult {
  ok: boolean
  results?: Record<string, { status: 'ok' | 'error'; message?: string }>
  message?: string
}

interface JsonFetchPack {
  pack?: string
  packEncoding?: BufferEncoding
  packUrl?: string
  packHeaders?: Record<string, string>
  keep?: string
}

function toNodeStream(body: ReadableStream | null): NodeJS.ReadableStream {
  if (!body) {
    throw new Error('PowerSyncRemoteClient expected a response body but got null')
  }
  // Node 20 provides Readable.fromWeb to bridge web streams to Node streams
  return Readable.fromWeb(body as NodeReadableStream)
}

export class PowerSyncRemoteClient {
  private readonly baseUrl: string
  private authHeader?: string
  private readonly tokenProvider?: () => Promise<string | undefined>
  private readonly fetchFn: typeof fetch

  constructor(private readonly config: PowerSyncRemoteConfig) {
    this.baseUrl = config.endpoint.replace(/\/$/, '')
    this.authHeader = config.token ? `Bearer ${config.token}` : undefined
    this.tokenProvider = config.getToken
    const impl = config.fetchImpl ?? globalThis.fetch
    if (!impl) throw new Error('PowerSyncRemoteClient requires a fetch implementation (Node 18+ recommended)')
    this.fetchFn = impl.bind(globalThis)
  }

  async listRefs(org: string, repo: string): Promise<ListRefsResult> {
    const res = await this.request(`/orgs/${encodeURIComponent(org)}/repos/${encodeURIComponent(repo)}/refs`)
    if (!res.ok) throw await this.toHttpError('list refs', res)
    const data = await res.json() as { refs?: RefRow[]; head?: { target?: string | null; oid?: string | null } }
    return { refs: data.refs ?? [], head: data.head }
  }

  async fetchPack(params: FetchPackParams): Promise<FetchPackResult> {
    const body = {
      wants: dedupe(params.wants),
      haves: dedupe(params.haves ?? []),
      shallow: dedupe(params.shallow ?? []),
      depth: params.depth,
    }
    const res = await this.request(`/orgs/${encodeURIComponent(params.org)}/repos/${encodeURIComponent(params.repo)}/git/fetch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) throw await this.toHttpError('fetch pack', res)
    const contentType = (res.headers.get('content-type') || '').split(';')[0].trim()
    if (contentType && contentType !== 'application/json') {
      return {
        stream: toNodeStream(res.body),
        size: parseContentLength(res.headers.get('content-length')),
      }
    }

    const json = await res.json() as JsonFetchPack
    if (json.pack && json.pack.length > 0) {
      const encoding = json.packEncoding ?? 'base64'
      const buffer = Buffer.from(json.pack, encoding)
      return { stream: Readable.from(buffer), size: buffer.length, keep: json.keep }
    }
    if (json.packUrl) {
      const packRes = await this.fetchFn(json.packUrl, { headers: this.mergeHeaders(json.packHeaders) })
      if (!packRes.ok) throw new Error(`PowerSyncRemoteClient failed to download pack from ${json.packUrl} (${packRes.status})`)
      return {
        stream: toNodeStream(packRes.body),
        size: parseContentLength(packRes.headers.get('content-length')),
        keep: json.keep,
      }
    }
    throw new Error('PowerSyncRemoteClient received an unexpected fetch response (no pack data)')
  }

  async pushPack(params: PushPackParams): Promise<PushPackResult> {
    const metadata = {
      updates: params.updates,
      dryRun: params.dryRun ?? false,
      options: params.options ?? {},
    }
    const packStream = ensureStream(params.pack)
    const boundary = `powersync-pack-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`
    const formBody = createFormData(boundary, metadata, packStream)
    const res = await this.request(`/orgs/${encodeURIComponent(params.org)}/repos/${encodeURIComponent(params.repo)}/git/push`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: formBody as any,
    })
    if (!res.ok) throw await this.toHttpError('push pack', res)
    const data = await res.json().catch(() => ({})) as PushPackResult | undefined
    const results = data?.results ?? {}
    const ok = data?.ok ?? Object.values(results).every(r => r.status === 'ok')
    return { ok, results, message: data?.message }
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = this.mergeHeaders(init.headers)
    if (!headers.has('authorization')) {
      const token = await this.resolveAuthHeader()
      if (token) headers.set('authorization', token)
    }
    if (!headers.has('accept')) headers.set('accept', 'application/json')
    return this.fetchFn(`${this.baseUrl}${path}`, { ...init, headers })
  }

  private async resolveAuthHeader(): Promise<string | undefined> {
    if (this.authHeader) return this.authHeader
    if (this.tokenProvider) {
      const token = await this.tokenProvider().catch(() => undefined)
      if (token) this.authHeader = `Bearer ${token}`
    }
    return this.authHeader
  }

  private mergeHeaders(input?: HeadersInit): Headers {
    const headers = new Headers(input ?? {})
    return headers
  }

  private async toHttpError(context: string, res: Response): Promise<Error> {
    const text = await res.text().catch(() => '')
    return new Error(`PowerSyncRemoteClient failed to ${context}: ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`)
  }
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list.filter(Boolean)))
}

function ensureStream(input: PushPackParams['pack']): NodeJS.ReadableStream {
  if (isReadableStream(input)) return input
  if (isWebReadableStream(input)) return Readable.fromWeb(input as unknown as NodeReadableStream)
  if (input instanceof ArrayBuffer) return Readable.from(Buffer.from(input))
  if (ArrayBuffer.isView(input)) return Readable.from(Buffer.from(input.buffer, input.byteOffset, input.byteLength))
  if (Buffer.isBuffer(input)) return Readable.from(input)
  return Readable.from(input as any)
}

function createFormData(boundary: string, metadata: unknown, packStream: NodeJS.ReadableStream): NodeJS.ReadableStream {
  const prefix = Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\nContent-Disposition: form-data; name="metadata"\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\nContent-Disposition: form-data; name="pack"; filename="pack.pack"\r\n\r\n`, 'utf8')
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')
  const iterator = async function* () {
    yield prefix
    for await (const piece of packStream as AsyncIterable<any>) {
      if (typeof piece === 'string') {
        yield Buffer.from(piece)
      } else if (Buffer.isBuffer(piece)) {
        yield piece
      } else if (piece instanceof ArrayBuffer) {
        yield Buffer.from(piece)
      } else if (ArrayBuffer.isView(piece)) {
        yield Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength)
      } else {
        throw new Error('Unsupported pack chunk type from PowerSync stream')
      }
    }
    yield suffix
  }
  return Readable.from(iterator())
}

function isReadableStream(value: unknown): value is NodeJS.ReadableStream {
  return typeof value === 'object' && value !== null && typeof (value as NodeJS.ReadableStream).pipe === 'function'
}

function isWebReadableStream(value: unknown): value is ReadableStream {
  return typeof value === 'object' && value !== null && typeof (value as ReadableStream).getReader === 'function'
}
