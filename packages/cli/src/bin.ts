#!/usr/bin/env node
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { addPowerSyncRemote, syncPowerSyncRepository, seedDemoRepository } from './index.js'
import { loginWithDaemonDevice, logout as logoutSession } from './auth/login.js'
import {
  completeDaemonDeviceLogin,
  extractDeviceChallenge,
  fetchDaemonAuthStatus,
  postDaemonAuthDevice,
  resolveDaemonBaseUrl,
} from './auth/daemon-client.js'
import {
  resolveProfile,
  listProfiles,
  getProfile,
  setActiveProfile,
  saveProfile,
  buildEnvFromProfile,
  type ProfileConfig,
  type ResolvedProfile,
} from '@powersync-community/powergit-core/profile-manager'
import { createSupabaseFileStorage } from '@powersync-community/powergit-core'
import { loadStackEnv } from '@powersync-community/powergit-core/stack-env'
import { resolveSupabaseSessionPath } from './auth/session.js'

const CLI_NAME = 'powergit'
const LOG_PREFIX = `[${CLI_NAME}]`

interface LoginCommandArgs {
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

const POWERGIT_STACK_ENV = process.env.POWERGIT_STACK_ENV
const STACK_ENV_DISABLED = (process.env.POWERGIT_NO_STACK_ENV ?? '').toLowerCase() === 'true'
const appliedStackEnvPaths = new Set<string>()
const stackProfileOverride = process.env.STACK_PROFILE
const activeProfileContext: ResolvedProfile = resolveProfile({
  name: stackProfileOverride ?? null,
  updateState: !stackProfileOverride,
  strict: Boolean(stackProfileOverride),
})

process.env.STACK_PROFILE = activeProfileContext.name
process.env.POWERGIT_ACTIVE_PROFILE = activeProfileContext.name
for (const [key, value] of Object.entries(activeProfileContext.env)) {
  if (typeof value !== 'string') continue
  process.env[key] = value
}

if (stackProfileOverride) {
  console.info(`${LOG_PREFIX} Using profile "${activeProfileContext.name}" (via STACK_PROFILE)`)
} else if (activeProfileContext.name !== 'prod' || activeProfileContext.source === 'file') {
  console.info(`${LOG_PREFIX} Using profile "${activeProfileContext.name}"`)
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
    console.info(`${LOG_PREFIX} Loaded stack environment from ${resolvedPath}`)
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
  } else if (POWERGIT_STACK_ENV) {
    candidates.push({ path: POWERGIT_STACK_ENV, silent, allowMissing: false })
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

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
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

function persistDaemonCredentials(
  _token: string,
  _expiresAt: string | null | undefined,
  context: unknown,
) {
  const profileName = activeProfileContext.name
  const existing = getProfile(profileName)
  const working: ProfileConfig = existing
    ? (JSON.parse(JSON.stringify(existing)) as ProfileConfig)
    : {}
  const powersyncConfig = { ...(working.powersync ?? {}) }
  const daemonConfig = { ...(working.daemon ?? {}) }
  delete daemonConfig.token
  delete daemonConfig.tokenExpiresAt
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

function createSupabaseAuthedClient(options: { sessionPath?: string } = {}): SupabaseClient {
  const supabaseUrl = firstNonEmpty(process.env.SUPABASE_URL, process.env.POWERGIT_TEST_SUPABASE_URL)
  const supabaseAnonKey = firstNonEmpty(process.env.SUPABASE_ANON_KEY, process.env.POWERGIT_TEST_SUPABASE_ANON_KEY)
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('Supabase is not configured. Ensure the active profile defines SUPABASE_URL and SUPABASE_ANON_KEY.')
  }
  const storagePath = resolveSupabaseSessionPath(options.sessionPath)
  const storage = createSupabaseFileStorage(storagePath)
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage,
      storageKey: 'powergit',
    },
  })
}

async function requireSupabaseLogin(client: SupabaseClient): Promise<void> {
  const { data, error } = await client.auth.getSession()
  if (error) {
    throw new Error(`Failed to read Supabase session: ${error.message}`)
  }
  if (!data.session) {
    throw new Error('Not logged in. Run `powergit login` first.')
  }
}

function resolveDefaultRemoteName(): string {
  return process.env.REMOTE_NAME ?? 'powersync'
}

async function runRemoteAddCommand(args: { url: string; remote?: string | null }) {
  const remoteName = args.remote ?? resolveDefaultRemoteName()
  await addPowerSyncRemote(process.cwd(), remoteName, args.url)
  console.log(`Added PowerSync remote (${remoteName}): ${args.url}`)
}

async function runSyncCommand(args: { remote?: string | null }) {
  const remoteName = args.remote ?? resolveDefaultRemoteName()
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
  const wantsSupabasePasswordLogin =
    hasText(args.supabaseEmail) ||
    hasText(args.supabasePassword) ||
    hasText(args.supabaseUrl) ||
    hasText(args.supabaseAnonKey)

  if (args.session && !wantsSupabasePasswordLogin) {
    console.warn(`${LOG_PREFIX} Ignoring legacy --session option; Supabase session persistence is automatic.`)
  }

  if (wantsSupabasePasswordLogin) {
    const daemonBaseUrl = await resolveDaemonBaseUrl({ daemonUrl: args.daemonUrl })
    const status = await fetchDaemonAuthStatus(daemonBaseUrl)

    if (status?.status === 'ready') {
      persistDaemonCredentials('', status.expiresAt ?? null, status.context ?? null)
      console.log('✅ PowerSync daemon already authenticated via Supabase.')
      if (status.expiresAt) {
        console.log(`   Expires: ${status.expiresAt}`)
      }
      return
    }

    const supabaseUrl = firstNonEmpty(
      args.supabaseUrl,
      process.env.SUPABASE_URL,
      process.env.POWERGIT_TEST_SUPABASE_URL,
    )
    const supabaseAnonKey = firstNonEmpty(
      args.supabaseAnonKey,
      process.env.SUPABASE_ANON_KEY,
      process.env.POWERGIT_TEST_SUPABASE_ANON_KEY,
    )
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Supabase URL and anon key are required. Configure SUPABASE_URL and SUPABASE_ANON_KEY.')
    }

    const email = firstNonEmpty(args.supabaseEmail, process.env.SUPABASE_EMAIL, process.env.POWERGIT_TEST_SUPABASE_EMAIL)
    const password = firstNonEmpty(
      args.supabasePassword,
      process.env.SUPABASE_PASSWORD,
      process.env.POWERGIT_TEST_SUPABASE_PASSWORD,
    )
    if (!email || !password) {
      throw new Error('Supabase email and password are required. Use --supabase-email/--supabase-password.')
    }

    const authStoragePath = resolveSupabaseSessionPath(args.session)
    const supabaseStorage = createSupabaseFileStorage(authStoragePath)
    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        storage: supabaseStorage,
        storageKey: 'powergit',
      },
    })

    const { data, error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) {
      throw new Error(`Supabase login failed (${error.name ?? 'AuthError'}): ${error.message}`)
    }
    const session = data?.session ?? (await supabase.auth.getSession()).data.session
    const accessToken = session?.access_token?.trim?.() ?? ''
    const refreshToken = session?.refresh_token?.trim?.() ?? ''
    if (!accessToken || !refreshToken) {
      throw new Error('Supabase login response did not include an access_token and refresh_token.')
    }

    const existingChallenge = extractDeviceChallenge(status)?.challengeId ?? null
    const pendingStatus = existingChallenge
      ? status
      : await postDaemonAuthDevice(daemonBaseUrl, {
          endpoint: args.endpoint,
        })
    if (pendingStatus?.status === 'ready') {
      persistDaemonCredentials('', pendingStatus.expiresAt ?? null, pendingStatus.context ?? null)
      console.log('✅ PowerSync daemon authenticated via Supabase.')
      if (pendingStatus.expiresAt) {
        console.log(`   Expires: ${pendingStatus.expiresAt}`)
      }
      return
    }
    const challengeId = existingChallenge ?? extractDeviceChallenge(pendingStatus)?.challengeId ?? null
    if (!challengeId) {
      throw new Error('Daemon did not provide a device code for login.')
    }

    const final = await completeDaemonDeviceLogin(daemonBaseUrl, {
      challengeId,
      endpoint: args.endpoint ?? null,
      session: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: session?.expires_in ?? null,
        expires_at: session?.expires_at ?? null,
      },
      metadata: null,
    })

    if (!final || final.status !== 'ready') {
      const refreshed = await fetchDaemonAuthStatus(daemonBaseUrl)
      const resolved = refreshed ?? final
      if (resolved?.status === 'ready') {
        persistDaemonCredentials('', resolved.expiresAt ?? null, resolved.context ?? null)
        console.log('✅ PowerSync daemon authenticated via Supabase.')
        if (resolved.expiresAt) {
          console.log(`   Expires: ${resolved.expiresAt}`)
        }
        return
      }
      const reason = resolved?.reason ? ` (${resolved.reason})` : ''
      throw new Error(`Daemon login did not complete successfully${reason}.`)
    }

    persistDaemonCredentials('', final.expiresAt ?? null, final.context ?? null)
    console.log('✅ PowerSync daemon authenticated via Supabase.')
    if (final.expiresAt) {
      console.log(`   Expires: ${final.expiresAt}`)
    }
    return
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
    const openUrl = (() => {
      if (challenge.verificationUrl) {
        return challenge.verificationUrl
      }
      const fallbackUrl = process.env.POWERSYNC_DAEMON_DEVICE_URL ?? process.env.POWERSYNC_EXPLORER_URL
      if (!fallbackUrl) return null
      const separator = fallbackUrl.includes('?') ? '&' : '?'
      return `${fallbackUrl}${separator}device_code=${challenge.challengeId}`
    })()
    if (openUrl) {
      console.log('   Open:')
      console.log(`   ${openUrl}`)
    } else {
      console.log('   No device login URL configured.')
      console.log('   Set daemon.deviceLoginUrl in your profile or export POWERSYNC_DAEMON_DEVICE_URL.')
    }
    console.log('   If the page can’t reach your local daemon (e.g. net::ERR_BLOCKED_BY_CLIENT), try incognito or disable ad blockers/privacy shields.')
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
      if (!challengeId) {
        return
      }
      const verificationUrl = typeof context.verificationUrl === 'string' ? context.verificationUrl : null
      const expiresAt = typeof context.expiresAt === 'string' ? context.expiresAt : null
      observedChallenge = { challengeId, verificationUrl, expiresAt }
      if (!printedPendingPrompt) {
        console.log('Daemon requested interactive login.')
        explainChallenge('To finish authentication:', observedChallenge)
        console.log('Waiting for daemon authentication to complete...')
        printedPendingPrompt = true
      }
    },
  })

  const initialStatus = loginResult.initialStatus
  if (initialStatus?.status === 'pending' && loginResult.challenge?.challengeId && !printedPendingPrompt) {
    console.log('Daemon requested interactive login.')
    explainChallenge('To finish authentication:', {
      challengeId: loginResult.challenge.challengeId,
      verificationUrl: loginResult.challenge.verificationUrl ?? null,
      expiresAt: loginResult.challenge.expiresAt ?? null,
    })
    console.log('Waiting for daemon authentication to complete...')
    printedPendingPrompt = true
  }

  const finalStatus = loginResult.finalStatus
  if (!finalStatus) {
    throw new Error('Daemon did not provide an auth status. Check daemon logs for details.')
  }

  if (finalStatus.status === 'ready') {
    persistDaemonCredentials('', finalStatus.expiresAt ?? null, finalStatus.context ?? null)
    console.log('✅ PowerSync daemon authenticated via Supabase.')
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

  console.log(`Daemon authentication still pending. Complete the browser/device flow and rerun \`${CLI_NAME} login\`.`)
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
  const defaultDaemonUrl = process.env.POWERSYNC_DAEMON_URL ?? 'http://127.0.0.1:5030'
  const baseUrl = normalizeDaemonBaseUrl(args.daemonUrl ?? defaultDaemonUrl)
  const responsive = await isDaemonResponsiveLocal(baseUrl)
  if (!responsive) {
    if (!args.quiet) {
      console.log(`${LOG_PREFIX} PowerSync daemon not running at ${baseUrl}.`)
    }
    return
  }

  const waitMs = Number.isFinite(args.waitMs) && args.waitMs !== undefined ? Math.max(0, Number(args.waitMs)) : 5000
  if (!args.quiet) {
    console.log(`${LOG_PREFIX} Sending shutdown request to daemon at ${baseUrl}...`)
  }

  try {
    const response = await fetch(`${baseUrl}/shutdown`, { method: 'POST' })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(`shutdown endpoint returned ${response.status} ${response.statusText}${text ? `: ${text}` : ''}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${LOG_PREFIX} Failed to request daemon shutdown: ${message}`)
  }

  if (!args.quiet) {
    console.log(`${LOG_PREFIX} Waiting for daemon to exit...`)
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

  console.warn(`${LOG_PREFIX} Daemon shutdown timed out; process may still be terminating.`)
  if (process.exitCode == null || process.exitCode === 0) {
    process.exitCode = 1
  }
}

function printUsage() {
  console.log(`${CLI_NAME} commands:`)
  console.log(`  ${CLI_NAME} remote add powersync powergit::/<org>/<repo>`)
  console.log(`  ${CLI_NAME} sync [--remote <name>]`)
  console.log(`  ${CLI_NAME} org list|create|members|add-member|remove-member …`)
  console.log(
    `  ${CLI_NAME} demo-seed [--remote-url <url>] [--remote <name>] [--branch <branch>] [--skip-sync] [--keep-repo] [--template-url <url>] [--no-template]`,
  )
  console.log(`  ${CLI_NAME} login [--endpoint <url>] [--daemon-url <url>] [--supabase-email <email>] [--supabase-password <password>]`)
  console.log(`  ${CLI_NAME} daemon stop [--daemon-url <url>] [--wait <ms>]`)
  console.log(`  ${CLI_NAME} logout [--daemon-url <url>]`)
  console.log(`  ${CLI_NAME} profile list|show|set|use …`)
}

function buildCli() {
  const defaultRemote = resolveDefaultRemoteName()

  return yargs(hideBin(process.argv))
    .scriptName(CLI_NAME)
    .usage(
      `${CLI_NAME} commands:\n` +
        `  ${CLI_NAME} remote add powersync powergit::/<org>/<repo>\n` +
        `  ${CLI_NAME} sync [--remote <name>]\n` +
        `  ${CLI_NAME} org list|create|members …\n` +
        `  ${CLI_NAME} demo-seed [--remote-url <url>] [--remote <name>] [--branch <branch>] [--skip-sync] [--keep-repo] [--template-url <url>] [--no-template]\n` +
        `  ${CLI_NAME} login [--endpoint <url>] [--daemon-url <url>] [--supabase-email <email>] [--supabase-password <password>]\n` +
        `  ${CLI_NAME} daemon stop [--daemon-url <url>] [--wait <ms>]\n` +
        `  ${CLI_NAME} logout [--daemon-url <url>]\n`,
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
      'Manage Powergit environment profiles',
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
      'org <action>',
      'Manage orgs and memberships',
      (orgYargs) =>
        orgYargs
          .option('session', {
            type: 'string',
            describe: 'Override daemon session path (advanced).',
          })
          .command(
            'list',
            'List org memberships',
            (y) =>
              y.option('json', {
                type: 'boolean',
                describe: 'Output JSON instead of human-readable text.',
                default: false,
              }),
            async (argv) => {
              const client = createSupabaseAuthedClient({ sessionPath: argv.session as string | undefined })
              await requireSupabaseLogin(client)
              const { data, error } = await client.rpc('powergit_list_my_orgs')
              if (error) {
                throw new Error(error.message)
              }
              const rows = Array.isArray(data) ? (data as Array<{ org_id?: string; role?: string; name?: string | null }>) : []
              if (argv.json) {
                console.log(JSON.stringify(rows, null, 2))
                return
              }
              if (rows.length === 0) {
                console.log('No org memberships found.')
                return
              }
              for (const row of rows) {
                const orgId = row.org_id ?? ''
                const role = row.role ?? 'read'
                const label = row.name ? ` (${row.name})` : ''
                console.log(`${orgId}\t${role}${label}`)
              }
            },
          )
          .command(
            'create <orgId>',
            'Create a new org (you become admin)',
            (y) =>
              y
                .positional('orgId', { type: 'string', describe: 'Org id (slug)', demandOption: true })
                .option('name', { type: 'string', describe: 'Display name (optional)' })
                .option('json', { type: 'boolean', describe: 'Output JSON.', default: false }),
            async (argv) => {
              const client = createSupabaseAuthedClient({ sessionPath: argv.session as string | undefined })
              await requireSupabaseLogin(client)
              const orgId = (argv.orgId as string).trim()
              const displayName = typeof argv.name === 'string' ? argv.name.trim() : ''
              const { data, error } = await client.rpc('powergit_create_org', {
                org_id: orgId,
                name: displayName || null,
              })
              if (error) {
                throw new Error(error.message)
              }
              if (argv.json) {
                console.log(JSON.stringify(data, null, 2))
                return
              }
              console.log(`Created org "${orgId}".`)
            },
          )
          .command(
            'members <orgId>',
            'List org members',
            (y) =>
              y
                .positional('orgId', { type: 'string', describe: 'Org id', demandOption: true })
                .option('json', { type: 'boolean', describe: 'Output JSON.', default: false }),
            async (argv) => {
              const client = createSupabaseAuthedClient({ sessionPath: argv.session as string | undefined })
              await requireSupabaseLogin(client)
              const orgId = (argv.orgId as string).trim()
              const { data, error } = await client.rpc('powergit_list_org_members', { target_org_id: orgId })
              if (error) {
                throw new Error(error.message)
              }
              const rows = Array.isArray(data)
                ? (data as Array<{ email?: string | null; user_id?: string; role?: string }>)
                : []
              if (argv.json) {
                console.log(JSON.stringify(rows, null, 2))
                return
              }
              if (rows.length === 0) {
                console.log('No members found.')
                return
              }
              for (const row of rows) {
                console.log(`${row.email ?? row.user_id ?? '<unknown>'}\t${row.role ?? 'read'}`)
              }
            },
          )
          .command(
            'add-member <orgId> <email>',
            'Add an org member (admin only)',
            (y) =>
              y
                .positional('orgId', { type: 'string', describe: 'Org id', demandOption: true })
                .positional('email', { type: 'string', describe: 'User email', demandOption: true })
                .option('role', { type: 'string', describe: 'Role: admin|write|read', default: 'read' }),
            async (argv) => {
              const client = createSupabaseAuthedClient({ sessionPath: argv.session as string | undefined })
              await requireSupabaseLogin(client)
              const orgId = (argv.orgId as string).trim()
              const email = (argv.email as string).trim()
              const role = typeof argv.role === 'string' ? argv.role.trim() : 'read'
              const { data, error } = await client.rpc('powergit_add_org_member', {
                target_org_id: orgId,
                target_email: email,
                target_role: role,
              })
              if (error) {
                throw new Error(error.message)
              }
              console.log(JSON.stringify(data, null, 2))
            },
          )
          .command(
            'remove-member <orgId> <emailOrUserId>',
            'Remove an org member (admin only)',
            (y) =>
              y
                .positional('orgId', { type: 'string', describe: 'Org id', demandOption: true })
                .positional('emailOrUserId', { type: 'string', describe: 'User email or UUID', demandOption: true }),
            async (argv) => {
              const client = createSupabaseAuthedClient({ sessionPath: argv.session as string | undefined })
              await requireSupabaseLogin(client)
              const orgId = (argv.orgId as string).trim()
              const target = (argv.emailOrUserId as string).trim()
              const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)
              let userId = target
              if (!isUuid) {
                const { data, error } = await client.rpc('powergit_list_org_members', { target_org_id: orgId })
                if (error) {
                  throw new Error(error.message)
                }
                const rows = Array.isArray(data)
                  ? (data as Array<{ email?: string | null; user_id?: string }>)
                  : []
                const match = rows.find((row) => (row.email ?? '').toLowerCase() === target.toLowerCase())
                if (!match?.user_id) {
                  throw new Error(`No member found for "${target}".`)
                }
                userId = match.user_id
              }
              const { data, error: removeError } = await client.rpc('powergit_remove_org_member', {
                target_org_id: orgId,
                target_user_id: userId,
              })
              if (removeError) {
                throw new Error(removeError.message)
              }
              if (data !== true) {
                throw new Error('Member removal was not acknowledged.')
              }
              console.log('Removed.')
            },
          )
          .demandCommand(1, 'Specify an org subcommand.')
          .strict(),
    )
    .command(
      'remote add powersync <url>',
      'Add or update a PowerSync remote',
      (y) =>
        y
          .positional('url', {
            type: 'string',
            describe: 'Powergit remote URL (powergit::/org/repo or powergit::<profile>/org/repo)',
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
          .option('endpoint', {
            type: 'string',
            describe: 'PowerSync endpoint override',
          })
          .option('session', {
            type: 'string',
            describe: 'Legacy credential cache path',
          })
          .option('supabase-email', {
            type: 'string',
            describe: 'Supabase login email (non-interactive).',
          })
          .option('supabase-password', {
            type: 'string',
            describe: 'Supabase login password (non-interactive).',
          })
          .option('supabase-url', {
            type: 'string',
            describe: 'Supabase URL override for password login (optional).',
          })
          .option('supabase-anon-key', {
            type: 'string',
            describe: 'Supabase anon key override for password login (optional).',
          })
          .option('daemon-url', {
            type: 'string',
            describe: 'PowerSync daemon base URL',
          }),
      async (argv) => {
        await runLoginCommand({
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
