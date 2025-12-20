import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { startStack, stopStack } from '../../../scripts/test-stack-hooks.mjs'
import { getServerSupabaseClient, buildRepoStreamTargets, formatStreamKey } from '@powersync-community/powergit-core'
import { resolvePowergitRemote } from '@powersync-community/powergit-core/node'

const execFileAsync = promisify(execFile)
const MAX_WAIT_MS = Number.parseInt(process.env.POWERSYNC_TEST_MAX_WAIT_MS ?? '60000', 10)
const POLL_INTERVAL_MS = 1000

async function waitFor<T>(fn: () => Promise<T | null | false>, timeoutMs = MAX_WAIT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastValue: T | null | false = null
  while (Date.now() < deadline) {
    lastValue = await fn()
    if (lastValue) return lastValue
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new Error(`Timed out waiting for condition (last value: ${JSON.stringify(lastValue)})`)
}

const requireForTests = createRequire(import.meta.url)

function resolveSupabaseBinary(): string {
  const configured = process.env.SUPABASE_BIN
  if (configured && configured.length > 0) {
    return configured
  }

  try {
    const packagePath = requireForTests.resolve('@supabase/cli/package.json')
    const packageDir = dirname(packagePath)
    const candidate = join(packageDir, 'bin', 'supabase')
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

let hasBetterSqlite = true
try {
  const BetterSqlite = requireForTests('better-sqlite3')
  const probe = new BetterSqlite(':memory:')
  probe.close()
} catch (error) {
  hasBetterSqlite = false
  console.warn(
    '[remote-helper] skipping git e2e tests — better-sqlite3 native module unavailable:',
    (error as Error)?.message ?? error,
  )
}

if (!hasSupabaseCli) {
  console.warn(
    '[remote-helper] skipping git e2e tests — Supabase CLI not found (set SUPABASE_BIN to the binary path)',
  )
}

if (!hasDocker) {
  console.warn(
    '[remote-helper] skipping git e2e tests — Docker with compose plugin not available (set DOCKER_BIN to override)',
  )
}

if (hasSupabaseCli) {
  process.env.SUPABASE_BIN = supabaseBinary
}

if (hasDocker) {
  process.env.DOCKER_BIN = dockerBinary
}

const describeIfSupabase = hasSupabaseCli && hasDocker && hasBetterSqlite ? describe : describe.skip

async function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return execFileAsync('git', args, { cwd, env })
}

const tsxEsmPath = requireForTests.resolve('tsx/esm')

async function createHelperExecutable(dir: string): Promise<string> {
  const helperPath = join(dir, 'git-remote-powergit')
  const entry = fileURLToPath(new URL('./bin.ts', import.meta.url))
  const script = [
    '#!/usr/bin/env node',
    "const { pathToFileURL } = require('node:url');",
    '(async () => {',
    `  await import(${JSON.stringify(tsxEsmPath)});`,
    `  await import(pathToFileURL(${JSON.stringify(entry)}).href);`,
    '})().catch((error) => {',
    '  console.error(error)',
    '  process.exit(1)',
    '});',
    '',
  ].join('\n')
  await writeFile(helperPath, script, { mode: 0o755 })
  return helperPath
}

describeIfSupabase('git push/fetch via PowerSync remote helper', () => {
  let helperDir: string
  let repoDir: string
  let cloneDir: string
  let powersyncEndpoint: string
  let powersyncRemoteUrl: string
  const workspaceRoot = fileURLToPath(new URL('../../..', import.meta.url))
  let env: NodeJS.ProcessEnv
  let stackEnv: Record<string, string> | null = null
  let org: string
  let repo: string

  beforeAll(async () => {
    stackEnv = await startStack({ skipDemoSeed: true })
    powersyncEndpoint = process.env.POWERSYNC_DAEMON_URL ?? 'http://127.0.0.1:5030'
    const remoteUrl =
      process.env.POWERGIT_TEST_REMOTE_URL ??
      stackEnv?.POWERGIT_TEST_REMOTE_URL ??
      `powergit::local-dev/demo/infra`
    const parsed = resolvePowergitRemote(remoteUrl)
    org = parsed.org
    repo = parsed.repo
    powersyncRemoteUrl = remoteUrl

    helperDir = await mkdtemp(join(tmpdir(), 'powersync-helper-'))
    await createHelperExecutable(helperDir)

    const debugLogPath = join(helperDir, 'helper-debug.log')
    env = {
      ...process.env,
      PATH: `${helperDir}:${process.env.PATH ?? ''}`,
      POWERSYNC_DAEMON_URL: powersyncEndpoint,
      NODE_PATH: [join(workspaceRoot, 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(':'),
      POWERSYNC_HELPER_DEBUG_LOG: debugLogPath,
      GIT_TRACE: '1',
      GIT_TRACE_PACKET: '1',
    }

    for (const [key, value] of Object.entries(stackEnv ?? {})) {
      if (typeof value === 'string' && !(key in env)) {
        env[key] = value
      }
    }

    repoDir = await mkdtemp(join(tmpdir(), 'powersync-repo-'))
    await runGit(['init'], repoDir, env)
    await runGit(['config', 'user.email', 'ci@example.com'], repoDir, env)
    await runGit(['config', 'user.name', 'CI Bot'], repoDir, env)

    const readmePath = join(repoDir, 'README.md')
    await writeFile(readmePath, '# Hello PowerSync\n')
    await runGit(['add', 'README.md'], repoDir, env)
    await runGit(['commit', '-m', 'Initial import'], repoDir, env)

    await runGit(['remote', 'add', 'powersync', powersyncRemoteUrl], repoDir, env)
  }, 120_000)

  afterAll(async () => {
    await stopStack().catch(() => undefined)
    if (repoDir) await rm(repoDir, { recursive: true, force: true })
    if (cloneDir) await rm(cloneDir, { recursive: true, force: true })
  }, 30_000)

  it('pushes commits and fetches them into a fresh repo', async () => {
    const commitSha = (await runGit(['rev-parse', 'HEAD'], repoDir, env)).stdout.trim()

    const streamTargets = buildRepoStreamTargets(org, repo)
    const streamKeys = streamTargets.map(formatStreamKey)

    const listStreams = async () => {
      const res = await fetch(`${powersyncEndpoint}/streams`).catch(() => null)
      if (!res || !res.ok) return []
      const payload = (await res.json().catch(() => null)) as { streams?: unknown } | null
      if (!payload || !Array.isArray(payload.streams)) return []
      return payload.streams
        .map((entry) => {
          if (typeof entry === 'string') {
            const trimmed = entry.trim()
            return trimmed.length > 0 ? trimmed : null
          }
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
          const record = entry as {
            id?: unknown
            stream?: unknown
            parameters?: unknown
            params?: unknown
          }
          const id =
            typeof record.id === 'string'
              ? record.id
              : typeof record.stream === 'string'
                ? record.stream
                : ''
          const trimmedId = id.trim()
          if (!trimmedId) return null
          const rawParams = record.parameters ?? record.params ?? null
          if (!rawParams || typeof rawParams !== 'object' || Array.isArray(rawParams)) {
            return trimmedId
          }
          return formatStreamKey({ id: trimmedId, parameters: rawParams as any })
        })
        .filter((value): value is string => Boolean(value))
    }

    const initialStreams = await listStreams()
    for (const key of streamKeys) {
      expect(initialStreams).not.toContain(key)
    }

    console.error('[test] before push')
    await runGit(['push', 'powersync', 'HEAD:refs/heads/main'], repoDir, env)
    console.error('[test] after push')

    await waitFor(async () => {
      const current = await listStreams()
      return streamKeys.every((key) => current.includes(key)) ? current : null
    })

    cloneDir = await mkdtemp(join(tmpdir(), 'powersync-clone-'))
    await runGit(['init'], cloneDir, env)
    await runGit(['config', 'user.email', 'ci@example.com'], cloneDir, env)
    await runGit(['config', 'user.name', 'CI Bot'], cloneDir, env)
    await runGit(['remote', 'add', 'powersync', powersyncRemoteUrl], cloneDir, env)

    console.error('[test] before fetch')
    await runGit(['fetch', 'powersync', 'refs/heads/main:refs/remotes/powersync/main'], cloneDir, env)
    console.error('[test] after fetch')
    const fetchedSha = (await runGit(['rev-parse', 'refs/remotes/powersync/main'], cloneDir, env)).stdout.trim()
    expect(fetchedSha).toBe(commitSha)

    await runGit(['checkout', '-b', 'main', fetchedSha], cloneDir, env)
    const readme = await readFile(join(cloneDir, 'README.md'), 'utf8')
    expect(readme).toContain('Hello PowerSync')

    const supabase = getServerSupabaseClient()
    expect(supabase).toBeTruthy()
    await waitFor(async () => {
      const { data, error } = await supabase!
        .from('refs')
        .select('target_sha')
        .eq('org_id', org)
        .eq('repo_id', repo)
        .eq('name', 'refs/heads/main')
        .maybeSingle()
      if (error) return null
      if (!data || !data.target_sha) return null
      return data.target_sha === commitSha ? data : null
    })
    const finalRow = await supabase!
      .from('refs')
      .select('target_sha')
      .eq('org_id', org)
      .eq('repo_id', repo)
      .eq('name', 'refs/heads/main')
      .single()
    expect(finalRow.error).toBeNull()
    expect(finalRow.data?.target_sha).toBe(commitSha)
  }, 120_000)
})
