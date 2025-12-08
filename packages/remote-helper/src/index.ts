
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parsePowerSyncUrl, type GitPushSummary, buildRepoStreamTargets } from '@shared/core'
import { PowerSyncRemoteClient, type FetchPackResult, type PushPackResult } from '@shared/core/node'

const ZERO_SHA = '0000000000000000000000000000000000000000'
const MAX_COMMITS_PER_UPDATE = Number.parseInt(process.env.POWERSYNC_MAX_PUSH_COMMITS ?? '256', 10)
const DEFAULT_DAEMON_URL = process.env.POWERSYNC_DAEMON_URL ?? process.env.POWERSYNC_DAEMON_ENDPOINT ?? 'http://127.0.0.1:5030'
const DAEMON_START_COMMAND = process.env.POWERSYNC_DAEMON_START_COMMAND ?? 'pnpm --filter @svc/daemon start'
const DAEMON_AUTOSTART_DISABLED = (process.env.POWERSYNC_DAEMON_AUTOSTART ?? 'true').toLowerCase() === 'false'
const DAEMON_START_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_START_TIMEOUT_MS ?? '7000', 10)
const DAEMON_CHECK_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_CHECK_TIMEOUT_MS ?? '2000', 10)
const DAEMON_AUTH_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_AUTH_TIMEOUT_MS ?? '15000', 10)
const CLI_LOGIN_HINT = process.env.POWERSYNC_LOGIN_COMMAND ?? 'pnpm --filter @pkg/cli cli login'
const AUTH_STATUS_POLL_INTERVAL_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_AUTH_POLL_MS ?? '500', 10)
const DAEMON_START_HINT =
  'PowerSync daemon unreachable — start it with "pnpm --filter @svc/daemon start" or point POWERSYNC_DAEMON_URL at a running instance.'


interface FetchRequest { sha: string; name: string }
interface PushRequest { src: string; dst: string; force?: boolean }

let parsed: ReturnType<typeof parsePowerSyncUrl> | null = null
let daemonClient: PowerSyncRemoteClient | null = null
let daemonBaseUrl = normalizeBaseUrl(DEFAULT_DAEMON_URL)
let fetchBatch: FetchRequest[] = []
let pushBatch: PushRequest[] = []

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
  const client = await ensureClient()
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
    const friendly = formatDaemonError('list refs', error)
    if (friendly) console.error(`[powersync] ${friendly}`)
    else console.error(`[powersync] failed to list refs: ${(error as Error).message}`)
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
  const client = await ensureClient()
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
    const friendly = formatDaemonError('fetch packs', error)
    if (friendly) console.error(`[powersync] ${friendly}`)
    else console.error(`[powersync] fetch failed: ${(error as Error).message}`)
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

async function ensureClient(): Promise<PowerSyncRemoteClient | null> {
  if (!parsed) return null
  try {
    await ensureDaemonReady()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[powersync] ${message}`)
    return null
  }
  if (!daemonClient) {
    if (typeof globalThis.fetch !== 'function') {
      console.error('[powersync] fetch API unavailable; requires Node 18+')
      return null
    }
    daemonBaseUrl = normalizeBaseUrl(DEFAULT_DAEMON_URL)
    daemonClient = new PowerSyncRemoteClient({
      endpoint: daemonBaseUrl,
      pathRouting: 'segments',
      fetchImpl: globalThis.fetch as typeof fetch,
    })
  }
  await ensureDaemonSubscribed()
  return daemonClient
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, '')
}

function ensureRemote(): { org: string; repo: string; endpoint: string; basePath?: string } | null {
  if (!parsed) return null
  return { org: parsed.org, repo: parsed.repo, endpoint: parsed.endpoint, basePath: parsed.basePath }
}

async function ensureDaemonSubscribed(): Promise<void> {
  if (!parsed || typeof globalThis.fetch !== 'function') return
  const { org, repo } = parsed
  const streams = buildRepoStreamTargets(org, repo)
  try {
    const res = await fetch(`${daemonBaseUrl}/streams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streams }),
    })
    if (res.ok) {
      const payload = (await res.json().catch(() => null)) as
        | { added?: unknown; queued?: unknown }
        | null
        | undefined
      if (payload && Array.isArray(payload.queued) && payload.queued.length > 0) {
        console.warn(
          `[powersync] daemon deferred stream subscriptions for ${payload.queued.length} target(s); retrying later may be necessary.`,
        )
      }
    } else if (res.status !== 503) {
      console.warn(`[powersync] daemon stream subscription returned ${res.status} ${res.statusText}`)
    }
  } catch (error) {
    console.warn('[powersync] failed to subscribe daemon streams', error instanceof Error ? error.message : error)
  }
}

let daemonStartInFlight = false

async function ensureDaemonReady(): Promise<void> {
  if (typeof globalThis.fetch !== 'function') return
  let responsive = await isDaemonResponsive()
  if (!responsive) {
    if (DAEMON_AUTOSTART_DISABLED) {
      throw new Error(DAEMON_START_HINT)
    }

    if (!daemonStartInFlight) {
      daemonStartInFlight = true
      debugLog(`[powersync] attempting to start daemon via: ${DAEMON_START_COMMAND}`)
      try {
        launchDaemon()
      } catch (error) {
        daemonStartInFlight = false
        throw new Error(`failed to launch PowerSync daemon — ${(error as Error).message}`)
      }
    }

    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      responsive = await isDaemonResponsive()
      if (responsive) {
        daemonStartInFlight = false
        break
      }
      await delay(200)
    }

    if (!responsive) {
      daemonStartInFlight = false
      throw new Error(`${DAEMON_START_HINT} (daemon start timed out)`)
    }
  }

  daemonStartInFlight = false
  await ensureDaemonAuthenticated()
}

type NormalizedAuthStatus =
  | { status: 'ready'; reason?: string | null; context?: Record<string, unknown> | null }
  | { status: 'pending'; reason?: string | null; context?: Record<string, unknown> | null }
  | { status: 'auth_required'; reason?: string | null; context?: Record<string, unknown> | null }
  | { status: 'error'; reason?: string | null; context?: Record<string, unknown> | null }

function normalizeAuthContext(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

function normalizeAuthStatus(payload: unknown): NormalizedAuthStatus | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as { status?: unknown; reason?: unknown; context?: unknown }
  const statusValue = typeof record.status === 'string' ? record.status.toLowerCase() : ''
  if (statusValue !== 'ready' && statusValue !== 'pending' && statusValue !== 'auth_required' && statusValue !== 'error') {
    return null
  }
  const reason = typeof record.reason === 'string' ? record.reason : null
  const context = normalizeAuthContext((record.context ?? null) as unknown)
  return { status: statusValue as NormalizedAuthStatus['status'], reason, context }
}

async function fetchDaemonAuthStatus(): Promise<NormalizedAuthStatus | null> {
  try {
    const res = await fetch(`${daemonBaseUrl}/auth/status`)
    if (!res.ok) return null
    const payload = await res.json().catch(() => null)
    return normalizeAuthStatus(payload)
  } catch {
    return null
  }
}

function formatDeviceInstructions(context: Record<string, unknown> | null | undefined): string | null {
  if (!context) return null
  const verificationUrl =
    typeof context.verificationUrl === 'string' && context.verificationUrl.trim().length > 0
      ? context.verificationUrl.trim()
      : null
  const challengeId =
    typeof context.challengeId === 'string' && context.challengeId.trim().length > 0
      ? context.challengeId.trim()
      : null
  if (verificationUrl) {
    return challengeId
      ? `Open ${verificationUrl} (device code ${challengeId})`
      : `Open ${verificationUrl} to finish login`
  }
  if (challengeId) {
    return `Complete daemon login with device code ${challengeId}`
  }
  return null
}

async function ensureDaemonAuthenticated(): Promise<void> {
  const deadline = Date.now() + DAEMON_AUTH_TIMEOUT_MS
  let lastStatus: NormalizedAuthStatus | null = null
  let pendingNotified = false
  while (Date.now() < deadline) {
    lastStatus = await fetchDaemonAuthStatus()
    if (!lastStatus) {
      await delay(AUTH_STATUS_POLL_INTERVAL_MS)
      continue
    }
    if (lastStatus.status === 'ready') {
      return
    }
    if (lastStatus.status === 'pending') {
      if (!pendingNotified) {
        const instructions = formatDeviceInstructions(lastStatus.context)
        console.error(
          `[powersync] Waiting for PowerSync daemon login to complete.${instructions ? ` ${instructions}.` : ''}`,
        )
        pendingNotified = true
      }
      await delay(AUTH_STATUS_POLL_INTERVAL_MS)
      continue
    }
    if (lastStatus.status === 'auth_required') {
      const instructions = formatDeviceInstructions(lastStatus.context)
      throw new Error(
        `PowerSync daemon is not authenticated. Run "${CLI_LOGIN_HINT}" to sign in via Supabase.${
          instructions ? ` ${instructions}.` : ''
        }`,
      )
    }
    if (lastStatus.status === 'error') {
      const reason = lastStatus.reason ? ` (${lastStatus.reason})` : ''
      throw new Error(`PowerSync daemon authentication failed${reason}. Run "${CLI_LOGIN_HINT}" and retry.`)
    }
  }

  if (lastStatus?.status === 'pending') {
    const instructions = formatDeviceInstructions(lastStatus.context)
    throw new Error(
      `PowerSync daemon login is still pending. ${instructions ?? 'Complete the Supabase device flow'} and retry.`,
    )
  }

  throw new Error(`PowerSync daemon did not report an authenticated session. Run "${CLI_LOGIN_HINT}" and retry.`)
}

function launchDaemon(): void {
  try {
    const child = spawn(DAEMON_START_COMMAND, {
      shell: true,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch (error) {
    throw new Error(`unable to spawn PowerSync daemon (${(error as Error).message})`)
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function isDaemonResponsive(): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DAEMON_CHECK_TIMEOUT_MS)
    const res = await fetch(`${daemonBaseUrl}/health`, { signal: controller.signal })
    clearTimeout(timeout)
    return res.ok
  } catch {
    return false
  }
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
  const client = await ensureClient()
  if (!client) {
    for (const update of updates) println(`error ${update.dst} daemon-unavailable`)
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
    const result = await pushViaDaemon(client, details, resolvedUpdates, packData, { summary, packOid })
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
    const friendly = formatDaemonError('push', error)
    const message = friendly ?? (error as Error).message ?? 'push failed'
    if (friendly) console.error(`[powersync] ${friendly}`)
    else console.error(`[powersync] push failed: ${message}`)
    for (const update of updates) println(`error ${update.dst} ${message}`)
    println('')
  }
}
async function pushViaDaemon(
  client: PowerSyncRemoteClient | null,
  details: { org: string; repo: string },
  updates: PushRequest[],
  packBuffer: Buffer,
  extras: { summary?: GitPushSummary; packOid?: string } = {},
): Promise<PushPackResult> {
  await ensureDaemonReady()

  const targetUpdates = updates.map((update) => ({
    src: update.src && update.src.length > 0 ? update.src : ZERO_SHA,
    dst: update.dst,
    ...(update.force ? { force: true } : {}),
  }))

  const options: Record<string, unknown> = {}
  if (extras.packOid) options.packOid = extras.packOid
  if (extras.summary) options.summary = extras.summary

  if (client) {
    return client.pushPack({
      org: details.org,
      repo: details.repo,
      updates: targetUpdates,
      pack: packBuffer.length > 0 ? packBuffer : Buffer.alloc(0),
      options: Object.keys(options).length > 0 ? options : undefined,
    })
  }

  const payload: Record<string, unknown> = {
    updates: targetUpdates,
  }

  if (packBuffer.length > 0) {
    payload.packBase64 = packBuffer.toString('base64')
    payload.packEncoding = 'base64'
  }

  if (extras.packOid) {
    payload.packOid = extras.packOid
  }

  if (extras.summary) {
    payload.summary = extras.summary
  }

  if (Object.keys(options).length > 0) {
    payload.options = options
  }

  const endpoint = `${daemonBaseUrl}/orgs/${encodeURIComponent(details.org)}/repos/${encodeURIComponent(details.repo)}/git/push`
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`daemon push failed (${res.status} ${res.statusText}${text ? ` — ${text}` : ''})`)
  }

  const data = await res.json().catch(() => ({})) as { ok?: boolean; results?: PushPackResult['results']; message?: string }
  const results = data.results ?? {}
  const ok = data.ok ?? Object.values(results).every((entry) => entry.status === 'ok')
  return { ok, results, message: data.message }
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

  const refMap = new Map<string, { name: string; target: string }>()
  for (const ref of normalizedRefs) {
    if (!ref.name) continue
    refMap.set(ref.name, ref)
  }

  const localRefs = await listLocalRefs().catch((error) => {
    console.warn('[powersync] failed to enumerate local refs', error)
    return [] as Array<{ name: string; target: string }>
  })
  for (const ref of localRefs) {
    if (!ref.name) continue
    if (!refMap.has(ref.name)) {
      refMap.set(ref.name, ref)
    }
    if (!refMap.get(ref.name)?.target && ref.target) {
      refMap.set(ref.name, { name: ref.name, target: ref.target })
    }
  }

  const combinedRefs = Array.from(refMap.values())

  return {
    head: headTarget && headTarget !== ZERO_SHA ? headTarget : undefined,
    refs: combinedRefs,
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
  const headerRaw = await execGit(['show', '--no-patch', '--format=%H%x00%T%x00%an%x00%ae%x00%aI%x00%P%x00%B%x00', sha])
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
  // --root includes changes for root commits (otherwise initial commit shows no files)
  const output = await execGit(['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', sha]).catch((error) => {
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

async function listLocalRefs(): Promise<Array<{ name: string; target: string }>> {
  const output = await execGit(['show-ref']).catch((error) => {
    console.warn('[powersync] git show-ref failed', error)
    return ''
  })
  if (!output) return []
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [sha, name] = line.split(/\s+/, 2)
      return { name: name ?? '', target: sha ?? '' }
    })
    .filter((entry) => entry.name.startsWith('refs/heads/') || entry.name.startsWith('refs/tags/'))
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
  parsePush,
  pushViaDaemon,
  ensureDaemonReady,
  __setDaemonBaseUrlForTests(url: string) {
    daemonBaseUrl = normalizeBaseUrl(url)
    daemonClient = null
    daemonStartInFlight = false
  },
}

function formatDaemonError(operation: string, error: unknown): string | null {
  const err = error as Error & { cause?: unknown }
  const cause = err?.cause as { code?: string } | null | undefined
  if (cause && typeof cause.code === 'string') {
    if (cause.code === 'ECONNREFUSED' || cause.code === 'EHOSTUNREACH' || cause.code === 'ENOENT') {
      return `${DAEMON_START_HINT} (${operation})`
    }
  }
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) {
    return `${DAEMON_START_HINT} (${operation})`
  }
  return null
}
