import { test, expect } from './diagnostics'
import { BASE_URL } from '../../playwright.config'
import { installSupabaseMock } from './utils'

const REPO_URL = 'https://github.com/octocat/Hello-World'
const WORKFLOW_URL = 'https://github.com/powersync-community/powergit/actions/runs/123456'

test.describe('GitHub Actions import UI', () => {
  test.beforeEach(async ({ page }) => {
    await installSupabaseMock(page, { authenticated: true })

    await page.addInitScript(() => {
      const globalWindow = window as typeof window & { __powersyncImportModeOverride?: 'daemon' | 'actions' }
      globalWindow.__powersyncImportModeOverride = 'actions'
    })

    await page.route('http://127.0.0.1:5030/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })

    await page.route('**/functions/v1/github-import', async (route) => {
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          job: {
            id: 'job-actions-123',
            status: 'success',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            repoUrl: REPO_URL,
            orgId: 'octocat',
            repoId: 'hello-world',
            branch: null,
            steps: [],
            logs: [],
            error: null,
            result: { orgId: 'octocat', repoId: 'hello-world', branch: null, defaultBranch: 'main' },
            workflowUrl: WORKFLOW_URL,
          },
        }),
      })
    })

    await page.goto(`${BASE_URL}/`)
  })

  test('shows compact status, target, and workflow link', async ({ page }) => {
    await expect(page.getByTestId('explore-repo-input')).toBeVisible()
    await page.getByTestId('explore-repo-input').fill(REPO_URL)
    await page.getByTestId('explore-repo-submit').click()

    await expect(page.getByText('Import finished.')).toBeVisible()

    const summary = page.getByTestId('import-summary')
    await expect(summary).toContainText('octocat/hello-world')
    await expect(summary).toContainText('STATUS: SUCCESS', { ignoreCase: true })
    await expect(summary).toContainText('Branch: main')

    const workflowLink = page.getByRole('link', { name: 'View GitHub Actions run →' })
    await expect(workflowLink).toBeVisible()
    await expect(workflowLink).toHaveAttribute('href', WORKFLOW_URL)
  })
})
