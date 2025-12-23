import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { loadProfileEnvironment } from '@powersync-community/powergit-core/profile-env'
import { test, expect } from './diagnostics'
import { BASE_URL } from '../../playwright.config'

const WAIT_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_E2E_WAIT_MS ?? '120000', 10)

const REQUIRED_ENV_VARS = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_EMAIL',
  'SUPABASE_PASSWORD',
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

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`Environment variable ${name} is required for live org e2e tests.`)
  }
  return value.trim()
}

function makeSlug(prefix: string): string {
  const rand = Math.random().toString(16).slice(2, 8)
  return `${prefix}-${Date.now()}-${rand}`.toLowerCase()
}

hydrateProfileEnv()
const missingLiveEnv = REQUIRED_ENV_VARS.filter((name) => {
  const value = process.env[name]
  return !value || value.trim().length === 0
})
const describeLive = missingLiveEnv.length > 0 ? test.describe.skip : test.describe

describeLive('Org management (live Supabase)', () => {
  let admin: SupabaseClient
  const createdUserIds: string[] = []
  let orgId: string | null = null

  test.beforeAll(() => {
    REQUIRED_ENV_VARS.forEach(requireEnv)
    admin = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'public' },
    })
  })

  test.afterAll(async () => {
    if (orgId) {
      await admin.from('org_member_invites').delete().eq('org_id', orgId)
      await admin.from('org_members').delete().eq('org_id', orgId)
      await admin.from('orgs').delete().eq('id', orgId)
    }
    for (const userId of createdUserIds) {
      await admin.auth.admin.deleteUser(userId).catch(() => undefined)
    }
  })

  test('creates an org, adds a member, and member can see it', async ({ page, browser }) => {
    test.setTimeout(WAIT_TIMEOUT_MS)

    const memberEmail = `${makeSlug('e2e-member')}@example.com`
    const memberPassword = `PowergitE2E-${Math.random().toString(16).slice(2)}!`
    const inviteEmail = `${makeSlug('e2e-invite')}@example.com`
    const invitePassword = `PowergitE2E-${Math.random().toString(16).slice(2)}!`

    const { data: createUserData, error: createUserError } = await admin.auth.admin.createUser({
      email: memberEmail,
      password: memberPassword,
      email_confirm: true,
    })
    if (createUserError) {
      throw new Error(`Failed to create member user: ${createUserError.message}`)
    }
    const createdMemberUserId = createUserData.user?.id ?? null
    if (!createdMemberUserId) {
      throw new Error('Supabase did not return a user id for the created member.')
    }
    createdUserIds.push(createdMemberUserId)

    const ownerEmail = requireEnv('SUPABASE_EMAIL')
    const ownerPassword = requireEnv('SUPABASE_PASSWORD')

    await page.goto(`${BASE_URL}/auth`)
    await expect(page.getByTestId('auth-heading')).toBeVisible()
    await page.getByPlaceholder('Email').fill(ownerEmail)
    await page.getByPlaceholder('Password').fill(ownerPassword)
    await page.getByRole('button', { name: 'Sign In' }).click()
    await page.waitForURL(/\/$/, { timeout: WAIT_TIMEOUT_MS })

    orgId = makeSlug('e2e-org')
    await page.goto(`${BASE_URL}/orgs`)
    await expect(page.getByRole('heading', { name: 'Orgs' })).toBeVisible()

    await page.getByLabel('Org ID').fill(orgId)
    await page.getByLabel('Display Name (optional)').fill('Powergit E2E Org')
    await page.getByRole('button', { name: 'Create org' }).click()

    const orgRow = page.locator('li').filter({ hasText: orgId })
    await expect(orgRow).toBeVisible({ timeout: WAIT_TIMEOUT_MS })
    await expect(orgRow).toContainText('Role: admin', { timeout: WAIT_TIMEOUT_MS })

    await orgRow.getByRole('link', { name: 'Settings →' }).click()
    await page.waitForURL(new RegExp(`/org/${encodeURIComponent(orgId)}/settings`), { timeout: WAIT_TIMEOUT_MS })
    await expect(page.getByRole('heading', { name: new RegExp(`Org settings:\\s*${orgId}`) })).toBeVisible()

    const inviteEmailInput = page.getByLabel('Invite member (email)')
    const inviteRoleSelect = page.getByRole('combobox', { name: /^Role$/ })
    await expect(inviteEmailInput).toBeEnabled({ timeout: WAIT_TIMEOUT_MS })

    await inviteEmailInput.fill(inviteEmail)
    await inviteRoleSelect.selectOption('write')
    await page.getByRole('button', { name: /^Invite$/ }).click()

    const inviteRow = page.locator('li').filter({ hasText: inviteEmail })
    await expect(inviteRow).toBeVisible({ timeout: WAIT_TIMEOUT_MS })
    await expect(inviteRow).toContainText('Role: write')
    await expect(page.getByText('[object Object]')).toHaveCount(0)

    await inviteEmailInput.fill(memberEmail)
    await inviteRoleSelect.selectOption('write')
    await page.getByRole('button', { name: /^Invite$/ }).click()

    await expect(page.getByText(memberEmail)).toBeVisible({ timeout: WAIT_TIMEOUT_MS })
    await expect(page.getByLabel(`Role for ${memberEmail}`)).toHaveValue('write')

    const { data: inviteUserData, error: inviteUserError } = await admin.auth.admin.createUser({
      email: inviteEmail,
      password: invitePassword,
      email_confirm: true,
    })
    if (inviteUserError) {
      throw new Error(`Failed to create invited user: ${inviteUserError.message}`)
    }
    const createdInviteUserId = inviteUserData.user?.id ?? null
    if (!createdInviteUserId) {
      throw new Error('Supabase did not return a user id for the invited user.')
    }
    createdUserIds.push(createdInviteUserId)

    const memberContext = await browser.newContext()
    const memberPage = await memberContext.newPage()
    try {
      await memberPage.goto(`${BASE_URL}/auth`)
      await expect(memberPage.getByTestId('auth-heading')).toBeVisible()
      await memberPage.getByPlaceholder('Email').fill(memberEmail)
      await memberPage.getByPlaceholder('Password').fill(memberPassword)
      await memberPage.getByRole('button', { name: 'Sign In' }).click()
      await memberPage.waitForURL(/\/$/, { timeout: WAIT_TIMEOUT_MS })

      await memberPage.goto(`${BASE_URL}/orgs`)
      const memberOrgRow = memberPage
        .locator('li')
        .filter({ hasText: orgId })
        .filter({ has: memberPage.getByRole('link', { name: 'Settings →' }) })
      await expect(memberOrgRow).toBeVisible({ timeout: WAIT_TIMEOUT_MS })
      await expect(memberOrgRow).toContainText('Role: write', { timeout: WAIT_TIMEOUT_MS })
    } finally {
      await memberContext.close()
    }

    const inviteContext = await browser.newContext()
    const invitePage = await inviteContext.newPage()
    try {
      await invitePage.goto(`${BASE_URL}/auth`)
      await expect(invitePage.getByTestId('auth-heading')).toBeVisible()
      await invitePage.getByPlaceholder('Email').fill(inviteEmail)
      await invitePage.getByPlaceholder('Password').fill(invitePassword)
      await invitePage.getByRole('button', { name: 'Sign In' }).click()
      await invitePage.waitForURL(/\/$/, { timeout: WAIT_TIMEOUT_MS })

      await invitePage.goto(`${BASE_URL}/orgs`)

      const pendingInviteRow = invitePage
        .locator('li')
        .filter({ hasText: orgId })
        .filter({ has: invitePage.getByRole('button', { name: 'Accept' }) })
      await expect(pendingInviteRow).toBeVisible({ timeout: WAIT_TIMEOUT_MS })
      await pendingInviteRow.getByRole('button', { name: 'Accept' }).click()

      const invitedOrgRow = invitePage
        .locator('li')
        .filter({ hasText: orgId })
        .filter({ has: invitePage.getByRole('link', { name: 'Settings →' }) })
      await expect(invitedOrgRow).toBeVisible({ timeout: WAIT_TIMEOUT_MS })
      await expect(invitedOrgRow).toContainText('Role: write', { timeout: WAIT_TIMEOUT_MS })
    } finally {
      await inviteContext.close()
    }
  })
})
