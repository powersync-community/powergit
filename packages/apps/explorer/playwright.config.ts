import { defineConfig, devices } from '@playwright/test'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Use a dedicated port to avoid clashing with local dev server defaults
const PORT = Number(process.env.PORT || 5191)
const HOST = process.env.HOST || 'localhost'
const BASE_HTTP = `http://${HOST}:${PORT}`
const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const stripQuotes = (value?: string) => {
  if (!value) return value
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

const getEnvOrEmpty = (...keys: string[]) => {
  for (const key of keys) {
    const value = stripQuotes(process.env[key])
    if (value) return value
  }
  return ''
}

const SUPABASE_URL = getEnvOrEmpty('VITE_SUPABASE_URL', 'POWERSYNC_SUPABASE_URL')
const SUPABASE_ANON_KEY = getEnvOrEmpty('VITE_SUPABASE_ANON_KEY', 'POWERSYNC_SUPABASE_ANON_KEY')

const TEST_TIMEOUT_MS = 30_000
export const BASE_URL = BASE_HTTP

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  timeout: TEST_TIMEOUT_MS,

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
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Spawn Vite via pnpm so the workspace-local version is used
    command: `pnpm exec vite --host ${HOST} --port ${PORT}`,
    url: BASE_HTTP,
    reuseExistingServer: false,
    cwd: resolve(__dirname),
    env: {
      ...process.env,
  VITE_POWERSYNC_DISABLED: process.env.VITE_POWERSYNC_DISABLED ?? 'false',
      VITE_POWERSYNC_USE_FIXTURES: process.env.VITE_POWERSYNC_USE_FIXTURES ?? 'true',
      VITE_SUPABASE_URL: SUPABASE_URL,
      VITE_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    },
  },
  expect: {
    timeout: 10_000,
  },
  workers: 1
})
