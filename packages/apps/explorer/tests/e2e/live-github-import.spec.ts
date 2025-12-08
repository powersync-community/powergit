import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from '@playwright/test'
import { test, expect } from './diagnostics'
import { BASE_URL } from '../../playwright.config'
import { loadProfileEnvironment } from '../../../../cli/src/profile-env.js'

const WAIT_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_E2E_WAIT_MS ?? '300000', 10)
const WAIT_INTERVAL_MS = Number.parseInt(process.env.POWERSYNC_E2E_POLL_MS ?? '1500', 10)
const FAIL_FAST_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_E2E_FAIL_FAST_MS ?? '20000', 10)

const GITHUB_REPO_URL = 'https://github.com/quantleaf/probly-search'
const POWERSYNC_ORG = 'quantleaf'
const POWERSYNC_REPO = 'probly-search'

const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_EMAIL',
  'SUPABASE_PASSWORD',
  'POWERSYNC_URL',
  'POWERSYNC_DAEMON_URL',
]

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..', '..', '..', '..')

function hydrateProfileEnv() {
  const profileOverride = process.env.STACK_PROFILE ?? null
  const profileResult = loadProfileEnvironment({
    profile: profileOverride,
    startDir: repoRoot,
    updateState: false,
    strict: Boolean(profileOverride),
  })
  for (const [key, value] of Object.entries(profileResult.combinedEnv)) {
    const current = process.env[key]
    if (!current || !current.trim()) {
      process.env[key] = value
    }
  }
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '')
}

async function delay(ms: number) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function waitForDaemonReady(baseUrl: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${normalizeBaseUrl(baseUrl)}/auth/status`)
      if (res.ok) {
        const payload = (await res.json()) as { status?: string }
        if (payload?.status === 'ready') {
          return
        }
      }
    } catch {
      // swallow errors while polling
    }
    await delay(WAIT_INTERVAL_MS)
  }
  throw new Error(`Daemon at ${baseUrl} did not report status=ready within ${timeoutMs}ms`)
}

async function waitForRepoSeed(baseUrl: string, orgId: string, repoId: string, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${normalizeBaseUrl(baseUrl)}/orgs/${encodeURIComponent(orgId)}/repos/${encodeURIComponent(repoId)}/summary`,
      )
      if (res.ok) {
        const summary = (await res.json()) as { counts?: Record<string, number> }
        const counts = summary?.counts ?? {}
        if ((counts.refs ?? 0) > 0 || (counts.commits ?? 0) > 0) {
          return
        }
      }
    } catch {
      // ignore and retry
    }
    await delay(WAIT_INTERVAL_MS)
  }
  throw new Error(`Repository ${orgId}/${repoId} did not report data within ${timeoutMs}ms`)
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) {
    console.error(`[live-github-import] missing environment variable ${name}`)
    throw new Error(`Environment variable ${name} is required for live PowerSync tests.`)
  }
  return value.trim()
}

type CliCommandOptions = {
  tolerateFailure?: boolean
}

function runCliCommand(args: string[], label: string, options: CliCommandOptions = {}) {
  const result = spawnSync('pnpm', ['--filter', '@pkg/cli', 'exec', 'tsx', 'src/bin.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    if (options.tolerateFailure) {
      return
    }
    throw new Error(`CLI command failed (${label}): pnpm --filter @pkg/cli exec tsx src/bin.ts ${args.join(' ')}`)
  }
}

function resetDaemonSession() {
  try {
    runCliCommand(['logout'], 'clear daemon session', { tolerateFailure: true })
  } catch {
    // ignore failures when daemon is already logged out
  }
}

async function readPowerSyncStatus(page: Page) {
  return page.evaluate(() => {
    const global = window as typeof window & {
      __powersyncDb?: {
        currentStatus?:
          | {
              toJSON?: () => unknown
              downloadError?: { name?: string; message?: string; stack?: string; cause?: unknown } | null
            }
          | undefined
      }
    }
    const status = global.__powersyncDb?.currentStatus ?? null
    if (status && typeof status === 'object' && typeof (status as { toJSON?: () => unknown }).toJSON === 'function') {
      try {
        const plain = (status as { toJSON: () => unknown }).toJSON() as Record<string, unknown>
        const downloadError = (status as { downloadError?: Record<string, unknown> | null }).downloadError ?? null
        if (downloadError && typeof downloadError === 'object') {
          plain.downloadError = {
            name: (downloadError as { name?: unknown }).name ?? null,
            message: (downloadError as { message?: unknown }).message ?? null,
            stack: (downloadError as { stack?: unknown }).stack ?? null,
            cause: (downloadError as { cause?: unknown }).cause ?? null,
            keys: Object.keys(downloadError as Record<string, unknown>),
          }
        }
        return plain
      } catch (error) {
        return {
          raw: status,
          error: error instanceof Error ? error.message : String(error),
          downloadError:
            typeof status === 'object' && status && 'downloadError' in status
              ? (status as { downloadError?: unknown }).downloadError ?? null
              : null,
        }
      }
    }
    return status
  })
}

async function waitForPowerSyncConnected(page: Page, timeoutMs: number, intervalMs: number) {
  const deadline = Date.now() + timeoutMs
  let lastStatus: unknown = null
  while (Date.now() < deadline) {
    lastStatus = await readPowerSyncStatus(page)
    const isConnected = Boolean(lastStatus && typeof lastStatus === 'object' && (lastStatus as { connected?: unknown }).connected)
    if (isConnected) {
      return lastStatus
    }
    await page.waitForTimeout(intervalMs)
  }
  throw new Error(
    `PowerSync did not report connected=true within ${timeoutMs}ms. Last observed status: ${JSON.stringify(lastStatus)}`,
  )
}

test.describe('Explorer GitHub import (live PowerSync)', () => {
  let supabaseEmail: string
  let supabasePassword: string
  let daemonBaseUrl: string

  test.beforeEach(async ({ page }) => {
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
  })

  test.beforeAll(async () => {
    hydrateProfileEnv()
    resetDaemonSession()
    REQUIRED_ENV_VARS.forEach(requireEnv)

    supabaseEmail = requireEnv('SUPABASE_EMAIL')
    supabasePassword = requireEnv('SUPABASE_PASSWORD')
    daemonBaseUrl = normalizeBaseUrl(requireEnv('POWERSYNC_DAEMON_URL'))

    runCliCommand(['login', '--guest'], 'authenticate daemon (guest)')
    await waitForDaemonReady(daemonBaseUrl, WAIT_TIMEOUT_MS)
  })

  test('imports a public GitHub repository via explorer UI', async ({ page }) => {
    test.setTimeout(WAIT_TIMEOUT_MS)

    await page.goto(`${BASE_URL}/auth`)
    await expect(page.getByTestId('auth-heading')).toBeVisible()

    await page.getByPlaceholder('Email').fill(supabaseEmail)
    await page.getByPlaceholder('Password').fill(supabasePassword)
    await page.getByRole('button', { name: 'Sign In' }).click()

    await page.waitForURL(/\/$/, { timeout: WAIT_TIMEOUT_MS })
    await expect(page.getByTestId('github-import-heading')).toBeVisible()

    await page.getByTestId('github-import-url').fill(GITHUB_REPO_URL)
    await page.getByTestId('github-import-org').fill(POWERSYNC_ORG)
    await page.getByTestId('github-import-repo').fill(POWERSYNC_REPO)
    await page.getByTestId('github-import-submit').click()

    const statusCard = page.getByTestId('github-import-status')
    await expect(statusCard).toBeVisible({ timeout: WAIT_TIMEOUT_MS })

    await expect(statusCard).toHaveAttribute('data-status', 'success', { timeout: WAIT_TIMEOUT_MS })
    await expect(page.getByTestId('github-import-success')).toBeVisible({ timeout: WAIT_TIMEOUT_MS })

    const openRepoLink = page.getByTestId('github-import-open-repo')
    await expect(openRepoLink).toBeVisible({ timeout: WAIT_TIMEOUT_MS })

    await waitForRepoSeed(daemonBaseUrl, POWERSYNC_ORG, POWERSYNC_REPO, WAIT_TIMEOUT_MS)

    await openRepoLink.click()
    await page.waitForURL(new RegExp(`/org/${POWERSYNC_ORG}/repo/${POWERSYNC_REPO}`), { timeout: WAIT_TIMEOUT_MS })

    const branchesTab = page.getByRole('link', { name: /branches/i })
    if (await branchesTab.count()) {
      await branchesTab.first().click()
    } else {
      await page.goto(`${BASE_URL}/org/${POWERSYNC_ORG}/repo/${POWERSYNC_REPO}/branches`, {
        timeout: WAIT_TIMEOUT_MS,
      })
    }

    await expect(page.getByTestId('branch-heading')).toBeVisible({ timeout: WAIT_TIMEOUT_MS })

    const failFastTimeout = Math.min(FAIL_FAST_TIMEOUT_MS, WAIT_TIMEOUT_MS)
    const powerSyncStatus = await waitForPowerSyncConnected(page, failFastTimeout, WAIT_INTERVAL_MS)
    console.log('[live-github-import] PowerSync status snapshot:', powerSyncStatus)

    const branchItems = page.getByTestId('branch-item')
    await page.waitForFunction(
      () => {
        const items = Array.from(document.querySelectorAll('[data-testid="branch-item"]'))
        return items.some((item) => {
          const text = item.textContent ?? ''
          return text.includes('main') || text.includes('master')
        })
      },
      undefined,
      { timeout: failFastTimeout },
    )
    await expect(branchItems.first()).toBeVisible()

    await page.goto(`${BASE_URL}/org/${POWERSYNC_ORG}/repo/${POWERSYNC_REPO}/files`, {
      timeout: WAIT_TIMEOUT_MS,
    })
    const fileTree = page.getByTestId('file-explorer-tree')
    await expect(fileTree).toContainText('README.md', { timeout: WAIT_TIMEOUT_MS })

    const readmeEntry = page.getByTestId('file-tree-file').filter({ hasText: 'README.md' }).first()
    await readmeEntry.click()

    await expect(page.getByTestId('file-viewer-header')).toContainText('README.md', {
      timeout: WAIT_TIMEOUT_MS,
    })
    const viewerLines = page.locator('[data-testid="file-viewer"] .view-lines')
    await expect(viewerLines).toContainText('A full-text search library', { timeout: WAIT_TIMEOUT_MS })

    await page.reload({ timeout: WAIT_TIMEOUT_MS })
    await waitForPowerSyncConnected(page, failFastTimeout, WAIT_INTERVAL_MS)
    await expect(fileTree).toContainText('README.md', { timeout: WAIT_TIMEOUT_MS })

    const readmeEntryAfterReload = page.getByTestId('file-tree-file').filter({ hasText: 'README.md' }).first()
    await readmeEntryAfterReload.click()
    await expect(page.getByTestId('file-viewer-header')).toContainText('README.md', {
      timeout: WAIT_TIMEOUT_MS,
    })
    await expect(viewerLines).toContainText('A full-text search library', { timeout: WAIT_TIMEOUT_MS })
  })
})
