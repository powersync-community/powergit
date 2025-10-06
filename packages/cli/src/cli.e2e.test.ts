import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const binPath = fileURLToPath(new URL('./bin.ts', import.meta.url))
const require = createRequire(import.meta.url)
const tsxImport = pathToFileURL(require.resolve('tsx/esm')).href

async function runGit(args: string[], cwd: string) {
  return execFileAsync('git', args, { cwd })
}

describe('psgit CLI e2e', () => {
  let repoDir: string

  beforeEach(async () => {
    repoDir = await mkdtemp(join(tmpdir(), 'psgit-e2e-'))
    await runGit(['init'], repoDir)
  })

  afterEach(async () => {
    if (repoDir) {
      await rm(repoDir, { recursive: true, force: true })
    }
  })

  async function runCli(args: string[], env: NodeJS.ProcessEnv = {}) {
    const result = await execFileAsync(
      'node',
      ['--import', tsxImport, binPath, ...args],
      {
        cwd: repoDir,
        env: { ...process.env, ...env },
      }
    )
    return result
  }

  async function getRemoteUrl(name = 'origin') {
    const { stdout } = await runGit(['remote', 'get-url', name], repoDir)
    return stdout.trim()
  }

  it('adds and updates the default powersync remote', async () => {
    const firstUrl = 'powersync::https://example.dev/orgs/acme/repos/infra'
    const { stdout: addStdout } = await runCli(['remote', 'add', 'powersync', firstUrl])
    expect(addStdout).toContain(`Added PowerSync remote (origin): ${firstUrl}`)

    expect(await getRemoteUrl()).toBe(firstUrl)

    const secondUrl = 'powersync::https://example.dev/orgs/acme/repos/runtime'
    const { stdout: updateStdout } = await runCli(['remote', 'add', 'powersync', secondUrl])
    expect(updateStdout).toContain(`Added PowerSync remote (origin): ${secondUrl}`)

    expect(await getRemoteUrl()).toBe(secondUrl)
  })

  it('respects REMOTE_NAME overrides', async () => {
    const customRemote = 'powersync-upstream'
    const remoteUrl = 'powersync::https://example.dev/orgs/acme/repos/mobile'

    const { stdout } = await runCli(
      ['remote', 'add', 'powersync', remoteUrl],
      { REMOTE_NAME: customRemote }
    )

    expect(stdout).toContain(`Added PowerSync remote (${customRemote}): ${remoteUrl}`)
    expect(await getRemoteUrl(customRemote)).toBe(remoteUrl)
  })

  it('prints usage help for unknown commands', async () => {
    const { stdout } = await runCli([])
    expect(stdout).toContain('psgit commands:')
    expect(stdout).toContain('psgit remote add powersync')

    const { stdout: unknownStdout } = await runCli(['status'])
    expect(unknownStdout).toContain('psgit commands:')
  })

  it('exits with usage instructions when url is missing', async () => {
    try {
      await runCli(['remote', 'add', 'powersync'])
      throw new Error('expected CLI command to fail without URL')
    } catch (error) {
      const execError = error as NodeJS.ErrnoException & { stderr?: string }
      expect(execError.code).toBe(2)
      expect(execError.stderr ?? '').toContain('Usage: psgit remote add powersync')
    }
  })
})
