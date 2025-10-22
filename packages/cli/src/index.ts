
import { mkdtemp, rm, writeFile, mkdir, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, sep } from 'node:path'
import { spawn } from 'node:child_process'
import simpleGit from 'simple-git'
import {
  PowerSyncRemoteClient,
  RAW_TABLE_SPECS,
  type RepoDataSummary,
  parsePowerSyncUrl,
  REPO_STREAM_SUFFIXES,
  type RepoStreamSuffix,
  buildRepoStreamTargets,
  type RepoStreamTarget,
} from '@shared/core'
export { loadProfileEnvironment, resolveProfileDirectory, resolveProfilesPath } from './profile-env.js'

type StreamSuffix = RepoStreamSuffix
type StreamSubscriptionRequest = RepoStreamTarget
const DEFAULT_SEED_BRANCH = 'main'
const DEFAULT_SEED_AUTHOR = { name: 'PowerSync Seed Bot', email: 'seed@powersync.test' }
const DEFAULT_TEMPLATE_REPO = 'https://github.com/powersync-community/react-supabase-chat-e2ee.git'

function buildStreamTargets(org: string, repo: string): StreamSubscriptionRequest[] {
  return buildRepoStreamTargets(org, repo)
}

async function subscribeRepoStreams(baseUrl: string, streams: StreamSubscriptionRequest[]): Promise<void> {
  if (typeof globalThis.fetch !== 'function') {
    console.warn('[psgit] fetch API unavailable; cannot request daemon stream subscription')
    return
  }
  if (streams.length === 0) return
  const target = `${normalizeBaseUrl(baseUrl)}/streams`
  try {
    const res = await fetch(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streams }),
    })
    if (!res.ok && res.status !== 503) {
      console.warn(`[psgit] daemon stream subscription returned ${res.status} ${res.statusText}`)
    }
  } catch (error) {
    console.warn('[psgit] failed to subscribe daemon streams', error instanceof Error ? error.message : error)
  }
}

export const DEFAULT_DAEMON_URL =
  process.env.POWERSYNC_DAEMON_URL ??
  process.env.POWERSYNC_DAEMON_ENDPOINT ??
  'http://127.0.0.1:5030'
const DAEMON_START_COMMAND = process.env.POWERSYNC_DAEMON_START_COMMAND ?? 'pnpm dev:daemon'
const DAEMON_AUTOSTART_DISABLED = (process.env.POWERSYNC_DAEMON_AUTOSTART ?? 'true').toLowerCase() === 'false'
const DAEMON_START_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_START_TIMEOUT_MS ?? '7000', 10)
const DAEMON_CHECK_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_CHECK_TIMEOUT_MS ?? '2000', 10)
const DAEMON_START_HINT =
  'PowerSync daemon unreachable — start it with "pnpm dev:daemon" or point POWERSYNC_DAEMON_URL at a running instance.'

export interface SeedDemoOptions {
  remoteUrl?: string
  remoteName?: string
  branch?: string
  skipSync?: boolean
  keepWorkingDir?: boolean
  workingDir?: string
  templateRepoUrl?: string | null
}

export interface SeedDemoResult {
  remoteUrl: string
  branch: string
  workingDirectory: string
  templateRepoUrl?: string | null
  syncedDatabase?: string
}

export async function seedDemoRepository(options: SeedDemoOptions = {}): Promise<SeedDemoResult> {
  const remoteUrl =
    options.remoteUrl ??
    process.env.POWERSYNC_SEED_REMOTE_URL ??
    process.env.PSGIT_TEST_REMOTE_URL ??
    process.env.POWERSYNC_TEST_REMOTE_URL

  if (!remoteUrl) {
    throw new Error('Missing PowerSync remote URL. Set POWERSYNC_SEED_REMOTE_URL or PSGIT_TEST_REMOTE_URL.')
  }

  const remoteName =
    options.remoteName ??
    process.env.POWERSYNC_SEED_REMOTE_NAME ??
    process.env.PSGIT_TEST_REMOTE_NAME ??
    'powersync'

  const branch = options.branch ?? process.env.POWERSYNC_SEED_BRANCH ?? DEFAULT_SEED_BRANCH

  const repoDir = options.workingDir ?? (await mkdtemp(join(tmpdir(), 'psgit-seed-')))
  const createdTempRepo = !options.workingDir

  await mkdir(repoDir, { recursive: true })

  let usedTemplateRepo: string | null = null
  const templateRepoUrl =
    options.templateRepoUrl === null
      ? null
      : options.templateRepoUrl ?? process.env.POWERSYNC_SEED_TEMPLATE_URL ?? DEFAULT_TEMPLATE_REPO

  const git = simpleGit({ baseDir: repoDir })
  await git.init()
  await git.addConfig('user.email', DEFAULT_SEED_AUTHOR.email)
  await git.addConfig('user.name', DEFAULT_SEED_AUTHOR.name)

  if (templateRepoUrl) {
    const tempBase = await mkdtemp(join(tmpdir(), 'psgit-template-'))
    const templateDir = join(tempBase, 'template')
    try {
      await simpleGit().clone(templateRepoUrl, templateDir, ['--depth', '1'])
    } catch (error) {
      await rm(tempBase, { recursive: true, force: true })
      throw new Error(`Failed to clone demo template from ${templateRepoUrl}: ${(error as Error)?.message ?? error}`)
    }
    await rm(join(templateDir, '.git'), { recursive: true, force: true }).catch(() => {})
    await cp(templateDir, repoDir, {
      recursive: true,
      force: true,
      filter: (src) => !src.endsWith(`${sep}.git`),
    })
    await rm(tempBase, { recursive: true, force: true })
    await git.add('.')
    await git.commit(`Import demo template content from ${templateRepoUrl}`)
    usedTemplateRepo = templateRepoUrl
  } else {
    await writeFile(join(repoDir, 'README.md'), '# PowerSync Seed Repo\n\nThis data was seeded via psgit.\n')
    await git.add(['README.md'])
    await git.commit('Initial commit')

    await mkdir(join(repoDir, 'src'), { recursive: true })
    await writeFile(
      join(repoDir, 'src', 'app.ts'),
      "export const greet = (name: string) => `Hello, ${name}!`\n",
    )
    await writeFile(
      join(repoDir, 'src', 'routes.md'),
      '- /branches\n- /commits\n- /files\n',
    )
    await git.add(['src/app.ts', 'src/routes.md'])
    await git.commit('Add sample application files')
  }

  const remotes = await git.getRemotes(true)
  const existingRemote = remotes.find((entry) => entry.name === remoteName)
  if (existingRemote) {
    await git.remote(['set-url', remoteName, remoteUrl])
  } else {
    await git.addRemote(remoteName, remoteUrl)
  }

  const pushRef = `HEAD:refs/heads/${branch}`
  await git.raw(['push', '--force', remoteName, pushRef])

  let syncedDatabase: string | undefined
  if (!options.skipSync) {
    const result = await syncPowerSyncRepository(repoDir, {
      remoteName,
    }).catch((error: unknown) => {
      console.warn('[psgit] seed sync failed', error)
      return null
    })
    if (result?.databasePath) {
      syncedDatabase = result.databasePath ?? undefined
    }
  }

  if (createdTempRepo && !options.keepWorkingDir) {
    await rm(repoDir, { recursive: true, force: true })
  }

  return {
    remoteUrl,
    branch,
    workingDirectory: repoDir,
    templateRepoUrl: usedTemplateRepo,
    syncedDatabase,
  }
}

export async function addPowerSyncRemote(dir: string, name: string, url: string) {
  const git = simpleGit({ baseDir: dir })
  const remotes = await git.getRemotes(true)
  const exists = remotes.find(r => r.name === name)
  if (!exists) await git.addRemote(name, url)
  else await git.remote(['set-url', name, url])
  return true
}

export interface SyncCommandOptions {
  remoteName?: string
  sessionPath?: string
  daemonUrl?: string
}

export interface SyncCommandResult {
  org: string
  repo: string
  endpoint: string
  counts: Record<StreamSuffix, number>
  databasePath?: string | null
}

type DaemonAuthStatusCheck =
  | { status: 'ready'; reason?: string | null }
  | { status: 'pending'; reason?: string | null }
  | { status: 'auth_required'; reason?: string | null }
  | { status: 'error'; reason?: string | null }
  | null

export async function syncPowerSyncRepository(dir: string, options: SyncCommandOptions = {}): Promise<SyncCommandResult> {
  const remoteName = options.remoteName ?? process.env.REMOTE_NAME ?? 'origin'
  const git = simpleGit({ baseDir: dir })
  const remotes = await git.getRemotes(true)
  const remote = remotes.find(r => r.name === remoteName)
  if (!remote) {
    throw new Error(`Missing Git remote "${remoteName}". Use "psgit remote add powersync" first or specify --remote.`)
  }

  const candidateUrl = remote.refs.fetch || remote.refs.push
  if (!candidateUrl) {
    throw new Error(`Git remote "${remoteName}" does not have a fetch URL configured.`)
  }

  const { endpoint, org, repo } = parsePowerSyncUrl(candidateUrl)

  const daemonBaseUrl = normalizeBaseUrl(options.daemonUrl ?? process.env.POWERSYNC_DAEMON_URL ?? DEFAULT_DAEMON_URL)
  await ensureDaemonReady(daemonBaseUrl)
  const authStatus = await fetchDaemonAuthStatus(daemonBaseUrl)
  if (!authStatus || authStatus.status !== 'ready') {
    const reason = authStatus?.reason ? ` (${authStatus.reason})` : ''
    throw new Error(
      `[psgit] PowerSync daemon is not authenticated${reason}. Run \`psgit login\` to authorise the daemon.`,
    )
  }

  await subscribeRepoStreams(daemonBaseUrl, buildStreamTargets(org, repo))

  const client = new PowerSyncRemoteClient({
    endpoint: daemonBaseUrl,
    pathRouting: 'segments',
    fetchImpl: globalThis.fetch as typeof fetch,
  })

  const summary: RepoDataSummary = await client.getRepoSummary(org, repo)
  const counts = Object.fromEntries(
    REPO_STREAM_SUFFIXES.map((name) => [name, summary.counts[name] ?? 0]),
  ) as Record<StreamSuffix, number>

  return {
    org,
    repo,
    endpoint,
    counts,
    databasePath: null,
  }
}

export function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

export async function ensureDaemonReady(baseUrl: string): Promise<void> {
  if (await isDaemonResponsive(baseUrl)) {
    return
  }

  if (DAEMON_AUTOSTART_DISABLED) {
    throw new Error(DAEMON_START_HINT)
  }

  try {
    launchDaemon()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${DAEMON_START_HINT} (${message})`)
  }

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isDaemonResponsive(baseUrl)) {
      return
    }
    await delay(200)
  }

  throw new Error(`${DAEMON_START_HINT} (daemon start timed out)`)
}

async function isDaemonResponsive(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), DAEMON_CHECK_TIMEOUT_MS)
    const response = await fetch(`${baseUrl}/health`, { signal: controller.signal })
    clearTimeout(timeout)
    return response.ok
  } catch {
    return false
  }
}

function launchDaemon(): void {
  const child = spawn(DAEMON_START_COMMAND, {
    shell: true,
    detached: true,
    stdio: 'ignore',
    env: process.env,
  })
  child.unref()
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchDaemonAuthStatus(baseUrl: string): Promise<DaemonAuthStatusCheck> {
  try {
    const controller = new AbortController()
    const timeoutMs = Number.parseInt(process.env.POWERSYNC_DAEMON_CHECK_TIMEOUT_MS ?? '2000', 10)
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(`${baseUrl}/auth/status`, { signal: controller.signal })
    clearTimeout(timeout)
    if (!response.ok) {
      return null
    }
    const payload = (await response.json().catch(() => null)) as { status?: unknown; reason?: unknown } | null
    if (!payload || typeof payload.status !== 'string') {
      return null
    }
    const status = payload.status
    if (status !== 'ready' && status !== 'pending' && status !== 'auth_required' && status !== 'error') {
      return null
    }
    const reason = typeof payload.reason === 'string' ? payload.reason : null
    return { status, reason }
  } catch {
    return null
  }
}
