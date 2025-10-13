import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { startStack, stopStack } from './__tests__/stack-hooks.js'
import { getServerSupabaseClient, parsePowerSyncUrl } from '@shared/core'

const execFileAsync = promisify(execFile)

async function runGit(args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return execFileAsync('git', args, { cwd, env })
}

const requireForTests = createRequire(import.meta.url)
const tsxEsmPath = requireForTests.resolve('tsx/esm')

async function createHelperExecutable(dir: string): Promise<string> {
  const helperPath = join(dir, 'git-remote-powersync')
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

describe('git push/fetch via PowerSync remote helper', () => {
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
      process.env.PSGIT_TEST_REMOTE_URL ??
      stackEnv?.PSGIT_TEST_REMOTE_URL ??
      `powersync::${powersyncEndpoint}/orgs/demo/repos/infra`
    const parsed = parsePowerSyncUrl(remoteUrl)
    org = parsed.org
    repo = parsed.repo
    powersyncRemoteUrl = `powersync::${powersyncEndpoint}/orgs/${org}/repos/${repo}`

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

    console.error('[test] before push')
    await runGit(['push', 'powersync', 'HEAD:refs/heads/main'], repoDir, env)
    console.error('[test] after push')

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
    const { data: refRow, error: refError } = await supabase!
      .from('refs')
      .select('target_sha')
      .eq('org_id', org)
      .eq('repo_id', repo)
      .eq('name', 'refs/heads/main')
      .single()
    expect(refError).toBeNull()
    expect(refRow?.target_sha).toBe(commitSha)
  }, 60_000)
})
