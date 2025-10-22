import { test, expect } from './diagnostics'
import { BASE_URL } from 'playwright.config'
import { clearRepoFixtures, installDaemonAuthStub, installSupabaseMock, setRepoFixture, type RepoFixturePayload } from './utils'

const ORG_ID = 'acme'
const REPO_ID = 'infra'
const REPO_FIXTURE: RepoFixturePayload = {
  orgId: ORG_ID,
  repoId: REPO_ID,
  branches: [
    { name: 'main', target_sha: 'f00baa11', updated_at: '2024-09-01T12:34:56Z' },
    { name: 'develop', target_sha: 'f00baa22', updated_at: '2024-09-02T08:15:00Z' },
  ],
  commits: [
    {
      sha: 'f00baa22deadbeef000000000000000000000002',
      author_name: 'Grace Hopper',
      author_email: 'grace@example.com',
      authored_at: '2024-09-03T09:00:00Z',
      message: 'Add replication logic',
      tree_sha: 'f00baa44',
    },
    {
      sha: 'f00baa11deadbeef000000000000000000000001',
      author_name: 'Ada Lovelace',
      author_email: 'ada@example.com',
      authored_at: '2024-09-01T12:34:56Z',
      message: 'Initial commit',
      tree_sha: 'f00baa33',
    },
  ],
  fileChanges: [
    {
      commit_sha: 'f00baa22deadbeef000000000000000000000002',
      path: 'src/replication.ts',
      additions: 120,
      deletions: 8,
    },
    {
      commit_sha: 'f00baa22deadbeef000000000000000000000002',
      path: 'README.md',
      additions: 10,
      deletions: 2,
    },
  ],
}

test.describe('Explorer repo lists', () => {
  test.beforeEach(async ({ page }) => {
    await installDaemonAuthStub(page, { initialStatus: 'ready' })
    await installSupabaseMock(page, { authenticated: true })

    await page.goto(`${BASE_URL}/`)
    if (!page.url().endsWith('/')) {
      throw new Error(`Expected to land on explorer home, current URL: ${page.url()}`)
    }
    await expect(page.getByRole('heading', { name: 'Your PowerSync Repositories' })).toBeVisible()
  })

  test.afterEach(async ({ page }) => {
    await clearRepoFixtures(page)
  })

  test('shows repo branches from fixture data', async ({ page }) => {
    await page.goto(`${BASE_URL}/org/${ORG_ID}/repo/${REPO_ID}/branches`)
    await setRepoFixture(page, REPO_FIXTURE)

    await expect(page.getByTestId('branch-heading')).toBeVisible()
    const branchItems = page.getByTestId('branch-item')
    await expect(branchItems).toHaveCount(2)
    await expect(branchItems.nth(0)).toContainText('main')
    await expect(branchItems.nth(1)).toContainText('develop')

    const hashPrefixes = await branchItems.locator('span.font-mono').allTextContents()
    expect(hashPrefixes[0]).toContain('f00baa11'.slice(0, 7))
  })

  test('lists commits with newest first', async ({ page }) => {
    await page.goto(`${BASE_URL}/org/${ORG_ID}/repo/${REPO_ID}/commits`)
    await setRepoFixture(page, REPO_FIXTURE)

    await expect(page.getByTestId('commit-heading')).toBeVisible()
    const commitItems = page.getByTestId('commit-item')
    await expect(commitItems).toHaveCount(2)

    const firstCommit = commitItems.first()
    await expect(firstCommit).toContainText('Add replication logic')
    await expect(firstCommit).toContainText('Grace Hopper')
    await expect(firstCommit.locator('span.font-mono').first()).toContainText('f00baa22deadbeef000000000000000000000002'.slice(0, 7))

    const secondCommit = commitItems.nth(1)
    await expect(secondCommit).toContainText('Initial commit')
    await expect(secondCommit).toContainText('Ada Lovelace')
  })

  test('renders file changes summary with counts', async ({ page }) => {
    await page.goto(`${BASE_URL}/org/${ORG_ID}/repo/${REPO_ID}/files`)
    await setRepoFixture(page, REPO_FIXTURE)

    await expect(page.getByTestId('file-change-heading')).toBeVisible()
    const changeItems = page.getByTestId('file-change-item')
    await expect(changeItems).toHaveCount(2)
    await expect(changeItems.nth(0)).toContainText('src/replication.ts')
    await expect(changeItems.nth(0)).toContainText('+120')
    await expect(changeItems.nth(0)).toContainText('-8')
    await expect(changeItems.nth(1)).toContainText('README.md')
    await expect(changeItems.nth(1)).toContainText('+10')
    await expect(changeItems.nth(1)).toContainText('-2')
  })

  test('updates branch list when fixture changes', async ({ page }) => {
    await page.goto(`${BASE_URL}/org/${ORG_ID}/repo/${REPO_ID}/branches`)
    await setRepoFixture(page, REPO_FIXTURE)

    const branchItems = page.getByTestId('branch-item')
    await expect(branchItems).toHaveCount(2)
    await expect(branchItems.first()).toContainText('main')

    await setRepoFixture(page, {
      ...REPO_FIXTURE,
      branches: [
        { name: 'hotfix', target_sha: 'deadbeefcafefeed000000000000000000000033', updated_at: '2024-09-05T10:00:00Z' },
        { name: 'release', target_sha: 'deadbeefcafefeed000000000000000000000044', updated_at: '2024-09-04T10:00:00Z' },
      ],
    })

    await expect(branchItems).toHaveCount(2)
    await expect(branchItems.first()).toContainText('hotfix')
    await expect(branchItems.last()).toContainText('release')
    await expect(branchItems.filter({ hasText: 'main' })).toHaveCount(0)
  })
})
