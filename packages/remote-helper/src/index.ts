
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { parsePowerSyncUrl, invokeSupabaseEdgeFunction as invokeSupabaseEdgeFunctionImport } from '@shared/core'
import { PowerSyncRemoteClient, type FetchPackResult } from '@shared/core/node'

const ZERO_SHA = '0000000000000000000000000000000000000000'

interface FetchRequest { sha: string; name: string }
interface PushRequest { src: string; dst: string; force?: boolean }

interface PushFunctionResult {
  ok?: boolean
  message?: string
  results?: Record<string, { status: 'ok' | 'error'; message?: string }>
}

let parsed: ReturnType<typeof parsePowerSyncUrl> | null = null
let remote: PowerSyncRemoteClient | null = null
let tokenPromise: Promise<string | undefined> | null = null
let fetchBatch: FetchRequest[] = []
let pushBatch: PushRequest[] = []
let cachedSupabaseInvoker: typeof invokeSupabaseEdgeFunctionImport | null = null

function println(s: string = '') { process.stdout.write(s + '\n') }

export async function runHelper() {
  initFromArgs()
  const iterator = process.stdin[Symbol.asyncIterator]()
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  while (true) {
    const { line, done, nextBuffer } = await readNextLine(iterator, buffer)
    buffer = nextBuffer
    if (line === null) break

    const raw = line.replace(/\r$/, '')
    if (raw.length === 0) {
      if (pushBatch.length > 0) {
        await handlePush(pushBatch, buffer, iterator)
        pushBatch = []
        return
      }
      if (fetchBatch.length) await flushFetchBatch()
      continue
    }

    const parts = raw.trim().split(/\s+/)
    const cmd = parts[0]
    detectRemoteReference(parts)

    if (cmd === 'capabilities') {
      println('fetch')
      println('push')
      println('option')
      println('list')
      println('')
      continue
    }

    if (cmd === 'option') {
      println('ok')
      continue
    }

    if (cmd === 'list') {
      await handleList()
      continue
    }

    if (cmd === 'fetch') {
      if (parts.length >= 3) fetchBatch.push({ sha: parts[1], name: parts[2] })
      continue
    }

    if (cmd === 'push') {
      const update = parsePush(parts)
      if (update) pushBatch.push(update)
      continue
    }
  }
  if (fetchBatch.length) await flushFetchBatch()
}

async function handleList() {
  const details = ensureRemote()
  if (!details) {
    println(`${ZERO_SHA} refs/heads/main`)
    println('')
    return
  }
  const client = ensureClient()
  if (!client) {
    println(`${ZERO_SHA} refs/heads/main`)
    println('')
    return
  }
  try {
    const { refs, head } = await client.listRefs(details.org, details.repo)
    if (head?.target) println(`@${head.target} HEAD`)
    for (const ref of refs) {
      const sha = ref.target_sha && ref.target_sha.length === ZERO_SHA.length ? ref.target_sha : ZERO_SHA
      println(`${sha} ${ref.name}`)
    }
    println('')
  } catch (error) {
    console.error(`[powersync] failed to list refs: ${(error as Error).message}`)
    println(`${ZERO_SHA} refs/heads/main`)
    println('')
  }
}

async function flushFetchBatch() {
  const details = ensureRemote()
  fetchBatch = dedupeFetch(fetchBatch)
  if (!details || fetchBatch.length === 0) {
    println('')
    fetchBatch = []
    return
  }
  const client = ensureClient()
  if (!client) {
    println('')
    fetchBatch = []
    return
  }

  try {
    const wants = fetchBatch.map(item => item.sha).filter(Boolean)
    if (wants.length === 0) {
      println('')
      fetchBatch = []
      return
    }
    const pack = await client.fetchPack({ org: details.org, repo: details.repo, wants })
    await writePackToGit(pack)
    println('')
  } catch (error) {
    console.error(`[powersync] fetch failed: ${(error as Error).message}`)
    println('')
  } finally {
    fetchBatch = []
  }
}

async function writePackToGit(result: FetchPackResult) {
  const stream = result.stream
  await new Promise<void>((resolve, reject) => {
    const child = spawn('git', ['index-pack', '--stdin', '--fix-thin'], { stdio: ['pipe', 'inherit', 'inherit'] })
    stream.pipe(child.stdin!)
    child.stdin!.on('error', reject)
    stream.on('error', reject)
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`git index-pack exited with code ${code}`))
    })
  })
}

function dedupeFetch(items: FetchRequest[]): FetchRequest[] {
  const seen = new Set<string>()
  const result: FetchRequest[] = []
  for (const item of items) {
    if (!seen.has(item.sha)) {
      seen.add(item.sha)
      result.push(item)
    }
  }
  return result
}

function ensureClient(): PowerSyncRemoteClient | null {
  if (!parsed) return null
  if (!remote) {
    remote = new PowerSyncRemoteClient({
      endpoint: parsed.endpoint,
      getToken: async () => resolveAuthToken(),
    })
  }
  return remote
}

function ensureRemote(): { org: string; repo: string } | null {
  if (!parsed) return null
  return { org: parsed.org, repo: parsed.repo }
}

function detectRemoteReference(parts: string[]) {
  if (parsed) return
  const candidate = parts.find(part => part?.startsWith?.('powersync::'))
  if (candidate) {
    try { parsed = parsePowerSyncUrl(candidate) } catch (error) {
      console.error(`[powersync] failed to parse remote URL: ${(error as Error).message}`)
    }
  }
}

function initFromArgs() {
  if (parsed) return
  const args = process.argv.slice(2)
  const candidate = args.find(arg => arg?.startsWith?.('powersync::'))
  if (candidate) {
    try { parsed = parsePowerSyncUrl(candidate) } catch {}
  }
}

async function resolveAuthToken(): Promise<string | undefined> {
  const direct = process.env.POWERSYNC_REMOTE_TOKEN || process.env.POWERSYNC_TOKEN || process.env.POWERSYNC_AUTH_TOKEN
  if (direct) return direct
  if (!parsed) return undefined
  if (!tokenPromise) tokenPromise = requestSupabaseToken(parsed)
  return tokenPromise
}

async function requestSupabaseToken(details: { endpoint: string; org: string; repo: string }): Promise<string | undefined> {
  const supabaseUrl = process.env.POWERSYNC_SUPABASE_URL
  const serviceKey = process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return undefined
  const functionName = process.env.POWERSYNC_SUPABASE_REMOTE_FN ?? 'powersync-remote-token'
  try {
    const response = await callSupabaseEdgeFunction<{ token?: string }>(functionName, {
      remoteUrl: `${details.endpoint}/orgs/${details.org}/repos/${details.repo}`,
    }, { url: supabaseUrl, serviceRoleKey: serviceKey })
    return response?.token
  } catch (error) {
    console.error('[powersync] failed to fetch Supabase remote token', error)
    return undefined
  }
}

function parsePush(parts: string[]): PushRequest | null {
  if (parts.length < 2) return null
  let src = ''
  let dst = ''
  let force = false

  if (parts.length >= 3) {
    src = parts[1]
    dst = parts[2]
  } else {
    const payload = parts[1]
    const splitIdx = payload.indexOf(':')
    if (splitIdx === -1) return null
    src = payload.slice(0, splitIdx)
    dst = payload.slice(splitIdx + 1)
  }

  if (src.startsWith('+')) {
    force = true
    src = src.slice(1)
  }
  if (dst.startsWith('+')) {
    force = true
    dst = dst.slice(1)
  }

  return { src, dst, force }
}

async function handlePush(updates: PushRequest[], buffer: Buffer, iterator: AsyncIterator<Buffer>) {
  const details = ensureRemote()
  if (!details) {
    for (const update of updates) println(`error ${update.dst} missing-remote`)
    println('')
    return
  }

  try {
    const packData = await collectPackBuffer(buffer, iterator)
    const result = await uploadPushPack(details, updates, packData)
    const statuses = result.results ?? {}
    for (const update of updates) {
      const entry = statuses[update.dst]
      if ((entry?.status ?? 'ok') === 'ok' && (result.ok ?? true)) {
        println(`ok ${update.dst}`)
      } else {
        const message = entry?.message ?? result.message ?? 'push failed'
        println(`error ${update.dst} ${message}`)
      }
    }
    println('')
  } catch (error) {
    console.error(`[powersync] push failed: ${(error as Error).message}`)
    for (const update of updates) println(`error ${update.dst} ${(error as Error).message}`)
    println('')
  }
}
async function uploadPushPack(details: { org: string; repo: string }, updates: PushRequest[], packBuffer: Buffer): Promise<PushFunctionResult> {
  const supabaseUrl = process.env.POWERSYNC_SUPABASE_URL
  const serviceKey = process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) throw new Error('Supabase push configuration missing')
  const functionName = process.env.POWERSYNC_SUPABASE_PUSH_FN ?? 'powersync-push'

  const payload = {
    org: details.org,
    repo: details.repo,
    updates,
    pack: packBuffer.toString('base64'),
    packEncoding: 'base64' as const,
  }

  return callSupabaseEdgeFunction<PushFunctionResult>(functionName, payload, {
    url: supabaseUrl,
    serviceRoleKey: serviceKey,
  })
}

async function callSupabaseEdgeFunction<T = unknown>(
  functionName: string,
  payload: Record<string, unknown>,
  config: Parameters<typeof invokeSupabaseEdgeFunctionImport>[2],
): Promise<T> {
  const invoker = await ensureSupabaseInvoker()
  return invoker(functionName, payload, config) as Promise<T>
}

async function ensureSupabaseInvoker(): Promise<typeof invokeSupabaseEdgeFunctionImport> {
  if (cachedSupabaseInvoker) return cachedSupabaseInvoker
  if (typeof invokeSupabaseEdgeFunctionImport === 'function') {
    cachedSupabaseInvoker = invokeSupabaseEdgeFunctionImport
    return cachedSupabaseInvoker
  }
  const actual = await import('@shared/core')
  let invoker = actual.invokeSupabaseEdgeFunction
  if (typeof invoker !== 'function') {
  const direct = await import('../../shared/src/supabase')
    invoker = direct.invokeSupabaseEdgeFunction
  }
  if (typeof invoker !== 'function') {
    throw new Error('Supabase function invoker unavailable')
  }
  cachedSupabaseInvoker = invoker
  return cachedSupabaseInvoker
}

async function collectPackBuffer(initial: Buffer, iterator: AsyncIterator<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = []
  if (initial.length > 0) chunks.push(Buffer.from(initial))
  while (true) {
    const { value, done } = await iterator.next()
    if (done) break
    chunks.push(Buffer.from(value as Buffer))
  }
  return Buffer.concat(chunks)
}

async function readNextLine(iterator: AsyncIterator<Buffer>, buffer: Buffer): Promise<{ line: string | null; done: boolean; nextBuffer: Buffer }> {
  let working = buffer
  while (true) {
    const idx = working.indexOf(0x0a)
    if (idx >= 0) {
      const lineBuffer = working.slice(0, idx)
      const remainder = working.slice(idx + 1)
      return { line: lineBuffer.toString('utf8'), done: false, nextBuffer: remainder }
    }
    const { value, done } = await iterator.next()
    if (done) {
      if (working.length === 0) return { line: null, done: true, nextBuffer: Buffer.alloc(0) }
      const line = working.toString('utf8')
      return { line, done: true, nextBuffer: Buffer.alloc(0) }
    }
    working = Buffer.concat([working, value as Buffer])
  }
}

export const __internals = {
  requestSupabaseToken,
  uploadPushPack,
  parsePush,
}
