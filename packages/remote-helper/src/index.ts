
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import {
  parsePowerSyncUrl,
  invokeSupabaseEdgeFunction as invokeSupabaseEdgeFunctionImport,
  type GitPushSummary,
} from '@shared/core'
import { PowerSyncRemoteClient, type FetchPackResult } from '@shared/core/node'

const ZERO_SHA = '0000000000000000000000000000000000000000'
const MAX_COMMITS_PER_UPDATE = Number.parseInt(process.env.POWERSYNC_MAX_PUSH_COMMITS ?? '256', 10)

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

const debugLogFile = process.env.POWERSYNC_HELPER_DEBUG_LOG

function debugLog(message: string) {
  if (!debugLogFile) return
  try {
    appendFileSync(debugLogFile, message + '\n')
  } catch (error) {
    console.error('[debugLogError]', (error as Error).message)
  }
}

function println(s: string = '') { process.stdout.write(s + '\n') }

export async function runHelper() {
  initFromArgs()
  const iterator = process.stdin[Symbol.asyncIterator]()
  let buffer: Buffer = Buffer.alloc(0)

  while (true) {
  const { line, done, nextBuffer } = await readNextLine(iterator, buffer)
  buffer = nextBuffer as Buffer
    if (line === null) break

    const raw = line.replace(/\r$/, '')
    debugLog(`raw:${raw}`)
    if (raw.length === 0) {
      if (pushBatch.length > 0) {
        await handlePush(pushBatch)
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
      debugLog(`parsePush parts:${JSON.stringify(parts)} update:${JSON.stringify(update)}`)
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
      basePath: parsed.basePath,
      pathRouting: inferPathRouting(parsed.basePath),
      getToken: async () => resolveAuthToken(),
    })
  }
  return remote
}

function ensureRemote(): { org: string; repo: string; endpoint: string; basePath?: string } | null {
  if (!parsed) return null
  return { org: parsed.org, repo: parsed.repo, endpoint: parsed.endpoint, basePath: parsed.basePath }
}

function inferPathRouting(basePath?: string): 'segments' | 'query' {
  return basePath && basePath.includes('/functions/') ? 'query' : 'segments'
}

function buildRemoteHttpUrl(details: { endpoint: string; basePath?: string; org: string; repo: string }): string {
  const encodedOrg = encodeURIComponent(details.org)
  const encodedRepo = encodeURIComponent(details.repo)
  const path = `/orgs/${encodedOrg}/repos/${encodedRepo}`
  if (inferPathRouting(details.basePath) === 'query') {
    const baseUrl = new URL(details.basePath ? `${details.endpoint}${details.basePath}` : details.endpoint)
    baseUrl.searchParams.set('path', path)
    return baseUrl.toString()
  }
  const base = details.basePath ? `${details.endpoint}${details.basePath}` : details.endpoint
  return `${base}${path}`
}

function detectRemoteReference(parts: string[]) {
  if (parsed) return
  for (const part of parts) {
    if (tryParseRemote(part)) return
  }
}

function initFromArgs() {
  if (parsed) return
  const args = process.argv.slice(2)
  for (const arg of args) {
    if (tryParseRemote(arg)) return
  }
}

function tryParseRemote(candidate?: string): boolean {
  if (!candidate) return false
  try {
    parsed = parsePowerSyncUrl(candidate)
    return true
  } catch (error) {
    if (candidate.includes('://')) {
      console.error(`[powersync] failed to parse remote URL: ${(error as Error).message}`)
    }
    return false
  }
}

async function resolveAuthToken(): Promise<string | undefined> {
  const direct = process.env.POWERSYNC_REMOTE_TOKEN || process.env.POWERSYNC_TOKEN || process.env.POWERSYNC_AUTH_TOKEN
  if (direct) return direct
  if (!parsed) return undefined
  if (!tokenPromise) tokenPromise = requestSupabaseToken(parsed)
  return tokenPromise
}

async function requestSupabaseToken(details: { endpoint: string; basePath?: string; org: string; repo: string }): Promise<string | undefined> {
  const supabaseUrl = process.env.POWERSYNC_SUPABASE_URL
  const serviceKey = process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceKey) return undefined
  const functionName = process.env.POWERSYNC_SUPABASE_REMOTE_FN ?? 'powersync-remote-token'
  const remoteHttpUrl = buildRemoteHttpUrl(details)
  try {
    const response = await callSupabaseEdgeFunction<{ token?: string }>(functionName, {
      remoteUrl: remoteHttpUrl,
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

async function handlePush(updates: PushRequest[]) {
  const details = ensureRemote()
  if (!details) {
    for (const update of updates) println(`error ${update.dst} missing-remote`)
    println('')
    return
  }

  try {
    debugLog(`handlePush updates:${updates.length}`)
    const resolvedUpdates = await resolvePushUpdates(updates)
    let summary: GitPushSummary | undefined
    try {
      summary = await collectPushSummary(resolvedUpdates)
    } catch (error) {
      console.warn('[powersync] failed to collect push summary', error)
      summary = undefined
    }
    const packData = await generatePackForPush(resolvedUpdates)
    const nonDeleteUpdates = resolvedUpdates.filter(update => update.src && update.src !== ZERO_SHA)
    if (packData.length === 0 && nonDeleteUpdates.length > 0) {
      throw new Error('git pack-objects produced empty pack')
    }
    debugLog(`packSize:${packData.length}`)
    const packOid = packData.length > 0 ? createHash('sha1').update(packData).digest('hex') : undefined
    const result = await uploadPushPack(details, resolvedUpdates, packData, { summary, packOid })
    const statuses = result.results ?? {}
    for (const update of resolvedUpdates) {
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
async function uploadPushPack(
  details: { org: string; repo: string },
  updates: PushRequest[],
  packBuffer: Buffer,
  extras: { summary?: GitPushSummary; packOid?: string } = {},
): Promise<PushFunctionResult> {
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

  if (extras.packOid) {
    Object.assign(payload, { packOid: extras.packOid })
  }
  if (extras.summary && (extras.summary.commits.length > 0 || extras.summary.refs.length > 0 || extras.summary.head)) {
    Object.assign(payload, { summary: extras.summary })
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

async function resolvePushUpdates(updates: PushRequest[]): Promise<PushRequest[]> {
  const resolved: PushRequest[] = []
  for (const update of updates) {
    let src = update.src
    if (!src || src === ZERO_SHA || src === '0') {
      resolved.push({ ...update, src: ZERO_SHA })
      continue
    }
    const sha = await resolveGitRef(src)
    resolved.push({ ...update, src: sha })
  }
  return resolved
}

async function resolveGitRef(ref: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', ['rev-parse', ref], { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString('utf8') })
    child.stdout.on('error', reject)
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(output.trim())
      } else {
        reject(new Error(`git rev-parse failed for ${ref} (exit code ${code})`))
      }
    })
  })
}

async function generatePackForPush(updates: PushRequest[]): Promise<Buffer> {
  const sources = Array.from(new Set(updates
    .map(update => update.src)
    .filter((src): src is string => Boolean(src && src !== ZERO_SHA))))
  if (sources.length === 0) return Buffer.alloc(0)

  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('git', ['pack-objects', '--stdout', '--thin', '--delta-base-offset', '--revs', '--quiet'], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    })
    child.stdout.on('error', reject)
    child.stdin.on('error', reject)
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(Buffer.concat(chunks))
      } else {
        reject(new Error(`git pack-objects exited with code ${code}`))
      }
    })
    for (const src of sources) {
      child.stdin.write(`${src}\n`)
    }
    child.stdin.end()
  })
}

async function collectPushSummary(updates: PushRequest[]): Promise<GitPushSummary> {
  const refs = updates.map((update) => ({ name: update.dst, target: update.src }))
  const seen = new Set<string>()
  const orderedCommits: string[] = []

  for (const update of updates) {
    if (!update.src || update.src === ZERO_SHA) {
      continue
    }
    const commits = await listCommitsForRef(update.src)
    for (const sha of commits) {
      if (sha && !seen.has(sha)) {
        seen.add(sha)
        orderedCommits.push(sha)
      }
    }
  }

  const commitSummaries = [] as GitPushSummary['commits']
  for (const sha of orderedCommits) {
    try {
      commitSummaries.push(await readCommitSummary(sha))
    } catch (error) {
      console.warn('[powersync] failed to read commit summary', sha, error)
    }
  }

  let headTarget = refs.find((ref) => ref.name === 'HEAD')?.target
  if (!headTarget) {
    headTarget = refs.find((ref) => ref.name.startsWith('refs/heads/'))?.target
  }

  const normalizedRefs = [...refs]
  if (headTarget && !refs.some((ref) => ref.name === 'HEAD')) {
    normalizedRefs.push({ name: 'HEAD', target: headTarget })
  }

  return {
    head: headTarget && headTarget !== ZERO_SHA ? headTarget : undefined,
    refs: normalizedRefs,
    commits: commitSummaries,
  }
}

async function listCommitsForRef(ref: string): Promise<string[]> {
  const args = ['rev-list', '--max-count', String(MAX_COMMITS_PER_UPDATE), ref]
  const output = await execGit(args).catch((error) => {
    console.warn('[powersync] failed to list commits for ref', ref, error)
    return ''
  })
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
}

async function readCommitSummary(sha: string): Promise<GitPushSummary['commits'][number]> {
  const headerRaw = await execGit(['show', '--no-patch', '--format=%H\x00%T\x00%an\x00%ae\x00%aI\x00%P\x00%B\x00', sha])
  const headerParts = headerRaw.split('\x00')
  if (headerParts.length && headerParts[headerParts.length - 1] === '') {
    headerParts.pop()
  }
  const [commitSha, treeSha, authorName, authorEmail, authoredAt, parentsRaw = '', messageRaw = ''] = headerParts
  const parents = parentsRaw.trim().length > 0 ? parentsRaw.trim().split(/\s+/) : []
  const files = await readCommitFileChanges(sha)
  return {
    sha: commitSha,
    tree: treeSha,
    author_name: authorName,
    author_email: authorEmail,
    authored_at: authoredAt,
    message: messageRaw.trimEnd(),
    parents,
    files,
  }
}

async function readCommitFileChanges(sha: string): Promise<GitPushSummary['commits'][number]['files']> {
  const output = await execGit(['diff-tree', '--no-commit-id', '--numstat', '-r', sha]).catch((error) => {
    console.warn('[powersync] failed to read commit file changes', sha, error)
    return ''
  })

  if (!output) return []
  const lines = output.split(/\r?\n/)
  const entries = [] as GitPushSummary['commits'][number]['files']
  for (const line of lines) {
    if (!line || !line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [addRaw, delRaw, ...pathParts] = parts
    const path = pathParts.join('\t')
    entries.push({
      path,
      additions: parseGitStat(addRaw),
      deletions: parseGitStat(delRaw),
    })
  }
  return entries
}

function parseGitStat(value: string): number {
  if (!value || value === '-' || value === 'binary') return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

async function execGit(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk.toString('utf8')
    })
    child.stdout.on('error', reject)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(output)
      } else {
        reject(new Error(`git ${args.join(' ')} exited with code ${code}`))
      }
    })
  })
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

