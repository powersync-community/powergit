import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from './diagnostics'
import { BASE_URL } from '../../playwright.config'
import { loadProfileEnvironment } from '@powersync-community/powergit-core/profile-env'

const WAIT_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_E2E_WAIT_MS ?? '300000', 10)
const WAIT_INTERVAL_MS = Number.parseInt(process.env.POWERSYNC_E2E_POLL_MS ?? '1500', 10)

const GITHUB_REPO_URL = process.env.POWERSYNC_E2E_REPO_URL ?? 'https://github.com/octocat/Hello-World'

function parseGithubUrl(value: string): { owner: string; repo: string } | null {
  try {
    const url = new URL(value.trim())
    if (!/github\.com$/i.test(url.host)) return null
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length < 2) return null
    return { owner: parts[0]!, repo: parts[1]!.replace(/\.git$/i, '') }
  } catch {
    return null
  }
}

function slugify(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function normalizeGithubImportOrgId(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'gh-organisation'
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('gh-') || lower.startsWith('github-')) {
    return slugify(trimmed)
  }
  return `gh-${slugify(trimmed)}`
}

function buildImportPayload(repoUrl: string): { orgId: string; repoId: string } | null {
  const url = repoUrl.trim()
  if (!url) return null
  const parsed = parseGithubUrl(url)
  const orgId = `gh-${slugify(parsed?.owner ?? 'organisation')}`
  const repoId = slugify(parsed?.repo ?? 'repository')
  if (!orgId || !repoId) return null
  return { orgId, repoId }
}

const derivedSlugs = buildImportPayload(GITHUB_REPO_URL)
const POWERSYNC_ORG = normalizeGithubImportOrgId(process.env.POWERSYNC_E2E_ORG ?? derivedSlugs?.orgId ?? 'gh-octocat')
const DISPLAY_ORG = POWERSYNC_ORG.startsWith('gh-')
  ? POWERSYNC_ORG.slice(3)
  : POWERSYNC_ORG.startsWith('github-')
    ? POWERSYNC_ORG.slice('github-'.length)
    : POWERSYNC_ORG
const POWERSYNC_REPO = slugify(process.env.POWERSYNC_E2E_REPO ?? derivedSlugs?.repoId ?? 'hello-world')

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
  const normalized = normalizeBaseUrl(baseUrl)
  while (Date.now() < deadline) {
    try {
      const res = await fetch(
        `${normalized}/orgs/${encodeURIComponent(orgId)}/repos/${encodeURIComponent(repoId)}/summary`,
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
    throw new Error(`Environment variable ${name} is required for live PowerSync tests.`)
  }
  return value.trim()
}

hydrateProfileEnv()
const missingLiveEnv = REQUIRED_ENV_VARS.filter((name) => {
  const value = process.env[name]
  return !value || value.trim().length === 0
})
const describeLive = missingLiveEnv.length > 0 ? test.describe.skip : test.describe

describeLive('Explorer GitHub import (live PowerSync)', () => {
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
    REQUIRED_ENV_VARS.forEach(requireEnv)
    supabaseEmail = requireEnv('SUPABASE_EMAIL')
    supabasePassword = requireEnv('SUPABASE_PASSWORD')
    daemonBaseUrl = normalizeBaseUrl(requireEnv('POWERSYNC_DAEMON_URL'))
    await waitForDaemonReady(daemonBaseUrl, WAIT_TIMEOUT_MS)
  })

  test('clones a public GitHub repository and opens a file', async ({ page }) => {
    const liveTimeoutMs = WAIT_TIMEOUT_MS * 2
    test.setTimeout(liveTimeoutMs)

    await page.goto(`${BASE_URL}/auth`)
    await expect(page.getByTestId('auth-heading')).toBeVisible()

    await page.getByPlaceholder('Email').fill(supabaseEmail)
    await page.getByPlaceholder('Password').fill(supabasePassword)
    await page.getByRole('button', { name: 'Sign In' }).click()

    await page.waitForURL(/\/$/, { timeout: WAIT_TIMEOUT_MS })
    await expect(page.getByTestId('explore-repo-input')).toBeVisible()

    await page.getByTestId('explore-repo-input').fill(GITHUB_REPO_URL)
    await page.getByTestId('explore-repo-submit').click()

    await waitForRepoSeed(daemonBaseUrl, POWERSYNC_ORG, POWERSYNC_REPO, liveTimeoutMs)

    const repoItem = page.locator('li').filter({ hasText: DISPLAY_ORG }).filter({ hasText: POWERSYNC_REPO })
    await expect(repoItem).toBeVisible({ timeout: liveTimeoutMs })

    const expectedHref = `/org/${encodeURIComponent(POWERSYNC_ORG)}/repo/${encodeURIComponent(POWERSYNC_REPO)}/files`
    const openLink = page.locator(`a[data-testid="repository-open-button"][href="${expectedHref}"]`)
    await expect(openLink).toBeVisible({ timeout: liveTimeoutMs })

    await Promise.all([
      page.waitForURL(new RegExp(`/org/${encodeURIComponent(POWERSYNC_ORG)}/repo/${encodeURIComponent(POWERSYNC_REPO)}/files`), {
        timeout: liveTimeoutMs,
      }),
      openLink.evaluate((el) => (el as HTMLAnchorElement).click()),
    ])

    const fileEntries = page.getByTestId('file-tree-file')
    await expect(fileEntries.first()).toBeVisible({ timeout: liveTimeoutMs })

    const firstEntry = fileEntries.first()
    const selectedPath = (await firstEntry.textContent())?.trim() ?? null
    await firstEntry.click()

    const viewerHeader = page.getByTestId('file-viewer-header')
    await expect(viewerHeader).not.toContainText('Select a file', { timeout: liveTimeoutMs })
    if (selectedPath) {
      await expect(viewerHeader).toContainText(selectedPath, { timeout: liveTimeoutMs })
    }
  })
})
