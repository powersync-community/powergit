import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Page } from '@playwright/test'
import type { RepoFixturePayload } from '../../src/testing/fixtures'

const SET_FIXTURE_KEY = '__powersyncSetRepoFixture'
const CLEAR_FIXTURE_KEY = '__powersyncClearRepoFixtures'
const GET_FIXTURE_KEY = '__powersyncGetRepoFixtures'
const FIXTURE_BRIDGE_TIMEOUT_MS = 5_000

export type { RepoFixturePayload } from '../../src/testing/fixtures'

const REQUIRED_ENV_VARS = [
  'POWERSYNC_SUPABASE_URL',
  'POWERSYNC_SUPABASE_SERVICE_ROLE_KEY',
]

function stripQuotes(value: string): string {
  if (!value) return value
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

function getEnv(name: string): string {
  const raw = process.env[name]?.trim()
  if (raw) return stripQuotes(raw)
  throw new Error(`Missing required environment variable ${name}. Did you run pnpm dev:stack and source .env.powersync-stack?`)
}

let cachedClient: SupabaseClient | null = null

function getSupabaseAdminClient(): SupabaseClient {
  if (cachedClient) return cachedClient
  REQUIRED_ENV_VARS.forEach((key) => {
    if (!process.env[key]) {
      throw new Error(`Environment variable ${key} is required for live PowerSync tests.`)
    }
  })
  const url = getEnv('POWERSYNC_SUPABASE_URL')
  const serviceRoleKey = getEnv('POWERSYNC_SUPABASE_SERVICE_ROLE_KEY')
  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
    db: { schema: 'public' },
  })
  return cachedClient
}

async function resetRepoTables(orgId: string, repoId: string) {
  const supabase = getSupabaseAdminClient()

  const tables = ['file_changes', 'commits', 'refs']
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().eq('org_id', orgId).eq('repo_id', repoId)
    if (error) {
      throw new Error(`Failed to clear ${table}: ${error.message}`)
    }
  }
}

async function insertRecords<TableName extends 'refs' | 'commits' | 'file_changes'>(
  table: TableName,
  rows: Array<Record<string, unknown>>,
) {
  if (rows.length === 0) return
  const supabase = getSupabaseAdminClient()
  const { error } = await supabase.from(table).insert(rows)
  if (error) {
    throw new Error(`Failed to insert into ${table}: ${error.message}`)
  }
}

export async function seedRepoData(payload: RepoFixturePayload): Promise<void> {
  const { orgId, repoId } = payload
  await resetRepoTables(orgId, repoId)

  const branchRows = (payload.branches ?? []).map((branch) => ({
    org_id: orgId,
    repo_id: repoId,
    name: branch.name,
    target_sha: branch.target_sha,
    updated_at: branch.updated_at ?? new Date().toISOString(),
  }))

  const commitRows = (payload.commits ?? []).map((commit) => ({
    org_id: orgId,
    repo_id: repoId,
    sha: commit.sha,
    author_name: commit.author_name,
    author_email: commit.author_email ?? null,
    authored_at: commit.authored_at ?? null,
    message: commit.message ?? null,
    tree_sha: commit.tree_sha ?? null,
  }))

  const changeRows = (payload.fileChanges ?? []).map((change) => ({
    org_id: orgId,
    repo_id: repoId,
    commit_sha: change.commit_sha,
    path: change.path,
    additions: change.additions,
    deletions: change.deletions,
  }))

  await insertRecords('refs', branchRows)
  await insertRecords('commits', commitRows)
  await insertRecords('file_changes', changeRows)
}

async function waitForFixtureBridge(page: Page): Promise<void> {
  await page.waitForFunction(
    (setterKey) => {
      const global = window as typeof window & Record<string, unknown>
      return typeof global[setterKey as string] === 'function'
    },
    SET_FIXTURE_KEY,
    { timeout: FIXTURE_BRIDGE_TIMEOUT_MS }
  )
}

export async function ensureFixtureBridge(page: Page): Promise<void> {
  await waitForFixtureBridge(page)
}

export async function setRepoFixture(page: Page, payload: RepoFixturePayload): Promise<void> {
  await waitForFixtureBridge(page)
  await page.evaluate(
    ({ setterKey, fixture }) => {
      const global = window as typeof window & Record<string, unknown>
      const setter = global[setterKey]
      if (typeof setter !== 'function') {
        throw new Error(`Fixture setter ${setterKey} is not available`)
      }
      ;(setter as (input: RepoFixturePayload) => void)(fixture)
    },
    { setterKey: SET_FIXTURE_KEY, fixture: payload }
  )
}

export async function clearRepoFixtures(page: Page): Promise<void> {
  await waitForFixtureBridge(page)
  await page.evaluate(({ clearKey }) => {
    const global = window as typeof window & Record<string, unknown>
    const clearer = global[clearKey]
    if (typeof clearer === 'function') {
      ;(clearer as () => void)()
    }
  }, { clearKey: CLEAR_FIXTURE_KEY })
}

export async function getRepoFixtureStore(page: Page): Promise<Record<string, RepoFixturePayload>> {
  await waitForFixtureBridge(page)
  return page.evaluate(({ getterKey }) => {
    const global = window as typeof window & Record<string, unknown>
    const getter = global[getterKey]
    if (typeof getter !== 'function') {
      return {}
    }
    return (getter as () => Record<string, RepoFixturePayload>)()
  }, { getterKey: GET_FIXTURE_KEY })
}
