#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { addPowerSyncRemote, syncPowerSyncRepository, seedDemoRepository } from './index.js'
import {
  loginWithDaemonDevice,
  loginWithDaemonGuest,
  loginWithSupabasePassword,
  logout as logoutSession,
} from './auth/login.js'

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

const DEFAULT_STACK_ENV_PATH = '.env.powersync-stack'
const PSGIT_STACK_ENV = process.env.PSGIT_STACK_ENV
const STACK_ENV_DISABLED = (process.env.PSGIT_NO_STACK_ENV ?? '').toLowerCase() === 'true'
const appliedStackEnvPaths = new Set<string>()

function parseEnvValue(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function findStackEnvPath(path: string): string | null {
  if (isAbsolute(path)) {
    return existsSync(path) ? path : null
  }
  let current = process.cwd()
  const visited = new Set<string>()
  while (!visited.has(current)) {
    visited.add(current)
    const candidate = resolve(current, path)
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return null
}

function applyStackEnv(path: string, { silent = false }: { silent?: boolean } = {}): boolean {
  const resolvedPath = findStackEnvPath(path)
  if (!resolvedPath) {
    return false
  }

  if (appliedStackEnvPaths.has(resolvedPath)) {
    return true
  }

  const raw = readFileSync(resolvedPath, 'utf8')
  const lines = raw.split(/\r?\n/).map((line) => line.trim())
  for (const line of lines) {
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line)
    if (!match) continue
    const [, key, value] = match
    process.env[key] = parseEnvValue(value)
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
}: {
  explicitPath?: string
  silent?: boolean
  allowMissing?: boolean
} = {}) {
  if (STACK_ENV_DISABLED) return

  const candidates: Array<{ path: string; silent: boolean; allowMissing: boolean }> = []
  if (explicitPath) {
    candidates.push({ path: explicitPath, silent: false, allowMissing: false })
  } else if (PSGIT_STACK_ENV) {
    candidates.push({ path: PSGIT_STACK_ENV, silent, allowMissing: false })
  }
  candidates.push({ path: DEFAULT_STACK_ENV_PATH, silent, allowMissing })

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

  const envToken = inferGuestTokenFromEnv()
  if (envToken) {
    return {
      token: envToken.token,
      endpoint: args.endpoint,
      source: 'env',
      metadata: { source: envToken.source },
    }
  }

  const supabaseUrl = firstNonEmpty(args.supabaseUrl, process.env.POWERSYNC_SUPABASE_URL, process.env.PSGIT_TEST_SUPABASE_URL, process.env.SUPABASE_URL)
  const supabaseAnonKey = firstNonEmpty(args.supabaseAnonKey, process.env.POWERSYNC_SUPABASE_ANON_KEY, process.env.PSGIT_TEST_SUPABASE_ANON_KEY, process.env.SUPABASE_ANON_KEY)
  const supabaseEmail = firstNonEmpty(args.supabaseEmail, process.env.POWERSYNC_SUPABASE_EMAIL, process.env.PSGIT_TEST_SUPABASE_EMAIL)
  const supabasePassword = firstNonEmpty(args.supabasePassword, process.env.POWERSYNC_SUPABASE_PASSWORD, process.env.PSGIT_TEST_SUPABASE_PASSWORD)
  const endpoint = firstNonEmpty(args.endpoint, process.env.POWERSYNC_ENDPOINT, process.env.PSGIT_TEST_ENDPOINT)

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
  }

  const result = await seedDemoRepository(options)
  console.log('✅ Seeded demo repository via PowerSync remote.')
  console.log(`   Remote: ${result.remoteUrl}`)
  console.log(`   Branch: ${result.branch}`)
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

  const loginResult = await loginWithDaemonDevice({
    daemonUrl: args.daemonUrl,
    endpoint: args.endpoint,
  })

  const explainChallenge = (prefix: string) => {
    const challenge = loginResult.challenge
    if (!challenge) return
    console.log(prefix)
    if (challenge.verificationUrl) {
      console.log(`   Open: ${challenge.verificationUrl}`)
    }
    console.log(`   Device code: ${challenge.challengeId}`)
    if (challenge.expiresAt) {
      console.log(`   Expires: ${challenge.expiresAt}`)
    }
  }

  const initialStatus = loginResult.initialStatus
  if (initialStatus?.status === 'pending' && initialStatus.reason) {
    console.log(`Daemon requested interactive login: ${initialStatus.reason}`)
  }
  if (initialStatus?.status === 'pending') {
    explainChallenge('To finish authentication:')
  }

  const finalStatus = loginResult.finalStatus
  if (!finalStatus) {
    throw new Error('Daemon did not provide an auth status. Check daemon logs for details.')
  }

  if (finalStatus.status === 'ready') {
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
    explainChallenge('Authentication is still pending; complete the flow in your browser or Explorer.')
    throw new Error(`Timed out waiting for daemon authentication${reason}.`)
  }

  console.log('Daemon authentication still pending. Complete the browser/device flow and rerun `psgit login`.')
  if (finalStatus.reason) {
    console.log(`Reason: ${finalStatus.reason}`)
  }
  explainChallenge('Pending device challenge:')
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
  console.log('  psgit demo-seed [--remote-url <url>] [--remote <name>] [--branch <branch>] [--skip-sync] [--keep-repo]')
  console.log('  psgit login [--guest] [--manual --token <jwt>] [--endpoint <url>] [--daemon-url <url>]')
  console.log('  psgit daemon stop [--daemon-url <url>] [--wait <ms>]')
  console.log('  psgit logout [--daemon-url <url>]')
}

function buildCli() {
  const defaultRemote = process.env.REMOTE_NAME ?? 'origin'

  return yargs(hideBin(process.argv))
    .scriptName('psgit')
    .usage(
      'psgit commands:\n' +
        '  psgit remote add powersync powersync::https://<endpoint>/orgs/<org>/repos/<repo>\n' +
        '  psgit sync [--remote <name>]\n' +
        '  psgit demo-seed [--remote-url <url>] [--remote <name>] [--branch <branch>] [--skip-sync] [--keep-repo]\n' +
        '  psgit login [--guest] [--manual --token <jwt>] [--endpoint <url>] [--daemon-url <url>]\n' +
        '  psgit daemon stop [--daemon-url <url>] [--wait <ms>]\n' +
        '  psgit logout [--daemon-url <url>]',
    )
    .option('stack-env', {
      type: 'string',
      describe: 'Path to stack env exports (defaults to .env.powersync-stack when present).',
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
      const explicitPath = typeof argv.stackEnv === 'string' ? argv.stackEnv : undefined
      maybeApplyStackEnv({
        explicitPath,
        silent: Boolean(explicitPath),
        allowMissing: !explicitPath,
      })
    }, true)
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
          }),
      async (argv) => {
        await runDemoSeedCommand({
          remoteUrl: (argv['remote-url'] as string | undefined) ?? (argv.url as string | undefined) ?? null,
          remoteName: (argv.remote as string | undefined) ?? null,
          branch: (argv.branch as string | undefined) ?? null,
          skipSync: argv['skip-sync'] as boolean | undefined,
          keepRepo: argv['keep-repo'] as boolean | undefined,
          repoDir: (argv['repo-dir'] as string | undefined) ?? null,
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
