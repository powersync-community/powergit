
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import simpleGit from 'simple-git'
import type { PowerSyncDatabase, PowerSyncBackendConnector } from '@powersync/node'
import { parsePowerSyncUrl } from '@shared/core'
import { CliPowerSyncConnector } from './powersync/connector.js'
import { createPowerSyncDatabase, getDefaultDatabasePath, type CliDatabaseOptions } from './powersync/database.js'

const STREAM_SUFFIXES = ['refs', 'commits', 'file_changes', 'objects'] as const
type StreamSuffix = typeof STREAM_SUFFIXES[number]
const DEFAULT_SEED_BRANCH = 'main'
const DEFAULT_SEED_AUTHOR = { name: 'PowerSync Seed Bot', email: 'seed@powersync.test' }

export interface SeedDemoOptions {
  remoteUrl?: string
  remoteName?: string
  branch?: string
  dbPath?: string
  skipSync?: boolean
  keepWorkingDir?: boolean
  workingDir?: string
}

export interface SeedDemoResult {
  remoteUrl: string
  branch: string
  workingDirectory: string
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

  const git = simpleGit({ baseDir: repoDir })
  await git.init()
  await git.addConfig('user.email', DEFAULT_SEED_AUTHOR.email)
  await git.addConfig('user.name', DEFAULT_SEED_AUTHOR.name)

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
    const dbPath = options.dbPath ?? resolve(process.cwd(), 'tmp', 'powersync-seed.sqlite')
    await mkdir(dirname(dbPath), { recursive: true })
    const result = await syncPowerSyncRepository(repoDir, {
      remoteName,
      dbPath,
    }).catch((error: unknown) => {
      console.warn('[psgit] seed sync failed', error)
      return null
    })
    if (result?.databasePath) {
      syncedDatabase = result.databasePath
    }
  }

  if (createdTempRepo && !options.keepWorkingDir) {
    await rm(repoDir, { recursive: true, force: true })
  }

  return {
    remoteUrl,
    branch,
    workingDirectory: repoDir,
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
  dbPath?: string
  databaseFactory?: (options: CliDatabaseOptions) => Promise<PowerSyncDatabase>
  connectorFactory?: () => PowerSyncBackendConnector
}

export interface SyncCommandResult {
  org: string
  repo: string
  endpoint: string
  databasePath: string
  counts: Record<StreamSuffix, number>
}

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
  const dbPath = options.dbPath ?? getDefaultDatabasePath()
  const databaseFactory = options.databaseFactory ?? (async (dbOptions: CliDatabaseOptions) => createPowerSyncDatabase(dbOptions))
  const connectorFactory = options.connectorFactory ?? (() => new CliPowerSyncConnector())

  const database = await databaseFactory({ dbPath })
  const connector = connectorFactory()

  await database.connect(connector, { includeDefaultStreams: false })
  await database.waitForReady()

  const streamIds = STREAM_SUFFIXES.map((name) => `orgs/${org}/repos/${repo}/${name}`)
  const subscriptions = await Promise.all(streamIds.map(async (id) => {
    const stream = database.syncStream(id)
    const subscription = await stream.subscribe()
    return subscription
  }))

  try {
    await Promise.all(subscriptions.map((subscription) => subscription.waitForFirstSync()))

    const counts = await collectTableCounts(database)

    return {
      org,
      repo,
      endpoint,
      databasePath: dbPath,
      counts,
    }
  } finally {
    subscriptions.forEach((subscription) => {
      try {
        if (typeof subscription.unsubscribe === 'function') {
          subscription.unsubscribe()
        }
      } catch (error) {
        console.warn('[psgit] failed to unsubscribe PowerSync stream', error)
      }
    })
    await database.close({ disconnect: true }).catch(() => undefined)
  }
}

async function collectTableCounts(database: PowerSyncDatabase): Promise<Record<StreamSuffix, number>> {
  const targets: StreamSuffix[] = [...STREAM_SUFFIXES]
  const result = Object.fromEntries(targets.map((name) => [name, 0])) as Record<StreamSuffix, number>

  for (const tableName of targets) {
    const rows = await database.getAll<{ count: number }>(`SELECT COUNT(*) AS count FROM ${tableName}`)
    const count = rows[0]?.count ?? 0
    result[tableName] = count
  }

  return result
}

export * from './powersync/database.js'
export * from './powersync/connector.js'
export * from './powersync/schema.js'
