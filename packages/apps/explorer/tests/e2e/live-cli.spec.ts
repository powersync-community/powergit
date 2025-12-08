import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { test, expect } from './diagnostics'
import { BASE_URL } from '../../playwright.config'
import { parsePowerSyncUrl } from '@shared/core'
import { loadProfileEnvironment } from '../../../../cli/src/profile-env.js'

const WAIT_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_E2E_WAIT_MS ?? '300000', 10)
const WAIT_INTERVAL_MS = Number.parseInt(process.env.POWERSYNC_E2E_POLL_MS ?? '1500', 10)
const FAIL_FAST_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_E2E_FAIL_FAST_MS ?? '20000', 10)

interface DaemonBranch {
  name: string
  targetSha: string | null
  updatedAt: string | null
}

const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_EMAIL',
  'SUPABASE_PASSWORD',
  'POWERSYNC_ENDPOINT',
  'POWERSYNC_DAEMON_URL',
  'PSGIT_TEST_REMOTE_URL',
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

function sanitizeBranchList(rows: Array<Record<string, unknown>> | undefined | null): DaemonBranch[] {
  if (!rows || rows.length === 0) return []
  const seen = new Set<string>()
  const branches: DaemonBranch[] = []
  for (const entry of rows) {
    const rawName = typeof entry?.name === 'string' ? entry.name : ''
    if (!rawName.startsWith('refs/heads/')) continue
    const name = rawName.replace(/^refs\/heads\//, '').trim()
    if (!name || seen.has(name)) continue
    seen.add(name)
    const target = typeof entry?.target_sha === 'string' && entry.target_sha.trim().length > 0 ? entry.target_sha.trim() : null
    const updated =
      typeof entry?.updated_at === 'string' && entry.updated_at.trim().length > 0 ? entry.updated_at.trim() : null
    branches.push({
      name,
      targetSha: target,
      updatedAt: updated,
    })
  }
  branches.sort((a, b) => a.name.localeCompare(b.name))
  return branches
}


async function fetchDaemonBranches(baseUrl: string, orgId: string, repoId: string): Promise<DaemonBranch[]> {
  const url = `${normalizeBaseUrl(baseUrl)}/orgs/${encodeURIComponent(orgId)}/repos/${encodeURIComponent(repoId)}/refs`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Failed to fetch refs from daemon (${res.status} ${res.statusText})`)
  }
  const json = (await res.json()) as { refs?: Array<Record<string, unknown>> }
  return sanitizeBranchList(json.refs ?? [])
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) {
    console.error(`[live-cli] missing environment variable ${name}`)
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
    // ignore failures when daemon already logged out
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
      const res = await fetch(`${normalizeBaseUrl(baseUrl)}/orgs/${encodeURIComponent(orgId)}/repos/${encodeURIComponent(repoId)}/summary`)
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
    if (lastStatus && typeof lastStatus === 'object') {
      const downloadError = (lastStatus as { downloadError?: Record<string, unknown> | null }).downloadError ?? null
      if (downloadError && typeof downloadError === 'object') {
        console.log('[live-cli] PowerSync downloadError snapshot:', downloadError)
      }
    }
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

test.describe('CLI-seeded repo (live PowerSync)', () => {
  let supabaseEmail: string
  let supabasePassword: string
  let daemonBaseUrl: string
  let orgId: string
  let repoId: string
  let expectedBranches: DaemonBranch[] = []

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

    const remoteUrl = requireEnv('PSGIT_TEST_REMOTE_URL')
    const parsed = parsePowerSyncUrl(remoteUrl)
    orgId = parsed.org
    repoId = parsed.repo

    runCliCommand(['login', '--guest'], 'authenticate daemon (guest)')
    await waitForDaemonReady(daemonBaseUrl, WAIT_TIMEOUT_MS)

    runCliCommand(['demo-seed'], 'seed demo repository')
    await waitForRepoSeed(daemonBaseUrl, orgId, repoId, WAIT_TIMEOUT_MS)

    expectedBranches = await fetchDaemonBranches(daemonBaseUrl, orgId, repoId)
    if (!expectedBranches.length) {
      throw new Error(`Daemon returned no head refs for ${orgId}/${repoId}`)
    }
  })

  test('explorer shows CLI-seeded data', async ({ page }) => {
    test.setTimeout(WAIT_TIMEOUT_MS)
    await page.goto(`${BASE_URL}/auth`)
    await expect(page.getByTestId('auth-heading')).toBeVisible()

    await page.getByPlaceholder('Email').fill(supabaseEmail)
    await page.getByPlaceholder('Password').fill(supabasePassword)
    await page.getByRole('button', { name: 'Sign In' }).click()

    await page.waitForURL(/\/$/, { timeout: WAIT_TIMEOUT_MS })

    await page.goto(`${BASE_URL}/org/${orgId}/repo/${repoId}/branches`)
    await expect(page.getByTestId('branch-heading')).toBeVisible({ timeout: WAIT_TIMEOUT_MS })
    const powerSyncStatus = await readPowerSyncStatus(page)
    console.log('[live-cli] PowerSync status snapshot:', powerSyncStatus)
    const failFastTimeout = Math.min(FAIL_FAST_TIMEOUT_MS, WAIT_TIMEOUT_MS)
    const connectedStatus = await waitForPowerSyncConnected(page, failFastTimeout, WAIT_INTERVAL_MS)
    console.log('[live-cli] PowerSync connected snapshot:', connectedStatus)
    const powerSyncDbKeys = await page.evaluate(() => {
      const global = window as typeof window & { __powersyncDb?: Record<string, unknown> }
      if (!global.__powersyncDb) return null
      return Object.keys(global.__powersyncDb)
    })
    console.log('[live-cli] PowerSync db keys:', powerSyncDbKeys)
    const powerSyncRefs = await page.evaluate(async () => {
      const global = window as typeof window & {
        __powersyncDb?: { getAll?: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>> }
      }
      const db = global.__powersyncDb
      if (!db || typeof db.getAll !== 'function') {
        return null
      }
      const tables = await db.getAll("SELECT name FROM sqlite_master WHERE type = 'table'")
      const refsRows = await db.getAll('SELECT name, target_sha, org_id, repo_id FROM refs')
      let psDataRefs: Array<Record<string, unknown>> | { error: string } | null = null
      let psDataRefsInfo: Array<Record<string, unknown>> | { error: string } | null = null
      try {
        psDataRefs = await db.getAll('SELECT id, data FROM ps_data__refs')
      } catch (error) {
        psDataRefs = { error: error instanceof Error ? error.message : String(error) }
      }
      try {
        psDataRefsInfo = await db.getAll("PRAGMA table_info('ps_data__refs')")
      } catch (error) {
        psDataRefsInfo = { error: error instanceof Error ? error.message : String(error) }
      }
      return {
        refs: refsRows,
        ps_data_refs: psDataRefs,
        ps_data_refs_info: psDataRefsInfo,
        tables,
      }
    })
    console.log('[live-cli] PowerSync refs query:', powerSyncRefs)
    const branchItems = page.getByTestId('branch-item')
    await page.waitForFunction(
      (names) => {
        const items = Array.from(document.querySelectorAll('[data-testid="branch-item"]'))
        return names.every((name) => items.some((item) => item.textContent?.includes(name)))
      },
      expectedBranches.map((branch) => branch.name ?? ''),
      { timeout: failFastTimeout }
    )
    const branchCount = await branchItems.count()
    if (branchCount < expectedBranches.length) {
      throw new Error(
        `Expected at least ${expectedBranches.length} branch rows but saw ${branchCount}. Branch locator snapshot: ${await branchItems.allTextContents()}`
      )
    }
    for (const branch of expectedBranches) {
      const matchingRow = branchItems.filter({ hasText: branch.name ?? '' }).first()
      await expect(matchingRow).toBeVisible()
      const shaCell = matchingRow.locator('span.font-mono')
      if (branch.targetSha) {
        await expect(shaCell).toContainText(branch.targetSha.slice(0, 7))
      } else {
        await expect(shaCell).toContainText('—')
      }
    }

    const fixtureStore = await page.evaluate(
      ({ org, repo }) => {
        const global = window as typeof window & {
          __powersyncGetRepoFixtures?: () => Record<string, unknown>
        }
        if (typeof global.__powersyncGetRepoFixtures !== 'function') {
          return null
        }
        return global.__powersyncGetRepoFixtures()?.[`${org}::${repo}`] ?? null
      },
      { org: orgId, repo: repoId }
    )
    expect(fixtureStore).toBeNull()

    await page.goto(`${BASE_URL}/org/${orgId}/repo/${repoId}/commits`)
    await expect(page.getByTestId('commit-heading')).toBeVisible({ timeout: WAIT_TIMEOUT_MS })
    const commitItems = page.getByTestId('commit-item')
    await page.waitForFunction(
      () => {
        return Array.from(document.querySelectorAll('[data-testid="commit-item"]')).some((item) =>
          item.textContent?.includes('Import demo template content')
        )
      },
      undefined,
      { timeout: failFastTimeout }
    )
    const seededCommitRow = commitItems.filter({ hasText: 'Import demo template content' }).first()
    await expect(seededCommitRow).toBeVisible()
    await expect(seededCommitRow).toContainText('PowerSync Seed Bot')
    await expect(seededCommitRow.locator('span.font-mono')).not.toContainText('———')
  })
})
