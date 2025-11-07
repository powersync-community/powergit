import { test, expect } from './diagnostics'
import { BASE_URL } from 'playwright.config'
import { clearRepoFixtures, installDaemonAuthStub, installSupabaseMock, setRepoFixture, type RepoFixturePayload } from './utils'
import type { PackRow } from '../../src/ps/git-store'

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

const BRANCH_TREE_FIXTURE: RepoFixturePayload = {
  orgId: ORG_ID,
  repoId: REPO_ID,
  branches: [
    { name: 'main', target_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', updated_at: '2024-09-10T10:00:00Z' },
    { name: 'feature/api', target_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', updated_at: '2024-09-11T11:00:00Z' },
  ],
  commits: [
    {
      sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      author_name: 'Main Dev',
      message: 'Main branch update',
      tree_sha: 'aaaa-tree',
    },
    {
      sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      author_name: 'Feature Dev',
      message: 'Feature branch update',
      tree_sha: 'bbbb-tree',
    },
  ],
  fileChanges: [
    { commit_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', path: 'README-main.md', additions: 5, deletions: 0 },
    { commit_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', path: 'FEATURE.md', additions: 5, deletions: 0 },
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
    await expect(page.getByLabel('Explore a Git repository')).toBeVisible()
  })

  test.afterEach(async ({ page }) => {
    await clearRepoFixtures(page)
    await page.evaluate(() => {
      localStorage.clear()
    })
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

  test('renders file explorer skeleton while packs index', async ({ page }) => {
    await page.goto(`${BASE_URL}/org/${ORG_ID}/repo/${REPO_ID}/files`)
    await setRepoFixture(page, REPO_FIXTURE)

    await expect(page.getByTestId('repo-toolbar')).toBeVisible()
    await expect(page.getByTestId('branch-selector')).toBeVisible()
    await expect(page.getByTestId('file-explorer-tree')).toContainText('Repository content is syncing')
    await expect(page.getByTestId('file-viewer-placeholder')).toContainText('Select a file')
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

  test('shows sync progress counts while git packs index', async ({ page }) => {
    await page.goto(`${BASE_URL}/org/${ORG_ID}/repo/${REPO_ID}/files`)
    await setRepoFixture(page, REPO_FIXTURE)

    await page.evaluate(
      async ({ orgId, repoId }) => {
        const store = (window as typeof window & { __powersyncGitStore?: unknown }).__powersyncGitStore as any
        if (!store) throw new Error('gitStore instance not found on window')
        store.indexedPacks = new Set()
        store.processPack = async function process(pack: PackRow) {
          this.indexedPacks.add(pack.pack_oid)
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
        store.yieldToBrowser = async () => {}
        const now = new Date().toISOString()
        const mkPack = (suffix: string) => ({
          id: `pack-${suffix}`,
          org_id: orgId,
          repo_id: repoId,
          pack_oid: `pack-${suffix}`,
          pack_bytes: 'Zg==',
          created_at: now,
        })
        void store.indexPacks([mkPack('one'), mkPack('two'), mkPack('three')])
      },
      { orgId: ORG_ID, repoId: REPO_ID },
    )

    const tree = page.getByTestId('file-explorer-tree')
    await expect(tree).toContainText('Repository content is syncing')
    await expect(page.getByTestId('file-viewer-placeholder')).toContainText('Select a file')
  })

  test('persists the selected branch in the URL', async ({ page }) => {
    await page.goto(`${BASE_URL}/org/${ORG_ID}/repo/${REPO_ID}/files`)
    await setRepoFixture(page, REPO_FIXTURE)

    const selector = page.getByTestId('branch-selector')
    await expect(selector).toContainText('main')
    await selector.selectOption('develop')
    await expect(page).toHaveURL(/branch=develop/)

    await page.reload()
    await setRepoFixture(page, REPO_FIXTURE)
    await expect(page).toHaveURL(/branch=develop/)
    await expect(page.getByTestId('branch-selector')).toHaveValue('develop')
  })

  test('renders file tree after reloading the explorer view', async ({ page }) => {
    await page.goto(`${BASE_URL}/org/${ORG_ID}/repo/${REPO_ID}/files`)
    await setRepoFixture(page, REPO_FIXTURE)

    const tree = page.getByTestId('file-explorer-tree')
    await expect(tree).toContainText('README.md')

    await page.reload()
    await setRepoFixture(page, REPO_FIXTURE)
    await expect(tree).toContainText('README.md')
  })

  test('switching branches refreshes the git tree', async ({ page }) => {
    await page.goto(`${BASE_URL}/org/${ORG_ID}/repo/${REPO_ID}/files`)
    await setRepoFixture(page, BRANCH_TREE_FIXTURE)

    await page.waitForFunction(() => Boolean((window as typeof window & { __powersyncGitStore?: unknown }).__powersyncGitStore), undefined, { timeout: 5_000 })

    const commitTrees = {
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa': {
        trees: {
          __root__: [
            { type: 'blob', path: 'README-main.md', name: 'README-main.md', oid: 'main-readme', mode: '100644' },
            { type: 'blob', path: 'infra.txt', name: 'infra.txt', oid: 'main-infra', mode: '100644' },
          ],
        },
        files: {
          'README-main.md': { content: 'Main branch docs', oid: 'main-readme' },
          'infra.txt': { content: 'Infra notes', oid: 'main-infra' },
        },
      },
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb': {
        trees: {
          __root__: [
            { type: 'blob', path: 'FEATURE.md', name: 'FEATURE.md', oid: 'feature-notes', mode: '100644' },
            { type: 'blob', path: 'api.ts', name: 'api.ts', oid: 'feature-api', mode: '100644' },
          ],
        },
        files: {
          'FEATURE.md': { content: 'Feature branch docs', oid: 'feature-notes' },
          'api.ts': { content: 'export const feature = true', oid: 'feature-api' },
        },
      },
    }

    await page.evaluate(({ trees }) => {
      const global = window as typeof window & { __powersyncGitStore?: any }
      const store = global.__powersyncGitStore
      if (!store) throw new Error('gitStore bridge was not initialized')

      const ready = { status: 'ready', processed: 0, total: 0, error: null }
      store.getProgress = () => ready
      store.subscribe = (listener: (progress: typeof ready) => void) => {
        listener(ready)
        return () => {}
      }
      store.indexPacks = async () => {}

      store.readTreeAtPath = async (commitOid: string, segments: string[]) => {
        const key = segments.filter(Boolean).join('/') || '__root__'
        const branch = trees[commitOid as keyof typeof trees]
        if (!branch) throw new Error(`Missing tree stub for ${commitOid}`)
        const rows = branch.trees[key] ?? []
        return rows.map((entry) => ({ ...entry }))
      }

      const encoder = new TextEncoder()
      store.readFile = async (commitOid: string, filePath: string) => {
        const branch = trees[commitOid as keyof typeof trees]
        if (!branch) throw new Error(`Missing tree stub for ${commitOid}`)
        const file = branch.files[filePath as keyof typeof branch.files]
        if (!file) throw new Error(`Missing file stub for ${filePath}`)
        return { content: encoder.encode(file.content), oid: file.oid }
      }

      store.updateProgress?.(ready)
    }, { trees: commitTrees })

    const tree = page.getByTestId('file-explorer-tree')
    await expect(tree).toContainText('README-main.md')
    await expect(tree).not.toContainText('FEATURE.md')

    const selector = page.getByTestId('branch-selector')
    await selector.selectOption('feature/api')
    await expect(tree).toContainText('FEATURE.md')
    await expect(tree).toContainText('api.ts')
    await expect(tree).not.toContainText('README-main.md')
  })

  test('offers a download CTA for binary blobs in the viewer', async ({ page }) => {
    await page.goto(`${BASE_URL}/org/${ORG_ID}/repo/${REPO_ID}/files`)
    await setRepoFixture(page, {
      ...REPO_FIXTURE,
      fileChanges: [
        { commit_sha: REPO_FIXTURE.commits![0].sha, path: 'binary.dat', additions: 10, deletions: 0 },
      ],
    })

    await page.evaluate(
      async ({ orgId, repoId }) => {
        const store = (window as typeof window & { __powersyncGitStore?: unknown }).__powersyncGitStore as any
        if (!store) throw new Error('gitStore instance not found on window')
        store.indexedPacks = new Set()
        store.processPack = async function process(pack: PackRow) {
          this.indexedPacks.add(pack.pack_oid)
        }
        store.yieldToBrowser = async () => {}
        store.getCommitTree = async () => ({ treeOid: 'root' })
        const entries = [
          { type: 'blob', path: 'binary.dat', name: 'binary.dat', oid: 'oid-binary', mode: '100644' },
          { type: 'blob', path: 'notes.txt', name: 'notes.txt', oid: 'oid-text', mode: '100644' },
        ]
        store.readTreeAtPath = async () => entries
        store.readTree = async () => entries
        store.readFile = async (_commit: string, path: string) => {
          const size = path === 'binary.dat' ? 1_500_000 : 200
          const buffer = new Uint8Array(size)
          return { content: buffer, oid: path === 'binary.dat' ? 'oid-binary' : 'oid-text' }
        }
        await store.indexPacks([
          {
            id: 'pack-binary',
            org_id: orgId,
            repo_id: repoId,
            pack_oid: 'pack-binary',
            pack_bytes: 'Zg==',
            created_at: new Date().toISOString(),
          },
        ])
      },
      { orgId: ORG_ID, repoId: REPO_ID },
    )

    const binaryFile = page.getByTestId('file-tree-file').filter({ hasText: 'binary.dat' })
    await binaryFile.click()

    const downloadButton = page.getByRole('button', { name: 'Download blob' })
    await expect(downloadButton).toBeVisible()
    await expect(page.getByTestId('file-viewer-status')).toContainText('binary.dat')
  })
})
