import { expect, test } from './diagnostics'
import { BASE_URL } from 'playwright.config'
import { installDaemonAuthStub, installSupabaseMock } from './utils'

const USER_EMAIL = 'dev@example.com'
const USER_PASSWORD = 'supersecret'
const ACTIVE_PROFILE = process.env.STACK_PROFILE ?? 'local-dev'

test.describe('Authentication flow with daemon-backed tokens', () => {
  test('sign in, view home, sign out, and sign back in', async ({ page }) => {
    await installSupabaseMock(page, { email: USER_EMAIL })
    const daemon = await installDaemonAuthStub(page, { initialStatus: 'auth_required' })

    await page.goto(`${BASE_URL}/auth`)
    await expect(page.getByTestId('auth-heading')).toBeVisible()

    await page.fill('input[placeholder="Email"]', USER_EMAIL)
    await page.fill('input[placeholder="Password"]', USER_PASSWORD)
    await page.click('button:has-text("Sign In")')

    // Once the daemon is ready we should land on the explorer home page without additional gating.
    await page.waitForTimeout(100)
    daemon.setStatus('ready')
    await page.waitForURL(`${BASE_URL}/`)
    await expect(page.getByRole('heading', { name: 'Repo Explorer' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Your PowerSync Repositories' })).toBeVisible()

    await page.click('button:has-text("Sign out")')
    await page.waitForURL(`${BASE_URL}/auth`)
    expect(daemon.getStatus().status).toBe('auth_required')

    await page.fill('input[placeholder="Email"]', USER_EMAIL)
    await page.fill('input[placeholder="Password"]', USER_PASSWORD)
    await page.click('button:has-text("Sign In")')

    daemon.setStatus('ready')
    await page.waitForURL(`${BASE_URL}/`)
    await expect(page.getByRole('heading', { name: 'Your PowerSync Repositories' })).toBeVisible()
  })

  test('create account and land on explorer home', async ({ page }) => {
    test.skip(ACTIVE_PROFILE !== 'local-dev', 'Account creation test runs only against local profile')
    const signupEmail = `playwright-signup-${Date.now()}@example.com`
    await installSupabaseMock(page, { email: signupEmail })
    const daemon = await installDaemonAuthStub(page, { initialStatus: 'auth_required' })

    await page.goto(`${BASE_URL}/auth`)
    await expect(page.getByTestId('auth-heading')).toBeVisible()

    await page.fill('input[placeholder="Email"]', signupEmail)
    await page.fill('input[placeholder="Password"]', USER_PASSWORD)
    await page.click('button:has-text("Create Account")')

    await page.waitForTimeout(100)
    daemon.setStatus('ready')

    await page.waitForURL(`${BASE_URL}/`)
    await expect(page.getByRole('heading', { name: 'Repo Explorer' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Your PowerSync Repositories' })).toBeVisible()
  })
})
