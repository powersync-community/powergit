import { defineConfig, devices } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadProfileEnvironment } from '@powersync-community/powergit-core/profile-env'

// Use a dedicated port to avoid clashing with local dev server defaults
const PORT = Number(process.env.PORT || 5191)
const HOST = process.env.HOST || 'localhost'
const BASE_HTTP = `http://${HOST}:${PORT}`
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..', '..', '..')

const isPlaceholder = (value?: string | null) => {
  if (typeof value !== 'string') return true
  return value.trim().length === 0
}

const ensureE2eHome = () => {
  const existing = process.env.POWERGIT_HOME
  if (existing && existing.trim().length > 0) return existing.trim()
  const dir = mkdtempSync(join(tmpdir(), 'powergit-explorer-e2e-'))
  process.env.POWERGIT_HOME = dir
  return dir
}

const stripQuotes = (value?: string) => {
  if (!value) return value
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function parseExportedEnv(output: string): Record<string, string> {
  const env: Record<string, string> = {}
  const regex = /^export\s+([A-Z0-9_]+)=(.*)$/gm
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(output)) !== null) {
    const key = match[1]
    const rawValue = match[2]
    if (!key || rawValue == null) continue
    try {
      env[key] = JSON.parse(rawValue) as string
    } catch {
      env[key] = rawValue.replace(/^"+|"+$/g, '')
    }
  }
  return env
}

const ensureLocalStackEnv = () => {
  const explicitProfile = (process.env.STACK_PROFILE ?? '').trim()
  const desiredProfile = explicitProfile || 'local-dev'
  if (!explicitProfile) {
    process.env.STACK_PROFILE = desiredProfile
  }

  if (desiredProfile === 'local-dev') {
    ensureE2eHome()
  }

  let profileEnv = loadProfileEnvironment({
    profile: desiredProfile,
    startDir: repoRoot,
    updateState: false,
    strict: Boolean(explicitProfile),
  })
  const applyCombinedEnv = (combinedEnv: Record<string, string>) => {
    for (const [key, value] of Object.entries(combinedEnv)) {
      if (isPlaceholder(process.env[key])) {
        process.env[key] = value
      }
    }
  }
  applyCombinedEnv(profileEnv.combinedEnv)

  const requiredLiveEnv = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_EMAIL',
    'SUPABASE_PASSWORD',
    'POWERSYNC_URL',
    'POWERSYNC_DAEMON_URL',
    'POWERGIT_TEST_REMOTE_URL',
  ]
  const missingLive = requiredLiveEnv.filter((name) => isPlaceholder(process.env[name]))

  if (missingLive.length === 0 || desiredProfile !== 'local-dev') {
    return
  }

  const scriptPath = resolve(repoRoot, 'scripts', 'dev-local-stack.mjs')
  const result = spawnSync(process.execPath, [scriptPath, 'start', '--print-exports'], {
    cwd: repoRoot,
    env: { ...process.env, STACK_PROFILE: desiredProfile },
    encoding: 'utf8',
  })
  if (result.status !== 0) {
    const stderr = typeof result.stderr === 'string' ? result.stderr : ''
    throw new Error(
      `[playwright] Failed to start local PowerSync stack for live e2e (missing: ${missingLive.join(', ')}).${stderr ? `\n${stderr}` : ''}`,
    )
  }

  const exportedEnv = parseExportedEnv(typeof result.stdout === 'string' ? result.stdout : '')
  for (const [key, value] of Object.entries(exportedEnv)) {
    process.env[key] = value
  }

  profileEnv = loadProfileEnvironment({
    profile: desiredProfile,
    startDir: repoRoot,
    updateState: false,
    strict: Boolean(explicitProfile),
  })
  applyCombinedEnv(profileEnv.combinedEnv)
}

ensureLocalStackEnv()

const profileEnv = loadProfileEnvironment({
  startDir: repoRoot,
  updateState: false,
})
const combinedEnv = profileEnv.combinedEnv

const getEnvOrEmpty = (...keys: string[]) => {
  for (const key of keys) {
    const value = stripQuotes(process.env[key])
    if (value && !isPlaceholder(value)) {
      return value
    }
    const profileValue = stripQuotes(combinedEnv[key])
    if (profileValue && !isPlaceholder(profileValue)) {
      return profileValue
    }
  }
  return ''
}

const SUPABASE_URL = getEnvOrEmpty('VITE_SUPABASE_URL', 'SUPABASE_URL') || 'https://example.supabase.co'
const SUPABASE_ANON_KEY = getEnvOrEmpty('VITE_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY') || 'test-anon-key'

const TEST_TIMEOUT_MS = 30_000
const LIVE_TEST_TIMEOUT_MS = Number(process.env.POWERSYNC_E2E_LIVE_TIMEOUT_MS ?? (process.env.CI ? 600_000 : 120_000))
export const BASE_URL = BASE_HTTP

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: TEST_TIMEOUT_MS,
  testIgnore: ['../third_party/**'],

  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: BASE_HTTP,
    actionTimeout: TEST_TIMEOUT_MS,
    navigationTimeout: TEST_TIMEOUT_MS,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'setup-live',
      testMatch: /tests\/e2e\/setup\/live-stack\.setup\.ts/,
    },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [/tests\/e2e\/setup\/.*/, /tests\/e2e\/live-.*\.spec\.ts/],
    },
    {
      name: 'chromium-live',
      timeout: LIVE_TEST_TIMEOUT_MS,
      use: { ...devices['Desktop Chrome'], },
      testMatch: /tests\/e2e\/live-.*\.spec\.ts/,
      dependencies: ['setup-live'],
      
      
    },
  ],
  webServer: {
    // Spawn Vite via pnpm so the workspace-local version is used
    command: `pnpm exec vite --host ${HOST} --port ${PORT}`,
    url: BASE_HTTP,
    reuseExistingServer: true,
    cwd: resolve(__dirname),
    env: {
      ...process.env,
      VITE_POWERSYNC_DISABLED: process.env.VITE_POWERSYNC_DISABLED ?? 'true',
      VITE_POWERSYNC_USE_FIXTURES: process.env.VITE_POWERSYNC_USE_FIXTURES ?? 'true',
      VITE_POWERSYNC_USE_DAEMON: process.env.VITE_POWERSYNC_USE_DAEMON ?? 'true',
      VITE_POWERSYNC_REQUIRE_VAULT: process.env.VITE_POWERSYNC_REQUIRE_VAULT ?? 'false',
      VITE_DISABLE_STRICT_MODE: process.env.VITE_DISABLE_STRICT_MODE ?? 'true',
      VITE_SUPABASE_URL: SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    },
  },
  expect: {
    timeout: 10_000,
  },
  workers: 1
})
