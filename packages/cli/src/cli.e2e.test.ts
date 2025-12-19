import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile, spawn, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { parsePowerSyncUrl, PowerSyncRemoteClient, buildRepoStreamTargets, formatStreamKey } from '@powersync-community/powergit-core'
import { startStack, stopStack } from '../../../scripts/test-stack-hooks.mjs'
import { seedDemoRepository } from './index.js'
import { clearStoredCredentials, loadStoredCredentials, saveStoredCredentials } from './auth/session.js'
import { loginWithSupabasePassword } from './auth/login.js'
import { fetchDaemonAuthStatus, resolveDaemonBaseUrl } from './auth/daemon-client.js'

const execFileAsync = promisify(execFile)
const binPath = fileURLToPath(new URL('./bin.ts', import.meta.url))
const require = createRequire(import.meta.url)
const tsxImport = pathToFileURL(require.resolve('tsx/esm')).href
const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)), '..')
const builtBinPath = resolve(repoRoot, 'packages/cli/dist/cli/src/bin.js')

function buildCliArgs(args: string[]): string[] {
  if (existsSync(builtBinPath)) {
    return [builtBinPath, ...args]
  }
  return ['--import', tsxImport, binPath, ...args]
}

const requiredEnvVars = [
  'POWERGIT_TEST_REMOTE_URL',
  'POWERGIT_TEST_SUPABASE_URL',
  'POWERGIT_TEST_SUPABASE_EMAIL',
  'POWERGIT_TEST_SUPABASE_PASSWORD',
]
const initialMissingEnv = requiredEnvVars.filter((name) => !process.env[name])

function resolveSupabaseBinary(): string {
  const configured = process.env.SUPABASE_BIN
  if (configured && configured.length > 0) {
    return configured
  }

  try {
    const packagePath = require.resolve('@supabase/cli/package.json')
    const packageDir = dirname(packagePath)
    const candidate = resolve(packageDir, 'bin', 'supabase')
    if (existsSync(candidate)) {
      return candidate
    }
  } catch {
    // ignore missing workspace copy — fall back to PATH lookup
  }

  return 'supabase'
}

const supabaseBinary = resolveSupabaseBinary()
const supabaseProbe = spawnSync(supabaseBinary, ['--version'], { stdio: 'ignore' })
const hasSupabaseCli = supabaseProbe.error == null && supabaseProbe.status === 0

const dockerBinary = process.env.DOCKER_BIN ?? 'docker'
const dockerProbe = spawnSync(dockerBinary, ['--version'], { stdio: 'ignore' })
const dockerComposeProbe = spawnSync(dockerBinary, ['compose', 'version'], { stdio: 'ignore' })
const dockerInfoProbe = spawnSync(dockerBinary, ['info'], { stdio: 'ignore' })
const hasDocker =
  dockerProbe.error == null &&
  dockerProbe.status === 0 &&
  dockerComposeProbe.error == null &&
  dockerComposeProbe.status === 0 &&
  dockerInfoProbe.error == null &&
  dockerInfoProbe.status === 0

if (hasSupabaseCli) {
  process.env.SUPABASE_BIN = supabaseBinary
}

if (hasDocker) {
  process.env.DOCKER_BIN = dockerBinary
}

const shouldAttemptLocalStack = initialMissingEnv.length > 0 && hasSupabaseCli && hasDocker
const canRunLiveTests = initialMissingEnv.length === 0 || shouldAttemptLocalStack

if (initialMissingEnv.length > 0 && !canRunLiveTests) {
  console.warn(
    '[cli] skipping live PowerSync e2e tests — missing env vars and local Supabase stack is unavailable.\n' +
      `Missing: ${initialMissingEnv.join(', ')}\n` +
      'Install Supabase CLI + Docker or export POWERGIT_TEST_* variables to enable these tests.',
  )
}

const describeLive = canRunLiveTests ? describe : describe.skip

const PROPAGATION_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_E2E_PROPAGATION_TIMEOUT_MS ?? '60000', 10)

type LiveStackConfig = {
  remoteUrl: string
  remoteName: string
  supabaseUrl: string
  supabaseEmail: string
  supabasePassword: string
  endpoint?: string
}

let liveStackConfig!: LiveStackConfig
let startedLocalStack = false
let skipLiveSuite = false

async function runScript(scriptRelativePath: string, extraEnv: NodeJS.ProcessEnv = {}) {
  const scriptPath = resolve(repoRoot, scriptRelativePath)
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn('node', [scriptPath], {
      stdio: 'inherit',
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv },
    })
    child.on('close', (code) => {
      if (code === 0) resolvePromise()
      else rejectPromise(new Error(`${scriptRelativePath} exited with code ${code}`))
    })
    child.on('error', rejectPromise)
  })
}

async function seedLiveStackData(config: LiveStackConfig) {
  const { org, repo } = parsePowerSyncUrl(config.remoteUrl)
  await seedDemoRepository({
    remoteUrl: config.remoteUrl,
    remoteName: config.remoteName,
    branch: 'main',
    skipSync: true,
    keepWorkingDir: false,
  })
  console.log(`[cli-e2e] seeded PowerSync repo ${org}/${repo} via daemon push`)
}

async function runGit(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd })
}

describe('powergit CLI e2e', () => {
  let repoDir: string

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'powergit-e2e-'))
    await runGit(['init'], repoDir)
  })

  afterEach(async () => {
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  afterAll(async () => {
    await clearStoredCredentials().catch(() => undefined)
    if (startedLocalStack) {
      await stopStack({ force: true }).catch(() => undefined)
      startedLocalStack = false
    }
  })

  async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
    const result = await execFileAsync(
      'node',
      buildCliArgs(args),
      {
        cwd: repoDir,
        env: { ...process.env, ...env },
      }
    )
    return result
  }

  async function getRemoteUrl(name = 'powersync') {
    const { stdout } = await runGit(['remote', 'get-url', name], repoDir)
    return stdout.trim()
  }

  it('adds and updates the default powersync remote', async () => {
    const firstUrl = 'powergit::https://example.dev/orgs/acme/repos/infra'
    const { stdout: addStdout } = await runCli(['remote', 'add', 'powersync', firstUrl])
    expect(addStdout).toContain(`Added PowerSync remote (powersync): ${firstUrl}`)

    expect(await getRemoteUrl()).toBe(firstUrl)

    const secondUrl = 'powergit::https://example.dev/orgs/acme/repos/runtime'
    const { stdout: updateStdout } = await runCli(['remote', 'add', 'powersync', secondUrl])
    expect(updateStdout).toContain(`Added PowerSync remote (powersync): ${secondUrl}`)

    expect(await getRemoteUrl()).toBe(secondUrl)
  })

  it('respects REMOTE_NAME overrides', async () => {
    const customRemote = 'powersync-upstream'
    const remoteUrl = 'powergit::https://example.dev/orgs/acme/repos/mobile'

    const { stdout } = await runCli(
      ['remote', 'add', 'powersync', remoteUrl],
      { REMOTE_NAME: customRemote }
    )

    expect(stdout).toContain(`Added PowerSync remote (${customRemote}): ${remoteUrl}`)
    expect(await getRemoteUrl(customRemote)).toBe(remoteUrl)
  })

  it('prints usage help for unknown commands', async () => {
    const { stdout } = await runCli([])
    expect(stdout).toContain('powergit commands:')
    expect(stdout).toContain('powergit remote add powersync')

    let execError: (NodeJS.ErrnoException & { stderr?: string }) | null = null
    try {
      await runCli(['status'])
    } catch (error) {
      execError = error as NodeJS.ErrnoException & { stderr?: string }
    }
    expect(execError).not.toBeNull()
    expect(execError?.stderr ?? execError?.message ?? '').toContain('Unknown argument: status')
  })

  it('exits with usage instructions when url is missing', async () => {
    let execError: (NodeJS.ErrnoException & { stderr?: string }) | null = null
    try {
      await runCli(['remote', 'add', 'powersync'])
    } catch (error) {
      execError = error as NodeJS.ErrnoException & { stderr?: string }
    }
    expect(execError).not.toBeNull()
    expect(execError?.code).toBe(2)
    expect(execError?.stderr ?? execError?.message ?? '').toContain('Not enough non-option arguments')
  })
})

describeLive('powergit sync against live PowerSync stack', () => {
  let repoDir: string

  beforeAll(async () => {
    if (!canRunLiveTests) {
      return
    }

    if (shouldAttemptLocalStack) {
      await startStack({ skipDemoSeed: true })
      startedLocalStack = true
    }

    const missingAfterStart = requiredEnvVars.filter((name) => !process.env[name])
    if (missingAfterStart.length > 0) {
      throw new Error(
        `Missing required environment variables for PowerSync live-stack tests: ${missingAfterStart.join(
          ', ',
        )}. Start the local stack or export POWERGIT_TEST_* variables.`,
      )
    }

    liveStackConfig = {
      remoteUrl: process.env.POWERGIT_TEST_REMOTE_URL!,
      remoteName: process.env.POWERGIT_TEST_REMOTE_NAME ?? 'powersync',
      supabaseUrl: process.env.POWERGIT_TEST_SUPABASE_URL!,
      endpoint: process.env.POWERGIT_TEST_ENDPOINT,
      supabaseEmail: process.env.POWERGIT_TEST_SUPABASE_EMAIL!,
      supabasePassword: process.env.POWERGIT_TEST_SUPABASE_PASSWORD!,
    }

    try {
      const { default: BetterSqlite } = await import('better-sqlite3')
      const probe = new BetterSqlite(':memory:')
      probe.close()
    } catch (error) {
      skipLiveSuite = true
      console.warn(
        '[cli] skipping live PowerSync stack tests — better-sqlite3 native module unavailable:',
        (error as Error)?.message ?? error,
      )
      return
    }

    const provisionSessionCredentials = async () => {
      let cached = await loadStoredCredentials().catch(() => null)
      if (cached?.endpoint) {
        return cached
      }

      const supabaseAnonKey =
        process.env.SUPABASE_ANON_KEY ??
        process.env.POWERGIT_TEST_SUPABASE_ANON_KEY
      const supabaseUrl = process.env.SUPABASE_URL ?? process.env.POWERGIT_TEST_SUPABASE_URL
      const supabaseEmail = process.env.SUPABASE_EMAIL ?? process.env.POWERGIT_TEST_SUPABASE_EMAIL
      const supabasePassword =
        process.env.SUPABASE_PASSWORD ?? process.env.POWERGIT_TEST_SUPABASE_PASSWORD
      const endpoint = process.env.POWERGIT_TEST_ENDPOINT ?? process.env.POWERSYNC_URL

      if (!supabaseAnonKey || !supabaseUrl || !supabaseEmail || !supabasePassword || !endpoint) {
        throw new Error('Missing Supabase credentials or PowerSync endpoint for live stack login.')
      }

      const result = await loginWithSupabasePassword({
        endpoint,
        supabaseUrl,
        supabaseAnonKey,
        supabaseEmail,
        supabasePassword,
        persistSession: true,
      })

      await saveStoredCredentials(result.credentials)
      const baseUrl = await resolveDaemonBaseUrl({})
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const status = await fetchDaemonAuthStatus(baseUrl)
        if (status?.status === 'ready') {
          cached = result.credentials
          return cached
        }
        if (status?.status === 'error') {
          const reason = status.reason ? ` (${status.reason})` : ''
          throw new Error(`Daemon authentication failed${reason}`)
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 500))
      }
      throw new Error('Timed out waiting for daemon to acknowledge Supabase session.')
    }

    let cachedCredentials
    try {
      cachedCredentials = await provisionSessionCredentials()
    } catch (error) {
      skipLiveSuite = true
      console.warn(
        '[cli] skipping live PowerSync stack tests — unable to provision daemon credentials:',
        (error as Error)?.message ?? error,
      )
      return
    }

    process.env.POWERSYNC_DAEMON_ENDPOINT = cachedCredentials.endpoint

    if (startedLocalStack) {
      await runScript('scripts/seed-sync-rules.mjs')
    }

    if (startedLocalStack) {
      await seedLiveStackData(liveStackConfig)
    }

    try {
      await execFileAsync(
        'node',
        buildCliArgs([
          'login',
          '--supabase-email',
          liveStackConfig.supabaseEmail,
          '--supabase-password',
          liveStackConfig.supabasePassword,
        ]),
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            SUPABASE_URL: liveStackConfig.supabaseUrl,
            SUPABASE_EMAIL: liveStackConfig.supabaseEmail,
            SUPABASE_PASSWORD: liveStackConfig.supabasePassword,
            POWERSYNC_URL: liveStackConfig.endpoint,
          },
        },
      )
    } catch (error) {
      skipLiveSuite = true
      console.warn(
        '[cli] skipping live PowerSync stack tests — daemon login failed:',
        (error as Error)?.message ?? error,
      )
      return
    }
  }, 240_000)

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'powergit-stack-e2e-'))
    await runGit(['init'], repoDir)
  })

  afterEach(async () => {
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  afterAll(async () => {
    await clearStoredCredentials().catch(() => undefined)
  })

  async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
    return execFileAsync(
      'node',
      buildCliArgs(args),
      {
        cwd: repoDir,
        env: {
          ...process.env,
          SUPABASE_URL: liveStackConfig.supabaseUrl,
          SUPABASE_EMAIL: liveStackConfig.supabaseEmail,
          SUPABASE_PASSWORD: liveStackConfig.supabasePassword,
          POWERSYNC_URL: liveStackConfig.endpoint,
          ...env,
        },
      },
    )
  }

  function runCliInDir(targetDir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
    return execFileAsync(
      'node',
      buildCliArgs(args),
      {
        cwd: targetDir,
        env: {
          ...process.env,
          SUPABASE_URL: liveStackConfig.supabaseUrl,
          SUPABASE_EMAIL: liveStackConfig.supabaseEmail,
          SUPABASE_PASSWORD: liveStackConfig.supabasePassword,
          POWERSYNC_URL: liveStackConfig.endpoint,
          ...env,
        },
      },
    )
  }

  function parseSyncCounts(output: string) {
    const match = /Rows: (\d+) refs, (\d+) commits, (\d+) file changes/.exec(output)
    if (!match) {
      throw new Error(`Unable to parse sync output: ${output}`)
    }
    return {
      refs: Number.parseInt(match[1]!, 10),
      commits: Number.parseInt(match[2]!, 10),
      fileChanges: Number.parseInt(match[3]!, 10),
    }
  }

  async function waitForCounts(
    fn: () => Promise<{ refs: number; commits: number; fileChanges: number }>,
    predicate: (counts: { refs: number; commits: number; fileChanges: number }) => boolean,
    timeoutMs: number,
  ) {
    const deadline = Date.now() + timeoutMs
    let lastCounts: { refs: number; commits: number; fileChanges: number } | null = null
    while (Date.now() < deadline) {
      lastCounts = await fn()
      if (predicate(lastCounts)) {
        return lastCounts
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error(`Timed out waiting for PowerSync counts to satisfy predicate (last counts: ${JSON.stringify(lastCounts)})`)
  }

  async function listDaemonStreams(baseUrl: string) {
    const response = await fetch(`${baseUrl}/streams`).catch(() => null)
    if (!response || !response.ok) {
      throw new Error(`Failed to list daemon streams (status: ${response?.status ?? 'unavailable'})`)
    }
    const payload = (await response.json().catch(() => null)) as { streams?: unknown } | null
    if (!payload || !Array.isArray(payload.streams)) {
      return []
    }
    return payload.streams.filter((value): value is string => typeof value === 'string' && value.length > 0)
  }

  it('hydrates refs, commits, and file changes into SQLite', async () => {
    if (skipLiveSuite) {
      return
    }

    await runCli(
      ['remote', 'add', 'powersync', liveStackConfig.remoteUrl!],
      { REMOTE_NAME: liveStackConfig.remoteName },
    )

    const counts = await waitForCounts(
      async () => {
        const { stdout, stderr } = await runCli(['sync', '--remote', liveStackConfig.remoteName])
        return parseSyncCounts(`${stdout ?? ''}${stderr ?? ''}`)
      },
      (values) => values.refs > 0 && values.commits > 0,
      PROPAGATION_TIMEOUT_MS,
    )

    expect(counts.refs).toBeGreaterThan(0)
    expect(counts.commits).toBeGreaterThan(0)
    expect(counts.fileChanges).toBeGreaterThanOrEqual(0)
  }, 60_000)

  it('streams new refs between separate working directories', async () => {
    if (skipLiveSuite) {
      return
    }

    const repoDirA = await mkdtemp(join(tmpdir(), 'powergit-stream-a-'))
    const repoDirB = await mkdtemp(join(tmpdir(), 'powergit-stream-b-'))

    const remoteUrl = liveStackConfig.remoteUrl
    const remoteName = liveStackConfig.remoteName
    const daemonBaseUrl = process.env.POWERSYNC_DAEMON_URL ?? 'http://127.0.0.1:5030'
    const branchName = `cli-stream-${Date.now().toString(36)}`
    const { org, repo } = parsePowerSyncUrl(remoteUrl)
    const streamTargets = buildRepoStreamTargets(org, repo)
    const streamKeys = streamTargets.map(formatStreamKey)

    const setupWorkingCopy = async (dir: string) => {
      await runGit(['init'], dir)
      await runGit(['config', 'user.email', 'cli-e2e@example.com'], dir)
      await runGit(['config', 'user.name', 'CLI E2E'], dir)
      await runCliInDir(dir, ['remote', 'add', 'powersync', remoteUrl], { REMOTE_NAME: remoteName })
    }

    try {
      await setupWorkingCopy(repoDirA)
      await setupWorkingCopy(repoDirB)

      const deleteRes = await fetch(`${daemonBaseUrl}/streams`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ streams: streamTargets }),
      })
      expect(deleteRes.status).toBeLessThan(500)

      const afterDeleteStreams = await listDaemonStreams(daemonBaseUrl)
      for (const key of streamKeys) {
        expect(afterDeleteStreams).not.toContain(key)
      }

      const initialSync = await runCliInDir(repoDirB, ['sync', '--remote', remoteName])
      const initialCounts = parseSyncCounts(`${initialSync.stdout ?? ''}${initialSync.stderr ?? ''}`)

      const streamsAfterSync = await listDaemonStreams(daemonBaseUrl)
      for (const key of streamKeys) {
        expect(streamsAfterSync).toContain(key)
      }

      await seedDemoRepository({
        remoteUrl,
        remoteName,
        branch: branchName,
        skipSync: true,
        keepWorkingDir: false,
      })

      const updatedCounts = await waitForCounts(
        async () => {
          const { stdout, stderr } = await runCliInDir(repoDirB, ['sync', '--remote', remoteName])
          return parseSyncCounts(`${stdout ?? ''}${stderr ?? ''}`)
        },
        (counts) => counts.refs > initialCounts.refs || counts.commits > initialCounts.commits,
        PROPAGATION_TIMEOUT_MS,
      )

      expect(updatedCounts.refs).toBeGreaterThan(initialCounts.refs)

      const client = new PowerSyncRemoteClient({
        endpoint: daemonBaseUrl,
        fetchImpl: global.fetch as typeof fetch,
        pathRouting: 'segments',
      })
      const refs = await client.listRefs(org, repo)
      expect(refs.refs.some((ref) => ref.name === `refs/heads/${branchName}`)).toBe(true)
    } finally {
      await rm(repoDirA, { recursive: true, force: true }).catch(() => undefined)
      await rm(repoDirB, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 120_000)
})
