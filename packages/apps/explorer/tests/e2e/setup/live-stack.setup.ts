import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, chromium } from '@playwright/test'
import { loadProfileEnvironment } from '@powersync-community/powergit-core/profile-env'

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
const DEFAULT_WEB_HOST = process.env.HOST ?? 'localhost'
const DEFAULT_WEB_PORT = process.env.PORT ?? process.env.VITE_PORT ?? '5191'
const DAEMON_START_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_DAEMON_START_TIMEOUT_MS ?? '60000', 10)

let daemonProc: ReturnType<typeof spawn> | null = null

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

async function waitForDaemonReady(baseUrl: string, timeoutMs: number): Promise<void> {
  const normalized = baseUrl.replace(/\/+$/, '')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${normalized}/auth/status`)
      if (res.ok) {
        const payload = (await res.json()) as { status?: string }
        if (payload?.status === 'ready') {
          return
        }
      }
    } catch {
      // ignore while polling
    }
    await delay(TCP_RETRY_DELAY_MS)
  }
  throw new Error(`Daemon at ${normalized} did not report status=ready within ${timeoutMs}ms`)
}

function parseHostPort(urlString: string, fallbackPort: number): { host: string; port: number } {
  try {
    const url = new URL(urlString)
    const port = url.port ? Number.parseInt(url.port, 10) : fallbackPort
    return { host: url.hostname || '127.0.0.1', port: Number.isFinite(port) ? port : fallbackPort }
  } catch {
    return { host: '127.0.0.1', port: fallbackPort }
  }
}

async function ensureDaemonRunning(profileName: string): Promise<void> {
  const daemonUrl = process.env.POWERSYNC_DAEMON_URL ?? 'http://127.0.0.1:5030'
  const { host, port } = parseHostPort(daemonUrl, 5030)
  if (await checkTcpConnectivity(host, port, TCP_TIMEOUT_MS)) {
    return
  }

  const args = ['dev:daemon', '--', '--profile', profileName]
  daemonProc = spawn('pnpm', args, {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: 'inherit',
  })
  daemonProc.unref()

  const deadline = Date.now() + DAEMON_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await checkTcpConnectivity(host, port, TCP_TIMEOUT_MS)) {
      return
    }
    await delay(TCP_RETRY_DELAY_MS)
  }
  throw new Error(`PowerSync daemon did not start listening on ${host}:${port} within ${DAEMON_START_TIMEOUT_MS}ms`)
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
    await page.addInitScript(() => {
      const globalWindow = window as typeof window & {
        __powersyncForceEnable?: boolean
        __powersyncUseFixturesOverride?: boolean
        __skipSupabaseMock?: boolean
      }
      globalWindow.__powersyncForceEnable = true
      globalWindow.__powersyncUseFixturesOverride = false
      globalWindow.__skipSupabaseMock = true
    })
    await page.goto(deviceUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
    const email = (process.env.SUPABASE_EMAIL ?? '').trim()
    const password = (process.env.SUPABASE_PASSWORD ?? '').trim()

    if (email && password) {
      const emailInput = page.getByPlaceholder('Email')
      const passwordInput = page.getByPlaceholder('Password')
      await emailInput.waitFor({ state: 'visible', timeout: 15_000 })
      await emailInput.fill(email)
      await passwordInput.fill(password)
      await page.getByRole('button', { name: 'Sign In' }).click()
      await page.getByText(/Daemon login in progress/i).waitFor({ timeout: 15_000 }).catch(() => {})
    } else {
      const guestButton = page.getByTestId('guest-continue-button')
      await guestButton.waitFor({ state: 'visible', timeout: 15_000 })
      await guestButton.click()
    }
    await page.waitForTimeout(2_000)
  } finally {
    await context.close()
    await browser.close()
  }
}

async function runDeviceLoginFlow(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const loginProc = spawn('pnpm', ['--filter', '@powersync-community/powergit', 'exec', 'tsx', 'src/bin.ts', 'login'], {
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

    let observedDeviceCode: string | null = null

    loginProc.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      process.stdout.write(text)

      if (automationPromise) return

      const codeMatch = text.match(/Device code:\s*([A-Za-z0-9]+)/)
      if (codeMatch) {
        observedDeviceCode = codeMatch[1] ?? null
      }

      const baseLoginUrl =
        process.env.POWERSYNC_DAEMON_DEVICE_URL ??
        process.env.POWERSYNC_EXPLORER_URL ??
        null

      if (observedDeviceCode && baseLoginUrl) {
        const separator = baseLoginUrl.includes('?') ? '&' : '?'
        const deviceUrl = `${baseLoginUrl}${separator}device_code=${observedDeviceCode}`
        automationPromise = performGuestLogin(deviceUrl).catch((error) => {
          console.error('[live-stack.setup] failed to automate device login', error)
          throw error
        })
      }
    })

    loginProc.on('error', (error) => {
      finalize(error instanceof Error ? error : new Error(String(error)))
    })

    loginProc.on('exit', (code) => {
      if (code === 0) {
        finalize()
      } else {
        finalize(new Error('Command failed (authenticate daemon): pnpm --filter @powersync-community/powergit exec tsx src/bin.ts login'))
      }
    })
  })
}

async function loginDaemonIfNeeded(): Promise<void> {
  const daemonUrl =
    process.env.POWERSYNC_DAEMON_URL ??
    'http://127.0.0.1:5030'
  const daemonBase = daemonUrl.replace(/\/+$/, '')
  const status = await fetch(`${daemonBase}/auth/status`)
    .then(async (res) => (res.ok ? ((await res.json()) as { status?: string; token?: unknown; context?: unknown }) : null))
    .catch(() => null)

  if (status?.status === 'ready') {
    return
  }

  const existingToken = typeof status?.token === 'string' && status.token.trim() ? status.token.trim() : null
  if (status?.status === 'pending' && existingToken) {
    await waitForDaemonReady(daemonBase, STACK_START_TIMEOUT_MS)
    return
  }

  const endpoint = process.env.POWERSYNC_URL ?? process.env.VITE_POWERSYNC_ENDPOINT ?? null
  const context =
    status?.context && typeof status.context === 'object' && !Array.isArray(status.context)
      ? (status.context as Record<string, unknown>)
      : {}
  const initialChallenge =
    context.challengeId ??
    context.deviceCode ??
    (context as { device_code?: unknown }).device_code ??
    (context as { state?: unknown }).state

  let challengeId: string | null =
    typeof initialChallenge === 'string' && initialChallenge.trim() ? initialChallenge.trim() : null

  if (!challengeId) {
    const challengeRes = await fetch(`${daemonBase}/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
    if (!challengeRes.ok) {
      const body = await challengeRes.text().catch(() => '')
      throw new Error(`Failed to request daemon device challenge (${challengeRes.status}): ${body}`)
    }
    const challengePayload = (await challengeRes.json()) as { token?: unknown; context?: unknown }
    const returnedToken =
      typeof challengePayload.token === 'string' && challengePayload.token.trim().length > 0 ? challengePayload.token.trim() : null
    if (returnedToken) {
      await waitForDaemonReady(daemonBase, STACK_START_TIMEOUT_MS)
      return
    }
    const challengeContext =
      challengePayload.context && typeof challengePayload.context === 'object' && !Array.isArray(challengePayload.context)
        ? (challengePayload.context as Record<string, unknown>)
        : {}
    const newChallenge =
      challengeContext.challengeId ??
      challengeContext.deviceCode ??
      (challengeContext as { device_code?: unknown }).device_code ??
      (challengeContext as { state?: unknown }).state
    if (typeof newChallenge === 'string' && newChallenge.trim()) {
      challengeId = newChallenge.trim()
    }
  }

  if (!challengeId) {
    throw new Error('Daemon did not provide a device challenge for login.')
  }

  const supabaseUrl = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? '').replace(/\/+$/, '')
  const anonKey = (process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? '').trim()
  const email = (process.env.SUPABASE_EMAIL ?? '').trim()
  const password = (process.env.SUPABASE_PASSWORD ?? '').trim()
  if (!supabaseUrl || !anonKey || !email || !password) {
    throw new Error('Supabase credentials are required to authenticate the daemon in tests.')
  }

  const tokenRes = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '')
    throw new Error(`Failed to sign into Supabase for daemon login (${tokenRes.status}): ${body}`)
  }
  const tokenPayload = (await tokenRes.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    expires_at?: number
  }
  const accessToken = tokenPayload.access_token?.trim() ?? ''
  const refreshToken = tokenPayload.refresh_token?.trim() ?? ''
  if (!accessToken || !refreshToken) {
    throw new Error('Supabase did not return a valid session for daemon login.')
  }
  const authRes = await fetch(`${daemonBase}/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId,
      endpoint,
      session: {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: tokenPayload.expires_in ?? null,
        expires_at: tokenPayload.expires_at ?? null,
      },
    }),
  })
  if (!authRes.ok) {
    const body = await authRes.text().catch(() => '')
    throw new Error(`Daemon rejected device login (${authRes.status}): ${body}`)
  }

  await waitForDaemonReady(daemonBase, STACK_START_TIMEOUT_MS)
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
    const current = process.env[key]
    if (!current || current.trim().length === 0) {
      process.env[key] = value
    }
  }

  ensureDeviceLoginUrl()
}

function ensureDeviceLoginUrl(): void {
  const host = DEFAULT_WEB_HOST.trim().length > 0 ? DEFAULT_WEB_HOST : 'localhost'
  const port = DEFAULT_WEB_PORT && DEFAULT_WEB_PORT.trim().length > 0 ? DEFAULT_WEB_PORT : '5191'
  const desired = `http://${host}:${port}/auth`
  const current = process.env.POWERSYNC_DAEMON_DEVICE_URL

  if (!current || current.trim().length === 0) {
    process.env.POWERSYNC_DAEMON_DEVICE_URL = desired
    return
  }

  try {
    const currentUrl = new URL(current)
    const desiredUrl = new URL(desired)
    if (currentUrl.host !== desiredUrl.host || currentUrl.pathname !== desiredUrl.pathname) {
      process.env.POWERSYNC_DAEMON_DEVICE_URL = desired
    }
  } catch {
    process.env.POWERSYNC_DAEMON_DEVICE_URL = desired
  }
}

function shouldManageLocalStack(): boolean {
  const profileName = process.env.STACK_PROFILE ?? 'local-dev'
  if (profileName === 'local-dev') return true
  const supabaseUrl = (process.env.SUPABASE_URL ?? '').toLowerCase()
  if (supabaseUrl.includes('127.0.0.1') || supabaseUrl.includes('localhost')) {
    return true
  }
  return false
}

test.describe('PowerSync dev stack (live)', () => {
  test('ensure stack is running', async () => {
    test.setTimeout(STACK_START_TIMEOUT_MS)
    applyProfileEnvironment()

    if (shouldManageLocalStack() && !(await isStackRunning())) {
      runCommand(START_COMMAND[0]!, START_COMMAND.slice(1), 'start dev stack')
      await waitForStackReady(STACK_START_TIMEOUT_MS)
    }

    await ensureDaemonRunning(process.env.STACK_PROFILE ?? 'local-dev')
    await loginDaemonIfNeeded()
  })
})
