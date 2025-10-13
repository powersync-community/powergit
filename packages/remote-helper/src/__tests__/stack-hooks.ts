import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..', '..', '..', '..')
const stackManagerScript = resolve(repoRoot, 'scripts', 'dev-local-stack.mjs')

interface StartOptions {
  skipSeeds?: boolean
  skipDemoSeed?: boolean
  skipSyncRules?: boolean
}

const DEFAULT_DAEMON_URL = process.env.POWERSYNC_DAEMON_URL ?? 'http://127.0.0.1:5030'
const DAEMON_START_COMMAND = process.env.POWERSYNC_DAEMON_START_COMMAND ?? 'pnpm --filter @svc/daemon start'
const DAEMON_START_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_START_TIMEOUT_MS ?? '7000', 10)
const DAEMON_SHUTDOWN_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_SHUTDOWN_TIMEOUT_MS ?? '3000', 10)

let stackStarted = false
let daemonProcess: ChildProcess | null = null
let cachedEnv: Record<string, string> | null = null
let daemonUrl = DEFAULT_DAEMON_URL
let cleanupAttached = false

export async function startStack(options: StartOptions = {}): Promise<Record<string, string>> {
  if (stackStarted && cachedEnv) {
    return { ...cachedEnv }
  }

  const args = ['start', '--print-exports', '--no-env-file']
  if (options.skipSeeds) {
    args.push('--skip-seeds')
  } else {
    if (options.skipDemoSeed) args.push('--skip-demo-seed')
    if (options.skipSyncRules) args.push('--skip-sync-rules')
  }

  const previousSkip = process.env.POWERSYNC_SKIP_BINARIES
  process.env.POWERSYNC_SKIP_BINARIES = '1'
  const { stdout } = await runStackManager(args, 'start stack')
  if (previousSkip !== undefined) process.env.POWERSYNC_SKIP_BINARIES = previousSkip
  else delete process.env.POWERSYNC_SKIP_BINARIES
  const envFromStack = parseExportedEnv(stdout)

  for (const [key, value] of Object.entries(envFromStack)) {
    process.env[key] = value
  }

  daemonUrl = process.env.POWERSYNC_DAEMON_URL ?? DEFAULT_DAEMON_URL

  await ensureDaemonRunning()

  stackStarted = true
  cachedEnv = envFromStack

  attachCleanupHook()

  return { ...envFromStack }
}

export async function stopStack(): Promise<void> {
  await stopDaemon()

  if (stackStarted) {
    await runStackManager(['stop'], 'stop stack')
    stackStarted = false
    cachedEnv = null
  }
}

export function getStackEnv(): Record<string, string> | null {
  return cachedEnv ? { ...cachedEnv } : null
}

export function isStackRunning(): boolean {
  return stackStarted
}

async function ensureDaemonRunning(): Promise<void> {
  if (await isDaemonResponsive()) {
    return
  }

  if (!daemonProcess || daemonProcess.exitCode !== null) {
    daemonProcess = spawn(DAEMON_START_COMMAND, {
      cwd: repoRoot,
      shell: true,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    daemonProcess.stdout?.on('data', (chunk) => {
      process.stdout.write(`[daemon] ${chunk}`)
    })
    daemonProcess.stderr?.on('data', (chunk) => {
      process.stderr.write(`[daemon] ${chunk}`)
    })

    daemonProcess.unref()
  }

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await isDaemonResponsive()) {
      return
    }
    await delay(200)
  }

  throw new Error(`PowerSync daemon did not become ready within ${DAEMON_START_TIMEOUT_MS}ms`)
}

async function stopDaemon(): Promise<void> {
  if (!daemonProcess) return

  try {
    await fetchWithTimeout(`${daemonUrl}/shutdown`, { method: 'POST' }, 1500)
  } catch {
    // ignore
  }

  const exitPromise = once(daemonProcess, 'exit').catch(() => undefined)
  const timeoutPromise = delay(DAEMON_SHUTDOWN_TIMEOUT_MS).then(() => undefined)
  await Promise.race([exitPromise, timeoutPromise])

  if (daemonProcess.exitCode === null && daemonProcess.pid) {
    daemonProcess.kill('SIGTERM')
  }

  daemonProcess = null
}

async function isDaemonResponsive(): Promise<boolean> {
  try {
    const response = await fetchWithTimeout(`${daemonUrl}/health`, {}, 1500)
    return response.ok
  } catch {
    return false
  }
}

async function runStackManager(args: string[], label: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [stackManagerScript, ...args], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString()
      stdout += text
      process.stdout.write(`[dev-stack] ${text}`)
    })
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString()
      stderr += text
      process.stderr.write(`[dev-stack] ${text}`)
    })

    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${label} exited with code ${code}\n${stderr || stdout}`))
    })
  })
}

function parseExportedEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {}
  const regex = /^export\s+([A-Z0-9_]+)=(.*)$/gm
  let match: RegExpExecArray | null
  while ((match = regex.exec(output)) !== null) {
    const [, key, rawValue] = match
    try {
      env[key] = JSON.parse(rawValue)
    } catch {
      env[key] = rawValue.replace(/^"+|"+$/g, '')
    }
  }

  if (!env.POWERSYNC_DAEMON_URL) {
    env.POWERSYNC_DAEMON_URL = DEFAULT_DAEMON_URL
  }

  return env
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return response
  } finally {
    clearTimeout(timeout)
  }
}

function attachCleanupHook() {
  if (cleanupAttached) return
  cleanupAttached = true

  const cleanup = async () => {
    await stopDaemon().catch(() => undefined)
  }

  process.once('exit', cleanup)
  process.once('SIGINT', async () => {
    await cleanup()
    process.exit(130)
  })
  process.once('SIGTERM', async () => {
    await cleanup()
    process.exit(143)
  })
}
