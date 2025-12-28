
import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { type GitPushSummary, buildRepoStreamTargets } from '@powersync-community/powergit-core'
import {
  PowerSyncRemoteClient,
  type FetchPackResult,
  type PushPackResult,
  resolvePowergitRemote,
} from '@powersync-community/powergit-core/node'

const ZERO_SHA = '0000000000000000000000000000000000000000'
const LOG_PREFIX = '[powergit]'
const MAX_COMMITS_PER_UPDATE = Number.parseInt(
  process.env.POWERGIT_MAX_PUSH_COMMITS ?? process.env.POWERSYNC_MAX_PUSH_COMMITS ?? '256',
  10,
)
const DEFAULT_DAEMON_URL = process.env.POWERGIT_DAEMON_URL ?? process.env.POWERSYNC_DAEMON_URL ?? 'http://127.0.0.1:5030'
const DEFAULT_DAEMON_START_COMMAND = process.env.PNPM_WORKSPACE_DIR
  ? 'pnpm dev:daemon'
  : 'powergit-daemon'
const DAEMON_START_COMMAND =
  process.env.POWERGIT_DAEMON_START_COMMAND ?? process.env.POWERSYNC_DAEMON_START_COMMAND ?? DEFAULT_DAEMON_START_COMMAND
const DAEMON_AUTOSTART_DISABLED =
  (process.env.POWERGIT_DAEMON_AUTOSTART ?? process.env.POWERSYNC_DAEMON_AUTOSTART ?? 'true').toLowerCase() === 'false'
const DAEMON_START_TIMEOUT_MS = Number.parseInt(
  process.env.POWERGIT_DAEMON_START_TIMEOUT_MS ?? process.env.POWERSYNC_DAEMON_START_TIMEOUT_MS ?? '7000',
  10,
)
const DAEMON_CHECK_TIMEOUT_MS = Number.parseInt(
  process.env.POWERGIT_DAEMON_CHECK_TIMEOUT_MS ?? process.env.POWERSYNC_DAEMON_CHECK_TIMEOUT_MS ?? '2000',
  10,
)
const DAEMON_AUTH_TIMEOUT_MS = Number.parseInt(
  process.env.POWERGIT_DAEMON_AUTH_TIMEOUT_MS ?? process.env.POWERSYNC_DAEMON_AUTH_TIMEOUT_MS ?? '15000',
  10,
)
const CLI_LOGIN_HINT = process.env.POWERGIT_LOGIN_COMMAND ?? process.env.POWERSYNC_LOGIN_COMMAND ?? 'powergit login'
const AUTH_STATUS_POLL_INTERVAL_MS = Number.parseInt(
  process.env.POWERGIT_DAEMON_AUTH_POLL_MS ?? process.env.POWERSYNC_DAEMON_AUTH_POLL_MS ?? '500',
  10,
)
const DAEMON_START_HINT =
  'PowerSync daemon unreachable — start it with "powergit-daemon" or point POWERGIT_DAEMON_URL at a running instance.'
const DAEMON_WORKSPACE_DIR = process.env.PNPM_WORKSPACE_DIR ?? process.cwd()

interface FetchRequest { sha: string; name: string }
interface PushRequest { src: string; dst: string; force?: boolean }

let parsed: { org: string; repo: string } | null = null
let daemonClient: PowerSyncRemoteClient | null = null
let daemonBaseUrl = normalizeBaseUrl(DEFAULT_DAEMON_URL)
let daemonProfileName: string | null = null
let daemonEndpointOverride: string | null = null
let fetchBatch: FetchRequest[] = []
let pushBatch: PushRequest[] = []
let cachedSourceRepoUrl: string | null | undefined
let helperProgress: boolean | undefined
let helperVerbosity: number | undefined
let lastLoggedErrorMessage: string | null = null

const debugLogFile = process.env.POWERGIT_HELPER_DEBUG_LOG ?? process.env.POWERSYNC_HELPER_DEBUG_LOG

function debugLog(message: string) {
  if (!debugLogFile) return
  try {
    appendFileSync(debugLogFile, message + '\n')
  } catch (error) {
    console.error('[debugLogError]', (error as Error).message)
  }
}

function println(s: string = '') {
  process.stdout.write(s + '\n')
}

function logError(message: string) {
  const normalized = String(message ?? '').replace(/\r\n/g, '\n').trimEnd()
  if (!normalized) return
  if (lastLoggedErrorMessage === normalized) return
  lastLoggedErrorMessage = normalized

  const lines = normalized.split('\n')
  for (const line of lines) {
    if (line.length === 0) {
      console.error('')
    } else {
      console.error(`${LOG_PREFIX} ${line}`)
    }
  }
}

function handleOption(parts: string[]) {
  const name = parts[0]
  if (!name) return

  if (name === 'progress') {
    const raw = (parts[1] ?? '').toLowerCase()
    if (raw === 'true') helperProgress = true
    else if (raw === 'false') helperProgress = false
    return
  }

  if (name === 'verbosity') {
    const parsed = Number.parseInt(parts[1] ?? '', 10)
    if (Number.isFinite(parsed)) helperVerbosity = parsed
  }
}

function shouldReportStatus(): boolean {
  const env = (process.env.POWERGIT_HELPER_STATUS ?? process.env.POWERSYNC_HELPER_STATUS ?? '').toLowerCase()
  if (env === '0' || env === 'false') return false
  if (helperProgress === false) return false
  if (helperVerbosity !== undefined && helperVerbosity <= 0) return false
  if (env === '1' || env === 'true') return true
  return Boolean(process.stderr.isTTY)
}

export async function runHelper() {
  initFromArgs()
  const iterator = process.stdin[Symbol.asyncIterator]()
  let buffer: Buffer = Buffer.alloc(0)

  while (true) {
    const { line, nextBuffer } = await readNextLine(iterator, buffer)
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
      handleOption(parts.slice(1))
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
    if (friendly) console.error(`${LOG_PREFIX} ${friendly}`)
    else console.error(`${LOG_PREFIX} failed to list refs: ${(error as Error).message}`)
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
    if (friendly) console.error(`${LOG_PREFIX} ${friendly}`)
    else console.error(`${LOG_PREFIX} fetch failed: ${(error as Error).message}`)
    println('')
  } finally {
    fetchBatch = []
  }
}

async function writePackToGit(result: FetchPackResult) {
  const stream = result.stream
  await new Promise<void>((resolve, reject) => {
    let indexPackStdout = ''
    // index-pack prints "pack\t<oid>" to stdout on success; capture it and report via stderr instead.
    const child = spawn('git', ['index-pack', '--stdin', '--fix-thin'], { stdio: ['pipe', 'pipe', 'inherit'] })
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      indexPackStdout += String(chunk)
    })
    stream.pipe(child.stdin!)
    child.stdin!.on('error', reject)
    stream.on('error', reject)
    child.on('error', reject)
    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`git index-pack exited with code ${code}`))
        return
      }

      if (shouldReportStatus()) {
        const lines = indexPackStdout.trim().split(/\r?\n/)
        const lastLine = lines[lines.length - 1] ?? ''
        const match = lastLine.match(/^pack\t([0-9a-f]{40})$/i)
        const packOid = match?.[1] ?? null
        const target = parsed ? `${parsed.org}/${parsed.repo}` : null
        const label = target ? ` (${target})` : ''
        const packShort = packOid ? ` [pack ${packOid.slice(0, 12)}]` : ''
        console.error(`${LOG_PREFIX} fetch complete${label}${packShort}`)
      }

      resolve()
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
    logError(message)
    return null
  }
  if (!daemonClient) {
    if (typeof globalThis.fetch !== 'function') {
      console.error(`${LOG_PREFIX} fetch API unavailable; requires Node 18+`)
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

function ensureRemote(): { org: string; repo: string } | null {
  if (!parsed) return null
  return { org: parsed.org, repo: parsed.repo }
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
          `${LOG_PREFIX} daemon deferred stream subscriptions for ${payload.queued.length} target(s); retrying later may be necessary.`,
        )
      }
    } else if (res.status !== 503) {
      console.warn(`${LOG_PREFIX} daemon stream subscription returned ${res.status} ${res.statusText}`)
    }
  } catch (error) {
    console.warn(`${LOG_PREFIX} failed to subscribe daemon streams`, error instanceof Error ? error.message : error)
  }
}

let daemonStartInFlight = false

function resolvePowergitHome(): string {
  const override = process.env.POWERGIT_HOME
  if (override && override.trim().length > 0) {
    return resolvePath(override.trim())
  }
  return resolvePath(homedir(), '.powergit')
}

function sanitizeProfileKey(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'default'
  // Keep it filesystem friendly but deterministic.
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function resolveDaemonStatePaths(profileName: string | null): { dbPath: string; sessionPath: string } {
  const profileKey = sanitizeProfileKey(profileName ?? 'default')
  const baseDir = resolvePath(resolvePowergitHome(), 'daemon', profileKey)
  return {
    dbPath: resolvePath(baseDir, 'powersync-daemon.db'),
    sessionPath: resolvePath(baseDir, 'session.json'),
  }
}

function extractContextString(context: Record<string, unknown> | null | undefined, key: string): string | null {
  if (!context) return null
  const value = context[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function extractDaemonProfileName(context: Record<string, unknown> | null | undefined): string | null {
  return extractContextString(context, 'profile') ?? extractContextString(context, 'profileName')
}

function extractDaemonEndpoint(context: Record<string, unknown> | null | undefined): string | null {
  return extractContextString(context, 'endpoint')
}

function resolveLoginHint(): string {
  const override = process.env.POWERGIT_LOGIN_COMMAND ?? process.env.POWERSYNC_LOGIN_COMMAND
  if (override && override.trim().length > 0) return override.trim()
  if (daemonProfileName && daemonProfileName.trim().length > 0 && daemonProfileName !== 'prod') {
    return `STACK_PROFILE=${daemonProfileName} powergit login`
  }
  return 'powergit login'
}

async function ensureDaemonReady(): Promise<void> {
  if (typeof globalThis.fetch !== 'function') return
  let responsive = await isDaemonResponsive()
  if (!responsive) {
    if (DAEMON_AUTOSTART_DISABLED) {
      throw new Error(DAEMON_START_HINT)
    }

    if (!daemonStartInFlight) {
      daemonStartInFlight = true
      debugLog(`${LOG_PREFIX} attempting to start daemon via: ${DAEMON_START_COMMAND}`)
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

  await ensureDaemonMatchesRemote()

  daemonStartInFlight = false
  await ensureDaemonAuthenticated()
}

async function ensureDaemonMatchesRemote(): Promise<void> {
  if (!daemonProfileName && !daemonEndpointOverride) {
    return
  }
  const status = await fetchDaemonAuthStatus()
  const context = status?.context ?? null
  const currentProfile = extractDaemonProfileName(context)
  const currentEndpoint = extractDaemonEndpoint(context)

  const desiredProfile = daemonProfileName
  const desiredEndpoint = daemonEndpointOverride

  const profileMismatch =
    Boolean(desiredProfile && currentProfile && desiredProfile.trim().length > 0 && currentProfile !== desiredProfile)
  const endpointMismatch =
    Boolean(
      desiredEndpoint &&
        currentEndpoint &&
        normalizeBaseUrl(currentEndpoint) !== normalizeBaseUrl(desiredEndpoint),
    )

  if (!profileMismatch && !endpointMismatch) {
    return
  }

  if (DAEMON_AUTOSTART_DISABLED) {
    const target = desiredProfile ? `profile "${desiredProfile}"` : 'the requested stack'
    const running = currentProfile ? ` (currently "${currentProfile}")` : ''
    throw new Error(
      `PowerSync daemon is running with the wrong configuration${running}. Restart it for ${target} and retry.`,
    )
  }

  debugLog(
    `${LOG_PREFIX} restarting daemon (profileMismatch=${profileMismatch}, endpointMismatch=${endpointMismatch})`,
  )

  await requestDaemonShutdown()
  await waitForDaemonExit()
  daemonClient = null

  // Restart with the requested environment/profile.
  launchDaemon()

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isDaemonResponsive()) {
      return
    }
    await delay(200)
  }
  throw new Error(`${DAEMON_START_HINT} (daemon restart timed out)`)
}

async function requestDaemonShutdown(): Promise<void> {
  try {
    const res = await fetch(`${daemonBaseUrl}/shutdown`, { method: 'POST' })
    if (res.ok) return
    const text = await res.text().catch(() => '')
    throw new Error(`shutdown returned ${res.status} ${res.statusText}${text ? ` — ${text}` : ''}`)
  } catch (error) {
    throw new Error(`failed to request daemon shutdown (${(error as Error).message})`)
  }
}

async function waitForDaemonExit(timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await isDaemonResponsive())) return
    await delay(200)
  }
  throw new Error('daemon shutdown timed out')
}

type NormalizedAuthStatus =
  | {
      status: 'ready' | 'pending' | 'auth_required' | 'error'
      reason: string | null
      context: Record<string, unknown> | null
      token: string | null
      expiresAt: string | null
    }

function normalizeAuthContext(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return raw as Record<string, unknown>
}

function normalizeAuthStatus(payload: unknown): NormalizedAuthStatus | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const record = payload as { status?: unknown; reason?: unknown; context?: unknown; token?: unknown; expiresAt?: unknown }
  const statusValue = typeof record.status === 'string' ? record.status.toLowerCase() : ''
  if (statusValue !== 'ready' && statusValue !== 'pending' && statusValue !== 'auth_required' && statusValue !== 'error') {
    return null
  }
  const reason = typeof record.reason === 'string' ? record.reason : null
  const context = normalizeAuthContext((record.context ?? null) as unknown)
  const token = typeof record.token === 'string' && record.token.trim().length > 0 ? record.token : null
  const expiresAt =
    typeof record.expiresAt === 'string' && record.expiresAt.trim().length > 0 ? record.expiresAt : null
  return { status: statusValue as NormalizedAuthStatus['status'], reason, context, token, expiresAt }
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

type DeviceChallenge = { challengeId: string; verificationUrl: string | null; expiresAt: string | null }

function extractDeviceChallenge(context: Record<string, unknown> | null | undefined): DeviceChallenge | null {
  if (!context) return null
  const challengeId =
    (typeof context.challengeId === 'string' ? context.challengeId : null) ??
    (typeof context.deviceCode === 'string' ? context.deviceCode : null) ??
    (typeof (context as { device_code?: unknown }).device_code === 'string' ? (context as { device_code?: string }).device_code : null)

  const verificationUrl =
    typeof context.verificationUrl === 'string'
      ? context.verificationUrl
      : typeof (context as { verification_url?: unknown }).verification_url === 'string'
        ? (context as { verification_url?: string }).verification_url
        : null

  const expiresAt =
    typeof context.expiresAt === 'string'
      ? context.expiresAt
      : typeof (context as { expires_at?: unknown }).expires_at === 'string'
        ? (context as { expires_at?: string }).expires_at
        : null

  const trimmedId = challengeId?.trim() ?? ''
  if (!trimmedId) return null
  return {
    challengeId: trimmedId,
    verificationUrl: verificationUrl?.trim() ? verificationUrl.trim() : null,
    expiresAt: expiresAt?.trim() ? expiresAt.trim() : null,
  }
}

function resolveDeviceLoginUrl(challenge: DeviceChallenge): string | null {
  if (challenge.verificationUrl) return challenge.verificationUrl
  const fallbackBase =
    process.env.POWERGIT_DAEMON_DEVICE_URL ??
    process.env.POWERSYNC_DAEMON_DEVICE_URL ??
    process.env.POWERSYNC_EXPLORER_URL ??
    `${daemonBaseUrl}/ui/auth`
  const base = (fallbackBase ?? '').trim()
  if (!base) return null
  const separator = base.includes('?') ? '&' : '?'
  return `${base}${separator}device_code=${encodeURIComponent(challenge.challengeId)}`
}

function formatDeviceChallengePrompt(title: string, challenge: DeviceChallenge | null): string {
  if (!challenge) return title
  const lines: string[] = [title]
  const openUrl = resolveDeviceLoginUrl(challenge)
  if (openUrl) {
    lines.push('   Open:')
    lines.push(`   ${openUrl}`)
  } else {
    lines.push('   No device login URL configured.')
    lines.push('   Set POWERGIT_DAEMON_DEVICE_URL (or POWERSYNC_DAEMON_DEVICE_URL).')
  }
  lines.push(
    '   If the page can’t reach your local daemon (e.g. net::ERR_BLOCKED_BY_CLIENT), try incognito or disable ad blockers/privacy shields.',
  )
  lines.push(`   Device code: ${challenge.challengeId}`)
  if (challenge.expiresAt) {
    lines.push(`   Expires: ${challenge.expiresAt}`)
  }
  return lines.join('\n')
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
      const challenge = extractDeviceChallenge(lastStatus.context)

      if (!lastStatus.token && !challenge) {
        const loginHint = resolveLoginHint()
        const lines = [
          'Daemon requested interactive login.',
          formatDeviceChallengePrompt('To finish authentication:', null),
          `   Run: ${loginHint}`,
          '   This prints a browser URL and device code.',
          '   Open the URL to complete authentication, then retry your git command.',
          lastStatus.reason ? `Reason: ${lastStatus.reason}` : null,
        ].filter((value): value is string => Boolean(value && value.trim().length > 0))
        throw new Error(lines.join('\n'))
      }

      if (!pendingNotified) {
        if (challenge) {
          logError(
            [
              'Daemon requested interactive login.',
              formatDeviceChallengePrompt('To finish authentication:', challenge),
              'Waiting for daemon authentication to complete...',
            ].join('\n'),
          )
        } else {
          const reason = lastStatus.reason ? ` (${lastStatus.reason})` : ''
          logError(`Waiting for PowerSync daemon to become ready${reason}.`)
        }
        pendingNotified = true
      }
      await delay(AUTH_STATUS_POLL_INTERVAL_MS)
      continue
    }
    if (lastStatus.status === 'auth_required') {
      const loginHint = resolveLoginHint()
      const challenge = extractDeviceChallenge(lastStatus.context)
      const lines = [
        'PowerSync daemon is not authenticated.',
        formatDeviceChallengePrompt('To finish authentication:', challenge),
        `   Run: ${loginHint}`,
        challenge ? null : '   Open the printed URL to complete authentication, then retry your git command.',
        lastStatus.reason ? `Reason: ${lastStatus.reason}` : null,
      ].filter((value): value is string => Boolean(value && value.trim().length > 0))
      throw new Error(lines.join('\n'))
    }
    if (lastStatus.status === 'error') {
      const reason = lastStatus.reason ? ` (${lastStatus.reason})` : ''
      throw new Error(`PowerSync daemon authentication failed${reason}. Run "${resolveLoginHint()}" and retry.`)
    }
  }

  if (lastStatus?.status === 'pending') {
    const challenge = extractDeviceChallenge(lastStatus.context)
    const reason = lastStatus.reason ? `Reason: ${lastStatus.reason}` : null
    if (!lastStatus.token && !challenge) {
      const loginHint = resolveLoginHint()
      const lines = [
        'Daemon requested interactive login.',
        formatDeviceChallengePrompt('To finish authentication:', null),
        `   Run: ${loginHint}`,
        '   This prints a browser URL and device code.',
        '   Open the URL to complete authentication, then retry your git command.',
        reason,
      ].filter((value): value is string => Boolean(value && value.trim().length > 0))
      throw new Error(lines.join('\n'))
    }
    if (challenge) {
      const lines = [
        'Authentication is still pending; complete the flow in your browser and retry.',
        formatDeviceChallengePrompt('Pending device challenge:', challenge),
        reason,
      ].filter((value): value is string => Boolean(value && value.trim().length > 0))
      throw new Error(lines.join('\n'))
    }
    throw new Error(`PowerSync daemon is still starting. ${reason ?? 'Retry shortly.'}`)
  }

  throw new Error(`PowerSync daemon did not report an authenticated session. Run "${CLI_LOGIN_HINT}" and retry.`)
}

function launchDaemon(): void {
  try {
    const env = buildDaemonEnv()
    const child = spawn(DAEMON_START_COMMAND, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      env,
      cwd: DAEMON_WORKSPACE_DIR,
    })
    child.unref()
  } catch (error) {
    throw new Error(`unable to spawn PowerSync daemon (${(error as Error).message})`)
  }
}

function buildDaemonEnv(): NodeJS.ProcessEnv {
  if (!daemonProfileName) {
    if (!daemonEndpointOverride) return process.env
  }
  const env = { ...process.env }
  if (daemonProfileName) {
    const profileManagedKeys = [
      'POWERSYNC_URL',
      'POWERSYNC_DAEMON_ENDPOINT',
      'POWERSYNC_ENDPOINT',
      'POWERGIT_TEST_ENDPOINT',
      'SUPABASE_URL',
      'SUPABASE_ANON_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_EMAIL',
      'SUPABASE_PASSWORD',
      'SUPABASE_SCHEMA',
      'POWERGIT_TEST_SUPABASE_URL',
      'POWERGIT_TEST_SUPABASE_ANON_KEY',
      'POWERGIT_TEST_SUPABASE_SERVICE_ROLE_KEY',
      'POWERGIT_TEST_SUPABASE_EMAIL',
      'POWERGIT_TEST_SUPABASE_PASSWORD',
    ]
    for (const key of profileManagedKeys) {
      delete env[key]
    }

    env.STACK_PROFILE = daemonProfileName
    env.POWERGIT_PROFILE = daemonProfileName
    env.POWERGIT_ACTIVE_PROFILE = daemonProfileName
  }

  if (daemonEndpointOverride) {
    env.POWERSYNC_URL = daemonEndpointOverride
    env.POWERSYNC_DAEMON_ENDPOINT = daemonEndpointOverride
    env.POWERSYNC_ENDPOINT = daemonEndpointOverride
    env.POWERGIT_TEST_ENDPOINT = daemonEndpointOverride
  }

  const stateProfileName = daemonProfileName ?? env.STACK_PROFILE ?? env.POWERGIT_PROFILE ?? env.POWERGIT_ACTIVE_PROFILE ?? null
  const statePaths = resolveDaemonStatePaths(stateProfileName)
  const daemonDbPath = env.POWERGIT_DAEMON_DB_PATH ?? env.POWERSYNC_DAEMON_DB_PATH ?? statePaths.dbPath
  env.POWERGIT_DAEMON_DB_PATH = daemonDbPath
  env.POWERSYNC_DAEMON_DB_PATH = daemonDbPath

  const daemonSessionPath = env.POWERGIT_DAEMON_SESSION_PATH ?? env.POWERSYNC_DAEMON_SESSION_PATH ?? statePaths.sessionPath
  env.POWERGIT_DAEMON_SESSION_PATH = daemonSessionPath
  env.POWERSYNC_DAEMON_SESSION_PATH = daemonSessionPath

  return env
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
    const resolved = resolvePowergitRemote(candidate)
    parsed = { org: resolved.org, repo: resolved.repo }
    if (!daemonEndpointOverride && resolved.powersyncUrl) daemonEndpointOverride = resolved.powersyncUrl
    if (resolved.profileName && !daemonProfileName) daemonProfileName = resolved.profileName
    return true
  } catch (error) {
    if (candidate.includes('::') || candidate.includes('://')) {
      console.error(`${LOG_PREFIX} failed to parse remote URL: ${(error as Error).message}`)
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
      console.warn(`${LOG_PREFIX} failed to collect push summary`, error)
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
    if (friendly) console.error(`${LOG_PREFIX} ${friendly}`)
    else console.error(`${LOG_PREFIX} push failed: ${message}`)
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
  const sourceRepoUrl = await resolveSourceRepoUrl()

  const targetUpdates = updates.map((update) => ({
    src: update.src && update.src.length > 0 ? update.src : ZERO_SHA,
    dst: update.dst,
    ...(update.force ? { force: true } : {}),
  }))

  const options: Record<string, unknown> = {}
  if (extras.packOid) options.packOid = extras.packOid
  if (extras.summary) options.summary = extras.summary
  if (sourceRepoUrl) options.repoUrl = sourceRepoUrl

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

  if (sourceRepoUrl) {
    payload.repoUrl = sourceRepoUrl
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
  const output = await runGitCapture(['rev-parse', ref])
  if (!output.trim()) {
    throw new Error(`git rev-parse returned empty output for ${ref}`)
  }
  return output.trim()
}

async function resolveSourceRepoUrl(): Promise<string | null> {
  if (cachedSourceRepoUrl !== undefined) return cachedSourceRepoUrl

  const envUrl = [
    process.env.POWERGIT_REPO_URL,
    process.env.POWERGIT_SOURCE_REPO_URL,
    process.env.POWERSYNC_REPO_URL,
    process.env.POWERSYNC_SOURCE_REPO_URL,
  ]
    .map((value) => (value ?? '').trim())
    .find((value) => value.length > 0)
  if (envUrl) {
    cachedSourceRepoUrl = envUrl
    return cachedSourceRepoUrl
  }

  const gitUrl = await readGitRemoteUrl()
  cachedSourceRepoUrl = gitUrl
  return cachedSourceRepoUrl
}

async function readGitRemoteUrl(): Promise<string | null> {
  try {
    const output = await runGitCapture(['config', '--get', 'remote.origin.url'])
    const trimmed = output.trim()
    return trimmed.length > 0 ? trimmed : null
  } catch {
    return null
  }
}

async function runGitCapture(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk.toString('utf8') })
    child.stdout.on('error', reject)
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(output)
      } else {
        reject(new Error(`git ${args.join(' ')} failed (exit code ${code})`))
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
      console.warn(`${LOG_PREFIX} failed to read commit summary`, sha, error)
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
    console.warn(`${LOG_PREFIX} failed to enumerate local refs`, error)
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
    console.warn(`${LOG_PREFIX} failed to list commits for ref`, ref, error)
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
    console.warn(`${LOG_PREFIX} failed to read commit file changes`, sha, error)
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
    console.warn(`${LOG_PREFIX} git show-ref failed`, error)
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
