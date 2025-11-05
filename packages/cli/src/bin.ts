#!/usr/bin/env node
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { addPowerSyncRemote, syncPowerSyncRepository, seedDemoRepository } from './index.js'
import {
  loginWithDaemonDevice,
  loginWithDaemonGuest,
  loginWithSupabasePassword,
  logout as logoutSession,
} from './auth/login.js'
import {
  resolveProfile,
  listProfiles,
  getProfile,
  setActiveProfile,
  saveProfile,
  buildEnvFromProfile,
  type ProfileConfig,
  type ResolvedProfile,
} from './profile-manager.js'
import { loadStackEnv } from './stack-env.js'

interface LoginCommandArgs {
  manual?: boolean
  guest?: boolean
  auto?: boolean
  token?: string
  endpoint?: string
  session?: string
  daemonUrl?: string
  supabaseEmail?: string
  supabasePassword?: string
  supabaseUrl?: string
  supabaseAnonKey?: string
}

interface DemoSeedCommandArgs {
  remoteUrl?: string | null
  remoteName?: string | null
  branch?: string | null
  skipSync?: boolean
  keepRepo?: boolean
  repoDir?: string | null
  templateRepoUrl?: string | null | undefined
}

interface LogoutCommandArgs {
  session?: string
  daemonUrl?: string
}

interface DaemonStopCommandArgs {
  daemonUrl?: string
  waitMs?: number
  quiet?: boolean
}

interface ResolvedGuestCredentials {
  token: string
  endpoint?: string
  expiresAt?: string | null
  obtainedAt?: string | null
  metadata?: Record<string, unknown> | null
  source: 'flag' | 'env' | 'supabase-password'
}

const PSGIT_STACK_ENV = process.env.PSGIT_STACK_ENV
const STACK_ENV_DISABLED = (process.env.PSGIT_NO_STACK_ENV ?? '').toLowerCase() === 'true'
const appliedStackEnvPaths = new Set<string>()
const stackProfileOverride = process.env.STACK_PROFILE
const activeProfileContext: ResolvedProfile = resolveProfile({
  name: stackProfileOverride ?? null,
  updateState: !stackProfileOverride,
  strict: Boolean(stackProfileOverride),
})

process.env.STACK_PROFILE = activeProfileContext.name
process.env.PSGIT_ACTIVE_PROFILE = activeProfileContext.name
for (const [key, value] of Object.entries(activeProfileContext.env)) {
  if (typeof value !== 'string') continue
  process.env[key] = value
}

if (stackProfileOverride) {
  console.info(`[psgit] Using profile "${activeProfileContext.name}" (via STACK_PROFILE)`)
} else if (activeProfileContext.name !== 'local-dev' || activeProfileContext.source === 'file') {
  console.info(`[psgit] Using profile "${activeProfileContext.name}"`)
}

function applyStackEnv(path: string, { silent = false }: { silent?: boolean } = {}): boolean {
  const loaded = loadStackEnv(path)
  if (!loaded) {
    return false
  }

  const resolvedPath = loaded.path
  if (appliedStackEnvPaths.has(resolvedPath)) {
    return true
  }

  for (const [key, value] of Object.entries(loaded.values)) {
    process.env[key] = value
  }

  appliedStackEnvPaths.add(resolvedPath)
  if (!silent) {
    console.info(`[psgit] Loaded stack environment from ${resolvedPath}`)
  }
  return true
}

function maybeApplyStackEnv({
  explicitPath,
  silent = false,
  allowMissing = true,
  includeDefault = true,
}: {
  explicitPath?: string
  silent?: boolean
  allowMissing?: boolean
  includeDefault?: boolean
} = {}) {
  if (STACK_ENV_DISABLED) return

  const candidates: Array<{ path: string; silent: boolean; allowMissing: boolean }> = []
  if (explicitPath) {
    const allowMissingExplicit =
      activeProfileContext.stackEnvPath !== undefined && explicitPath === activeProfileContext.stackEnvPath
    candidates.push({ path: explicitPath, silent: false, allowMissing: allowMissingExplicit })
  } else if (PSGIT_STACK_ENV) {
    candidates.push({ path: PSGIT_STACK_ENV, silent, allowMissing: false })
  }
  for (const candidate of candidates) {
    const loaded = applyStackEnv(candidate.path, { silent: candidate.silent })
    if (loaded) return
    if (!candidate.allowMissing) {
      throw new Error(`Stack env file not found: ${candidate.path}`)
    }
  }
}

function firstNonEmpty(...candidates: Array<string | null | undefined>): string | undefined {
  for (const value of candidates) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (trimmed.length > 0) {
      return trimmed
    }
  }
  return undefined
}

function parseKeyPath(input: string): string[] {
  const segments = input
    .split('.')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
  if (segments.length === 0) {
    throw new Error(`Invalid key path "${input}". Use dot notation, e.g. "powersync.url".`)
  }
  return segments
}

function setConfigValue(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor: Record<string, unknown> = target
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i]
    const existing = cursor[segment]
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      const next: Record<string, unknown> = {}
      cursor[segment] = next
      cursor = next
    } else {
      cursor = existing as Record<string, unknown>
    }
  }
  const finalKey = path[path.length - 1]
  cursor[finalKey] = value
}

function unsetConfigValue(target: Record<string, unknown>, path: string[]): void {
  if (path.length === 0) return
  const stack: Array<{ parent: Record<string, unknown>; key: string }> = []
  let cursor: unknown = target
  for (let i = 0; i < path.length - 1; i += 1) {
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
      return
    }
    const parent = cursor as Record<string, unknown>
    const key = path[i]
    const next = parent[key]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      return
    }
    stack.push({ parent, key })
    cursor = next
  }

  if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) {
    return
  }

  const container = cursor as Record<string, unknown>
  const finalKey = path[path.length - 1]
  if (!(finalKey in container)) {
    return
  }

  delete container[finalKey]

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const { parent, key } = stack[i]
    const child = parent[key]
    if (
      child &&
      typeof child === 'object' &&
      !Array.isArray(child) &&
      Object.keys(child as Record<string, unknown>).length === 0
    ) {
      delete parent[key]
    } else {
      break
    }
  }
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.')
  if (parts.length < 2) return null
  try {
    const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=')
    const json = Buffer.from(padded, 'base64').toString('utf8')
    const payload = JSON.parse(json)
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function getTokenExpirationMs(token: string): number | null {
  const payload = parseJwtPayload(token)
  if (!payload) return null
  const raw = (payload as { exp?: unknown }).exp
  if (typeof raw === 'number') {
    const expiresAt = raw * 1000
    return Number.isFinite(expiresAt) ? expiresAt : null
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseFloat(raw)
    if (!Number.isFinite(parsed)) return null
    const expiresAt = parsed * 1000
    return Number.isFinite(expiresAt) ? expiresAt : null
  }
  return null
}

function persistDaemonCredentials(token: string, expiresAt: string | null | undefined, context: unknown) {
  if (typeof token !== 'string' || token.trim().length === 0) return
  const profileName = activeProfileContext.name
  const existing = getProfile(profileName)
  const working: ProfileConfig = existing
    ? (JSON.parse(JSON.stringify(existing)) as ProfileConfig)
    : {}
  const powersyncConfig = { ...(working.powersync ?? {}) }
  const daemonConfig = { ...(working.daemon ?? {}) }
  daemonConfig.token = token
  daemonConfig.tokenExpiresAt = expiresAt ?? null
  if (context && typeof context === 'object' && !Array.isArray(context)) {
    const endpoint = (context as { endpoint?: unknown }).endpoint
    if (typeof endpoint === 'string' && endpoint.trim().length > 0) {
      powersyncConfig.url = endpoint.trim()
      powersyncConfig.endpoint = endpoint.trim()
    }
  }
  working.powersync = powersyncConfig
  working.daemon = daemonConfig
  saveProfile(profileName, working)
  activeProfileContext.config = working
  activeProfileContext.stackEnvPath = working.stackEnvPath
  const { env } = buildEnvFromProfile(working)
  activeProfileContext.env = env
  for (const [key, value] of Object.entries(env)) {
    process.env[key] = value
  }
  for (const key of ['POWERSYNC_DAEMON_TOKEN', 'POWERSYNC_SERVICE_TOKEN', 'POWERSYNC_DAEMON_GUEST_TOKEN']) {
    if (!(key in env)) {
      delete process.env[key]
    }
  }
}

function isTokenExpired(token: string, skewMs = 0): boolean {
  const expiresAt = getTokenExpirationMs(token)
  if (!expiresAt) return false
  return expiresAt <= Date.now() + Math.max(0, skewMs)
}

function tokenHasIatClaim(token: string): boolean {
  const payload = parseJwtPayload(token)
  if (!payload) return false
  const value = payload.iat
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (typeof value === 'string') {
    return value.trim().length > 0
  }
  return false
}

function inferGuestTokenFromEnv(): { token: string; source: string } | null {
  const sources: Array<{ key: string; value: string | undefined }> = [
    { key: 'POWERSYNC_DAEMON_GUEST_TOKEN', value: process.env.POWERSYNC_DAEMON_GUEST_TOKEN },
    { key: 'POWERSYNC_DAEMON_TOKEN', value: process.env.POWERSYNC_DAEMON_TOKEN },
    { key: 'POWERSYNC_TOKEN', value: process.env.POWERSYNC_TOKEN },
    { key: 'PSGIT_TEST_REMOTE_TOKEN', value: process.env.PSGIT_TEST_REMOTE_TOKEN },
    { key: 'POWERSYNC_SERVICE_TOKEN', value: process.env.POWERSYNC_SERVICE_TOKEN },
  ]

  for (const candidate of sources) {
    if (typeof candidate.value !== 'string') continue
    const trimmed = candidate.value.trim()
    if (trimmed.length > 0) {
      return { token: trimmed, source: candidate.key }
    }
  }
  return null
}

async function resolveGuestCredentials(args: LoginCommandArgs): Promise<ResolvedGuestCredentials | null> {
  if (typeof args.token === 'string' && args.token.trim().length > 0) {
    return {
      token: args.token.trim(),
      endpoint: args.endpoint,
      source: 'flag',
      metadata: { source: 'flag' },
    }
  }

  const endpointHint = firstNonEmpty(
    args.endpoint,
    process.env.POWERSYNC_ENDPOINT,
    process.env.PSGIT_TEST_ENDPOINT,
    process.env.POWERSYNC_DAEMON_ENDPOINT,
    process.env.POWERSYNC_ENDPOINT,
  )

  const envToken = inferGuestTokenFromEnv()
  if (envToken) {
    if (!tokenHasIatClaim(envToken.token)) {
      console.warn(`[psgit] Skipping ${envToken.source} guest token: missing 'iat' claim.`)
    } else if (isTokenExpired(envToken.token, 5_000)) {
      console.warn(`[psgit] Skipping ${envToken.source} guest token: token expired.`)
    } else {
      return {
        token: envToken.token,
        endpoint: endpointHint,
        source: 'env',
        metadata: { source: envToken.source },
      }
    }
  }

  const supabaseUrl = firstNonEmpty(args.supabaseUrl, process.env.POWERSYNC_SUPABASE_URL, process.env.PSGIT_TEST_SUPABASE_URL, process.env.SUPABASE_URL)
  const supabaseAnonKey = firstNonEmpty(args.supabaseAnonKey, process.env.POWERSYNC_SUPABASE_ANON_KEY, process.env.PSGIT_TEST_SUPABASE_ANON_KEY, process.env.SUPABASE_ANON_KEY)
  const supabaseEmail = firstNonEmpty(args.supabaseEmail, process.env.POWERSYNC_SUPABASE_EMAIL, process.env.PSGIT_TEST_SUPABASE_EMAIL)
  const supabasePassword = firstNonEmpty(args.supabasePassword, process.env.POWERSYNC_SUPABASE_PASSWORD, process.env.PSGIT_TEST_SUPABASE_PASSWORD)
  const endpoint = endpointHint

  if (supabaseUrl && supabaseAnonKey && supabaseEmail && supabasePassword && endpoint) {
    try {
      const result = await loginWithSupabasePassword({
        endpoint,
        supabaseUrl,
        supabaseAnonKey,
        supabaseEmail,
        supabasePassword,
        persistSession: false,
      })

      return {
        token: result.credentials.token,
        endpoint: result.credentials.endpoint,
        expiresAt: result.credentials.expiresAt ?? null,
        obtainedAt: result.credentials.obtainedAt ?? null,
        metadata: { source: 'supabase-password' },
        source: 'supabase-password',
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(`[psgit] Supabase password guest fallback failed: ${message}`)
    }
  }

  return null
}

function normalizeDaemonBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

async function isDaemonResponsiveLocal(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal })
    clearTimeout(timeout)
    return response.ok
  } catch {
    return false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => {
    setTimeout(resolvePromise, ms)
  })
}

async function runRemoteAddCommand(args: { url: string; remote?: string | null }) {
  const remoteName = args.remote ?? process.env.REMOTE_NAME ?? 'origin'
  await addPowerSyncRemote(process.cwd(), remoteName, args.url)
  console.log(`Added PowerSync remote (${remoteName}): ${args.url}`)
}

async function runSyncCommand(args: { remote?: string | null }) {
  const remoteName = args.remote ?? process.env.REMOTE_NAME ?? 'origin'
  const result = await syncPowerSyncRepository(process.cwd(), {
    remoteName,
  })
  console.log(`Synced PowerSync repo ${result.org}/${result.repo}`)
  console.log(`  Endpoint: ${result.endpoint}`)
  if (result.databasePath) {
    console.log(`  Snapshot: ${result.databasePath}`)
  }
  console.log(
    `  Rows: ${result.counts.refs} refs, ${result.counts.commits} commits, ${result.counts.file_changes} file changes, ${result.counts.objects} objects`,
  )
}

async function runDemoSeedCommand(args: DemoSeedCommandArgs) {
  const options: Parameters<typeof seedDemoRepository>[0] = {
    remoteUrl: args.remoteUrl ?? undefined,
    remoteName: args.remoteName ?? undefined,
    branch: args.branch ?? undefined,
    skipSync: Boolean(args.skipSync),
    keepWorkingDir: args.keepRepo ?? Boolean(args.repoDir),
    workingDir: args.repoDir ?? undefined,
    templateRepoUrl: args.templateRepoUrl === null ? null : args.templateRepoUrl ?? undefined,
  }

  const result = await seedDemoRepository(options)
  console.log('✅ Seeded demo repository via PowerSync remote.')
  console.log(`   Remote: ${result.remoteUrl}`)
  console.log(`   Branch: ${result.branch}`)
  if (result.templateRepoUrl) {
    console.log(`   Template: ${result.templateRepoUrl}`)
  }
  if (options.keepWorkingDir && result.workingDirectory) {
    console.log(`   Temp repo kept at: ${result.workingDirectory}`)
  }
  if (!options.skipSync && result.syncedDatabase) {
    console.log(`   Local snapshot: ${result.syncedDatabase}`)
  }
}

async function runLoginCommand(args: LoginCommandArgs) {
  let mode: 'auto' | 'manual' | 'guest' = 'auto'
  if (args.manual) mode = 'manual'
  if (args.guest) mode = 'guest'
  if (args.auto) mode = 'auto'

  if (mode === 'manual') {
    if (!args.token) {
      throw new Error('Manual login requires --token.')
    }
    const { baseUrl, status } = await loginWithDaemonGuest({
      daemonUrl: args.daemonUrl,
      endpoint: args.endpoint,
      token: args.token,
      metadata: { source: 'manual' },
    })
    if (!status) {
      throw new Error(`Daemon at ${baseUrl} did not return an auth status.`)
    }
    if (status.status !== 'ready') {
      const reason = status.reason ? ` (${status.reason})` : ''
      throw new Error(`Daemon reported ${status.status}${reason}.`)
    }
    persistDaemonCredentials(status.token, status.expiresAt ?? null, status.context ?? null)
    console.log('✅ PowerSync daemon accepted manual token.')
    console.log(`   Endpoint: ${args.endpoint ?? 'auto'}`)
    if (status.expiresAt) {
      console.log(`   Expires: ${status.expiresAt}`)
    }
    return
  }

  if (mode === 'guest') {
    const guestCredentials = await resolveGuestCredentials(args)
    if (!guestCredentials) {
      console.warn('[psgit] No guest token detected via flags or environment; requesting daemon fallback.')
    } else if (guestCredentials.source === 'supabase-password') {
      console.log('[psgit] Minted PowerSync token via Supabase password login for guest session.')
    }

    const { baseUrl, status } = await loginWithDaemonGuest({
      daemonUrl: args.daemonUrl,
      endpoint: guestCredentials?.endpoint ?? args.endpoint,
      token: guestCredentials?.token,
      expiresAt: guestCredentials?.expiresAt ?? null,
      obtainedAt: guestCredentials?.obtainedAt ?? null,
      metadata: guestCredentials?.metadata ?? null,
    })
    if (!status) {
      throw new Error(`Daemon at ${baseUrl} did not return an auth status.`)
    }
    if (status.status === 'ready') {
      persistDaemonCredentials(status.token, status.expiresAt ?? null, status.context ?? null)
      console.log('✅ Daemon joined as guest.')
      if (status.expiresAt) {
        console.log(`   Expires: ${status.expiresAt}`)
      }
      const metadataSource =
        typeof guestCredentials?.metadata?.source === 'string'
          ? guestCredentials.metadata.source
          : guestCredentials?.source === 'supabase-password'
            ? 'supabase-password'
            : guestCredentials?.source === 'env'
              ? 'environment'
              : guestCredentials?.source === 'flag'
                ? 'flag'
                : null
      if (metadataSource) {
        console.log(`   Token source: ${metadataSource}`)
      }
      return
    }
    if (status.status === 'pending') {
      console.log('Daemon reports authentication pending. Complete the guest provisioning and rerun `psgit login --guest`.')
      if (status.reason) {
        console.log(`Reason: ${status.reason}`)
      }
      process.exit(1)
    }
    const reason = status.reason ? ` (${status.reason})` : ''
    throw new Error(`Daemon guest login failed with status ${status.status}${reason}.`)
  }

  if (
    args.supabaseEmail != null ||
    args.supabasePassword != null ||
    args.supabaseUrl != null ||
    args.supabaseAnonKey != null
  ) {
    console.warn('[psgit] Supabase credential flags are no longer supported; routing login through daemon device flow.')
  }

  let observedChallenge: {
    challengeId?: string | null
    verificationUrl?: string | null
    expiresAt?: string | null
  } | null = null
  let printedPendingPrompt = false

  const explainChallenge = (prefix: string, override?: typeof observedChallenge) => {
    const challenge = override ?? observedChallenge
    if (!challenge || !challenge.challengeId) return
    console.log(prefix)
    if (challenge.verificationUrl) {
      console.log(`   Open: ${challenge.verificationUrl}`)
    } else {
      const fallbackUrl = process.env.POWERSYNC_DAEMON_DEVICE_URL ?? process.env.POWERSYNC_EXPLORER_URL
      if (fallbackUrl) {
        const separator = fallbackUrl.includes('?') ? '&' : '?'
        console.log(`   Open: ${fallbackUrl}${separator}device_code=${challenge.challengeId}`)
      }
    }
    console.log(`   Device code: ${challenge.challengeId}`)
    if (challenge.expiresAt) {
      console.log(`   Expires: ${challenge.expiresAt}`)
    }
  }

  const loginResult = await loginWithDaemonDevice({
    daemonUrl: args.daemonUrl,
    endpoint: args.endpoint,
    onStatus: (status) => {
      if (!status || status.status !== 'pending') {
        return
      }
      const context =
        status.context && typeof status.context === 'object' && !Array.isArray(status.context)
          ? (status.context as Record<string, unknown>)
          : {}
      const challengeId =
        typeof context.challengeId === 'string'
          ? context.challengeId
          : typeof context.deviceCode === 'string'
            ? context.deviceCode
            : typeof (context as { device_code?: unknown }).device_code === 'string'
              ? (context as { device_code?: string }).device_code
              : null
      const verificationUrl = typeof context.verificationUrl === 'string' ? context.verificationUrl : null
      const expiresAt = typeof context.expiresAt === 'string' ? context.expiresAt : null
      observedChallenge = { challengeId, verificationUrl, expiresAt }
      if (!printedPendingPrompt) {
        if (status.reason) {
          console.log(`Daemon requested interactive login: ${status.reason}`)
        } else {
          console.log('Daemon requested interactive login.')
        }
        explainChallenge('To finish authentication:', observedChallenge)
        console.log('Waiting for daemon authentication to complete...')
        printedPendingPrompt = true
      }
    },
  })

  const initialStatus = loginResult.initialStatus
  if (initialStatus?.status === 'pending') {
    if (initialStatus.reason && !printedPendingPrompt) {
      console.log(`Daemon requested interactive login: ${initialStatus.reason}`)
    }
    if (!printedPendingPrompt) {
      if (loginResult.challenge) {
        explainChallenge('To finish authentication:', {
          challengeId: loginResult.challenge.challengeId,
          verificationUrl: loginResult.challenge.verificationUrl ?? null,
          expiresAt: loginResult.challenge.expiresAt ?? null,
        })
      } else {
        explainChallenge('To finish authentication:')
      }
      console.log('Waiting for daemon authentication to complete...')
      printedPendingPrompt = true
    }
  }

  const finalStatus = loginResult.finalStatus
  if (!finalStatus) {
    throw new Error('Daemon did not provide an auth status. Check daemon logs for details.')
  }

  if (finalStatus.status === 'ready') {
    persistDaemonCredentials(finalStatus.token, finalStatus.expiresAt ?? null, finalStatus.context ?? null)
    console.log('✅ PowerSync daemon authenticated successfully.')
    if (finalStatus.expiresAt) {
      console.log(`   Expires: ${finalStatus.expiresAt}`)
    }
    return
  }

  if (finalStatus.status === 'error' || finalStatus.status === 'auth_required') {
    const reason = finalStatus.reason ? ` (${finalStatus.reason})` : ''
    throw new Error(`Daemon reported ${finalStatus.status}${reason}.`)
  }

  if (loginResult.timedOut) {
    const reason = finalStatus.reason ? ` (${finalStatus.reason})` : ''
    if (loginResult.challenge) {
      explainChallenge('Authentication is still pending; complete the flow in your browser or Explorer.', {
        challengeId: loginResult.challenge.challengeId,
        verificationUrl: loginResult.challenge.verificationUrl ?? null,
        expiresAt: loginResult.challenge.expiresAt ?? null,
      })
    } else {
      explainChallenge('Authentication is still pending; complete the flow in your browser or Explorer.')
    }
    throw new Error(`Timed out waiting for daemon authentication${reason}.`)
  }

  console.log('Daemon authentication still pending. Complete the browser/device flow and rerun `psgit login`.')
  if (finalStatus.reason) {
    console.log(`Reason: ${finalStatus.reason}`)
  }
  if (loginResult.challenge) {
    explainChallenge('Pending device challenge:', {
      challengeId: loginResult.challenge.challengeId,
      verificationUrl: loginResult.challenge.verificationUrl ?? null,
      expiresAt: loginResult.challenge.expiresAt ?? null,
    })
  } else {
    explainChallenge('Pending device challenge:')
  }
  process.exit(1)
}

async function runLogoutCommand(args: LogoutCommandArgs) {
  await logoutSession({ sessionPath: args.session, daemonUrl: args.daemonUrl })
  console.log('✅ Cleared stored PowerSync credentials.')
}

async function runDaemonStopCommand(args: DaemonStopCommandArgs) {
  const defaultDaemonUrl =
    process.env.POWERSYNC_DAEMON_URL ?? process.env.POWERSYNC_DAEMON_ENDPOINT ?? 'http://127.0.0.1:5030'
  const baseUrl = normalizeDaemonBaseUrl(args.daemonUrl ?? defaultDaemonUrl)
  const responsive = await isDaemonResponsiveLocal(baseUrl)
  if (!responsive) {
    if (!args.quiet) {
      console.log(`[psgit] PowerSync daemon not running at ${baseUrl}.`)
    }
    return
  }

  const waitMs = Number.isFinite(args.waitMs) && args.waitMs !== undefined ? Math.max(0, Number(args.waitMs)) : 5000
  if (!args.quiet) {
    console.log(`[psgit] Sending shutdown request to daemon at ${baseUrl}...`)
  }

  try {
    const response = await fetch(`${baseUrl}/shutdown`, { method: 'POST' })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`shutdown endpoint returned ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`[psgit] Failed to request daemon shutdown: ${message}`)
  }

  if (!args.quiet) {
    console.log('[psgit] Waiting for daemon to exit...')
  }

  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    await delay(200)
    if (!(await isDaemonResponsiveLocal(baseUrl))) {
      if (!args.quiet) {
        console.log('✅ PowerSync daemon stopped.')
      }
      return
    }
  }

  console.warn('[psgit] Daemon shutdown timed out; process may still be terminating.')
  if (process.exitCode == null || process.exitCode === 0) {
    process.exitCode = 1
  }
}

function printUsage() {
  console.log('psgit commands:')
  console.log('  psgit remote add powersync powersync::https://<endpoint>/orgs/<org>/repos/<repo>')
  console.log('  psgit sync [--remote <name>]')
  console.log('  psgit demo-seed [--remote-url <url>] [--remote <name>] [--branch <branch>] [--skip-sync] [--keep-repo] [--template-url <url>] [--no-template]')
  console.log('  psgit login [--guest] [--manual --token <jwt>] [--endpoint <url>] [--daemon-url <url>]')
  console.log('  psgit daemon stop [--daemon-url <url>] [--wait <ms>]')
  console.log('  psgit logout [--daemon-url <url>]')
  console.log('  psgit profile list|show|set|use …')
}

function buildCli() {
  const defaultRemote = process.env.REMOTE_NAME ?? 'origin'

  return yargs(hideBin(process.argv))
    .scriptName('psgit')
    .usage(
      'psgit commands:\n' +
        '  psgit remote add powersync powersync::https://<endpoint>/orgs/<org>/repos/<repo>\n' +
        '  psgit sync [--remote <name>]\n' +
        '  psgit demo-seed [--remote-url <url>] [--remote <name>] [--branch <branch>] [--skip-sync] [--keep-repo] [--template-url <url>] [--no-template]\n' +
        '  psgit login [--guest] [--manual --token <jwt>] [--endpoint <url>] [--daemon-url <url>]\n' +
        '  psgit daemon stop [--daemon-url <url>] [--wait <ms>]\n' +
        '  psgit logout [--daemon-url <url>]',
    )
    .option('stack-env', {
      type: 'string',
      describe: 'Path to additional stack env exports (optional).',
      global: true,
    })
    .option('no-stack-env', {
      type: 'boolean',
      describe: 'Disable automatic stack env loading.',
      global: true,
      default: false,
    })
    .middleware((argv) => {
      if (argv.noStackEnv) {
        return
      }
      const explicitPath =
        typeof argv.stackEnv === 'string'
          ? argv.stackEnv
          : activeProfileContext.stackEnvPath ?? undefined
      maybeApplyStackEnv({
        explicitPath,
        silent: Boolean(explicitPath && explicitPath === activeProfileContext.stackEnvPath),
        allowMissing: !explicitPath || explicitPath === activeProfileContext.stackEnvPath,
        includeDefault: !explicitPath && activeProfileContext.stackEnvPath != null,
      })
    }, true)
    .command(
      'profile <action>',
      'Manage psgit environment profiles',
      (profileYargs) =>
        profileYargs
          .command(
            'list',
            'List available profiles',
            (y) =>
              y.option('json', {
                type: 'boolean',
                describe: 'Output JSON instead of human-readable text.',
                default: false,
              }),
            (argv) => {
              const items = listProfiles()
              if (argv.json) {
                console.log(
                  JSON.stringify(
                    {
                      active: activeProfileContext.name,
                      profiles: items,
                    },
                    null,
                    2,
                  ),
                )
                return
              }
              if (items.length === 0) {
                console.log('No profiles defined.')
                return
              }
              for (const entry of items) {
                const marker = entry.name === activeProfileContext.name ? '*' : ' '
                console.log(`${marker} ${entry.name}`)
              }
            },
          )
          .command(
            'show <name>',
            'Show profile configuration',
            (y) =>
              y
                .positional('name', {
                  type: 'string',
                  describe: 'Profile name',
                })
                .option('json', {
                  type: 'boolean',
                  describe: 'Output JSON (default).',
                  default: true,
                }),
            (argv) => {
              const name = argv.name as string
              const profile = getProfile(name)
              if (!profile) {
                console.error(`Profile "${name}" not found.`)
                process.exitCode = 1
                return
              }
              if (argv.json !== false) {
                console.log(JSON.stringify(profile, null, 2))
              } else {
                console.log(profile)
              }
            },
          )
          .command(
            'set <name>',
            'Create or update a profile',
            (y) =>
              y
                .positional('name', {
                  type: 'string',
                  describe: 'Profile name',
                })
                .option('set', {
                  type: 'string',
                  array: true,
                  describe: 'Set key=value pairs (dot notation, e.g. powersync.url=https://example).',
                })
                .option('unset', {
                  type: 'string',
                  array: true,
                  describe: 'Unset nested values (dot notation).',
                  default: [],
                })
                .option('stack-env-path', {
                  type: 'string',
                  describe: 'Set stack env file path (relative or absolute).',
                })
                .option('clear-stack-env', {
                  type: 'boolean',
                  describe: 'Remove stack env path from the profile.',
                  default: false,
                })
                .option('json', {
                  type: 'boolean',
                  describe: 'Print updated profile as JSON.',
                  default: false,
                }),
            (argv) => {
              const name = argv.name as string
              const setArgs = Array.isArray(argv.set) ? (argv.set as string[]) : []
              const unsetArgs = Array.isArray(argv.unset) ? (argv.unset as string[]) : []
              const stackEnvPathArg =
                typeof argv.stackEnvPath === 'string' ? (argv.stackEnvPath as string) : undefined
              const clearStackEnv = Boolean(argv.clearStackEnv)

              if (stackEnvPathArg && clearStackEnv) {
                console.error('Use either --stack-env or --clear-stack-env, not both.')
                process.exitCode = 1
                return
              }

              if (
                setArgs.length === 0 &&
                unsetArgs.length === 0 &&
                !stackEnvPathArg &&
                !clearStackEnv
              ) {
                console.error(
                  'No changes specified. Use --set, --unset, --stack-env, or --clear-stack-env.',
                )
                process.exitCode = 1
                return
              }

              const existing = getProfile(name)
              const working: ProfileConfig = existing
                ? (JSON.parse(JSON.stringify(existing)) as ProfileConfig)
                : {}
              const mutable = working as unknown as Record<string, unknown>
              let mutated = false

              for (const entry of setArgs) {
                const eqIndex = entry.indexOf('=')
                if (eqIndex === -1) {
                  console.error(`Invalid --set entry "${entry}". Use key=value syntax.`)
                  process.exitCode = 1
                  return
                }
                const rawKey = entry.slice(0, eqIndex).trim()
                const rawValue = entry.slice(eqIndex + 1)
                try {
                  const path = parseKeyPath(rawKey)
                  setConfigValue(mutable, path, rawValue)
                } catch (error) {
                  console.error(error instanceof Error ? error.message : String(error))
                  process.exitCode = 1
                  return
                }
                mutated = true
              }

              for (const rawKey of unsetArgs) {
                try {
                  const path = parseKeyPath(rawKey)
                  unsetConfigValue(mutable, path)
                } catch (error) {
                  console.error(error instanceof Error ? error.message : String(error))
                  process.exitCode = 1
                  return
                }
                mutated = true
              }

              if (stackEnvPathArg) {
                working.stackEnvPath = stackEnvPathArg
                mutated = true
              } else if (clearStackEnv) {
                if (working.stackEnvPath) {
                  delete working.stackEnvPath
                  mutated = true
                }
              }

              if (!mutated) {
                console.log('No changes applied.')
                return
              }

              saveProfile(name, working)
              console.log(`Profile "${name}" updated.`)
              if (argv.json) {
                console.log(JSON.stringify(working, null, 2))
              }
            },
          )
          .command(
            'use <name>',
            'Switch active profile (takes effect on next command)',
            (y) =>
              y.positional('name', {
                type: 'string',
                describe: 'Profile name',
              }),
            (argv) => {
              const name = argv.name as string
              try {
                setActiveProfile(name)
              } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                console.error(message)
                process.exitCode = 1
                return
              }
              console.log(`Active profile set to "${name}". Run your next command to use the new environment.`)
            },
          )
          .demandCommand(1, 'Specify a profile subcommand.')
          .strict(),
    )
    .command(
      'remote add powersync <url>',
      'Add or update a PowerSync remote',
      (y) =>
        y
          .positional('url', {
            type: 'string',
            describe: 'PowerSync remote URL (powersync::https://…)',
          })
          .option('remote', {
            alias: 'r',
            type: 'string',
            describe: 'Git remote name',
            default: defaultRemote,
          }),
      async (argv) => {
        await runRemoteAddCommand({ url: argv.url as string, remote: (argv.remote as string) ?? defaultRemote })
      },
    )
    .command(
      'sync',
      'Synchronise the local repository snapshot',
      (y) =>
        y.option('remote', {
          alias: 'r',
          type: 'string',
          describe: 'Git remote name',
          default: defaultRemote,
        }),
      async (argv) => {
        await runSyncCommand({ remote: (argv.remote as string) ?? defaultRemote })
      },
    )
    .command(
      'demo-seed',
      'Seed a demo repository via the PowerSync remote helper',
      (y) =>
        y
          .option('remote-url', {
            alias: 'url',
            type: 'string',
            describe: 'PowerSync remote URL override',
          })
          .option('remote', {
            alias: 'r',
            type: 'string',
            describe: 'Git remote name override',
          })
          .option('branch', {
            type: 'string',
            describe: 'Branch to push (default main)',
          })
          .option('skip-sync', {
            type: 'boolean',
            describe: 'Skip the follow-up PowerSync sync after pushing',
            default: false,
          })
          .option('keep-repo', {
            type: 'boolean',
            describe: 'Keep the temporary Git repository on disk',
            default: false,
          })
          .option('repo-dir', {
            type: 'string',
            describe: 'Explicit working directory (implies --keep-repo)',
          })
          .option('template-url', {
            type: 'string',
            describe: 'Git URL to clone as demo seed content (defaults to the PowerSync chat example)',
          })
          .option('no-template', {
            type: 'boolean',
            describe: 'Skip cloning the default template and generate a minimal sample repository instead',
            default: false,
          }),
      async (argv) => {
        await runDemoSeedCommand({
          remoteUrl: (argv['remote-url'] as string | undefined) ?? (argv.url as string | undefined) ?? null,
          remoteName: (argv.remote as string | undefined) ?? null,
          branch: (argv.branch as string | undefined) ?? null,
          skipSync: argv['skip-sync'] as boolean | undefined,
          keepRepo: argv['keep-repo'] as boolean | undefined,
          repoDir: (argv['repo-dir'] as string | undefined) ?? null,
          templateRepoUrl: argv['no-template'] ? null : ((argv['template-url'] as string | undefined) ?? undefined),
        })
      },
    )
    .command(
      'login',
      'Authenticate the PowerSync daemon',
      (y) =>
        y
          .option('manual', {
            type: 'boolean',
            describe: 'Provide an explicit PowerSync token',
          })
          .option('guest', {
            type: 'boolean',
            describe: 'Join as a guest user (anonymous token)',
          })
          .option('auto', {
            type: 'boolean',
            describe: 'Force device/browser flow (default)',
          })
          .option('token', {
            type: 'string',
            describe: 'PowerSync JWT',
          })
          .option('endpoint', {
            type: 'string',
            describe: 'PowerSync endpoint override',
          })
          .option('session', {
            type: 'string',
            describe: 'Legacy credential cache path',
          })
          .option('daemon-url', {
            type: 'string',
            describe: 'PowerSync daemon base URL',
          })
          .option('supabase-email', {
            type: 'string',
            describe: 'Supabase email (deprecated)',
          })
          .option('supabase-password', {
            type: 'string',
            describe: 'Supabase password (deprecated)',
          })
          .option('supabase-url', {
            type: 'string',
            describe: 'Supabase URL (deprecated)',
          })
          .option('supabase-anon-key', {
            type: 'string',
            describe: 'Supabase anon key (deprecated)',
          }),
      async (argv) => {
        await runLoginCommand({
          manual: argv.manual as boolean | undefined,
          guest: argv.guest as boolean | undefined,
          auto: argv.auto as boolean | undefined,
          token: argv.token as string | undefined,
          endpoint: argv.endpoint as string | undefined,
          session: argv.session as string | undefined,
          daemonUrl: argv['daemon-url'] as string | undefined,
          supabaseEmail: argv['supabase-email'] as string | undefined,
          supabasePassword: argv['supabase-password'] as string | undefined,
          supabaseUrl: argv['supabase-url'] as string | undefined,
          supabaseAnonKey: argv['supabase-anon-key'] as string | undefined,
        })
      },
    )
    .command(
      ['daemon stop', 'daemon-stop'],
      'Request the running PowerSync daemon to shut down',
      (y) =>
        y
          .option('daemon-url', {
            type: 'string',
            describe: 'PowerSync daemon base URL',
          })
          .option('wait', {
            type: 'number',
            describe: 'Milliseconds to wait for shutdown (default 5000).',
          })
          .option('quiet', {
            type: 'boolean',
            describe: 'Suppress informational output.',
            default: false,
          }),
      async (argv) => {
        await runDaemonStopCommand({
          daemonUrl: argv['daemon-url'] as string | undefined,
          waitMs: argv.wait as number | undefined,
          quiet: argv.quiet as boolean | undefined,
        })
      },
    )
    .command(
      'logout',
      'Clear cached PowerSync credentials',
      (y) =>
        y
          .option('session', {
            type: 'string',
            describe: 'Legacy credential cache path',
          })
          .option('daemon-url', {
            type: 'string',
            describe: 'PowerSync daemon base URL',
          }),
      async (argv) => {
        await runLogoutCommand({
          session: argv.session as string | undefined,
          daemonUrl: argv['daemon-url'] as string | undefined,
        })
      },
    )
    .command(
      '$0',
      false,
      () => {},
      () => {
        printUsage()
        process.exit(0)
      },
    )
    .strict()
    .wrap(null)
    .showHelpOnFail(false)
    .help('help')
    .alias('h', 'help')
    .version(false)
    .fail((msg, err) => {
      if (err) throw err
      if (msg) {
        console.error(msg)
      }
      printUsage()
      process.exit(2)
    })
}

async function main() {
  await buildCli().parseAsync()
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
