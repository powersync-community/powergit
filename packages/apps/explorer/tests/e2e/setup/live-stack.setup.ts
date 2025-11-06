import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, chromium } from '@playwright/test'
import { loadProfileEnvironment } from '../../../../../cli/src/profile-env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(process.cwd(), '../../..')

const STACK_HOST = process.env.POWERSYNC_STACK_HOST ?? '127.0.0.1'
const STACK_PORT = Number.parseInt(process.env.POWERSYNC_STACK_PORT ?? '55431', 10)
const START_COMMAND = (process.env.POWERSYNC_STACK_START ?? 'pnpm dev:stack:up').split(/\s+/)
const STOP_COMMAND = (process.env.POWERSYNC_STACK_STOP ?? 'pnpm dev:stack stop').split(/\s+/)
if (!START_COMMAND[0]) {
  throw new Error('Invalid POWERSYNC_STACK_START command.')
}
if (!STOP_COMMAND[0]) {
  throw new Error('Invalid POWERSYNC_STACK_STOP command.')
}
const TCP_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_STACK_PROBE_TIMEOUT_MS ?? '1000', 10)
const TCP_RETRY_DELAY_MS = Number.parseInt(process.env.POWERSYNC_STACK_RETRY_DELAY_MS ?? '1000', 10)
const STACK_START_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_STACK_START_TIMEOUT_MS ?? '120000', 10)

async function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

function checkTcpConnectivity(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    let settled = false

    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }

    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

async function isStackRunning(): Promise<boolean> {
  return checkTcpConnectivity(STACK_HOST, STACK_PORT, TCP_TIMEOUT_MS)
}

async function waitForStackReady(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await isStackRunning()) {
      return
    }
    await delay(TCP_RETRY_DELAY_MS)
  }
  throw new Error(`PowerSync dev stack did not become ready within ${timeoutMs}ms (host ${STACK_HOST}, port ${STACK_PORT})`)
}

function runCommand(command: string, args: string[], label: string): void {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    throw new Error(`Command failed (${label}): ${command} ${args.join(' ')}`)
  }
}

async function performGuestLogin(deviceUrl: string): Promise<void> {
  const browser = await chromium.launch()
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    await page.goto(deviceUrl, { waitUntil: 'networkidle' })
    const guestButton = page.getByTestId('guest-continue-button')
    await guestButton.waitFor({ state: 'visible', timeout: 15_000 })
    await guestButton.click()
    await page.waitForTimeout(2_000)
  } finally {
    await context.close()
    await browser.close()
  }
}

async function runDeviceLoginFlow(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const loginProc = spawn('pnpm', ['--filter', '@pkg/cli', 'exec', 'tsx', 'src/bin.ts', 'login'], {
      cwd: repoRoot,
      env: { ...process.env },
      stdio: ['inherit', 'pipe', 'inherit'],
    })

    let automationPromise: Promise<void> | null = null
    let finished = false

    const finalize = (error?: Error) => {
      if (finished) return
      finished = true
      const complete = () => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      }
      if (automationPromise) {
        automationPromise.then(complete).catch(reject)
      } else {
        complete()
      }
    }

    loginProc.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      process.stdout.write(text)
      if (!automationPromise) {
        const urlMatch = text.match(/Open:\s+(https?:\/\/\S+)/)
        if (urlMatch) {
          const deviceUrl = urlMatch[1]
          automationPromise = performGuestLogin(deviceUrl).catch((error) => {
            console.error('[live-stack.setup] failed to automate device login', error)
            throw error
          })
        }
      }
    })

    loginProc.on('error', (error) => {
      finalize(error instanceof Error ? error : new Error(String(error)))
    })

    loginProc.on('exit', (code) => {
      if (code === 0) {
        finalize()
      } else {
        finalize(new Error('Command failed (authenticate daemon): pnpm --filter @pkg/cli exec tsx src/bin.ts login'))
      }
    })
  })
}

async function loginDaemonIfNeeded(): Promise<void> {
  const daemonUrl =
    process.env.POWERSYNC_DAEMON_URL ??
    process.env.POWERSYNC_DAEMON_ENDPOINT ??
    'http://127.0.0.1:5030'
  const status = await fetch(`${daemonUrl.replace(/\/+$/, '')}/auth/status`)
    .then(async (res) => (res.ok ? ((await res.json()) as { status?: string }) : null))
    .catch(() => null)
  if (status?.status === 'ready') {
    return
  }
  await runDeviceLoginFlow()
}

function applyProfileEnvironment(): void {
  const profileOverride = process.env.STACK_PROFILE ?? null
  const profileResult = loadProfileEnvironment({
    profile: profileOverride,
    startDir: repoRoot,
    updateState: false,
    strict: Boolean(profileOverride),
  })
  for (const [key, value] of Object.entries(profileResult.combinedEnv)) {
    if (!(key in process.env)) {
      process.env[key] = value
    }
  }
}

function shouldManageLocalStack(): boolean {
  const profileName = process.env.STACK_PROFILE ?? 'local-dev'
  if (profileName === 'local-dev') return true
  const supabaseUrl = (process.env.POWERSYNC_SUPABASE_URL ?? '').toLowerCase()
  if (supabaseUrl.includes('127.0.0.1') || supabaseUrl.includes('localhost')) {
    return true
  }
  return false
}

test.describe('PowerSync dev stack (live)', () => {
  let startedBySuite = false

  test('ensure stack is running', async () => {
    applyProfileEnvironment()
    await loginDaemonIfNeeded()

    if (!shouldManageLocalStack()) {
      return
    }

    if (!(await isStackRunning())) {
      runCommand(START_COMMAND[0]!, START_COMMAND.slice(1), 'start dev stack')
      await waitForStackReady(STACK_START_TIMEOUT_MS)
      startedBySuite = true
    }
  })

  test.afterAll(async () => {
    if (!startedBySuite) return
    runCommand(STOP_COMMAND[0]!, STOP_COMMAND.slice(1), 'stop dev stack')
  })
})
