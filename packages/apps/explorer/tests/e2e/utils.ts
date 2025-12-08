import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Page } from '@playwright/test'
import type { RepoFixturePayload } from '../../src/testing/fixtures'

const SET_FIXTURE_KEY = '__powersyncSetRepoFixture'
const CLEAR_FIXTURE_KEY = '__powersyncClearRepoFixtures'
const GET_FIXTURE_KEY = '__powersyncGetRepoFixtures'
const FIXTURE_BRIDGE_TIMEOUT_MS = 5_000

export type { RepoFixturePayload } from '../../src/testing/fixtures'

const REQUIRED_ENV_VARS = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']

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
  throw new Error(`Missing required environment variable ${name}. Ensure the active profile provides it (for example, run "STACK_PROFILE=local-dev pnpm --filter @app/explorer test:e2e").`)
}

let cachedClient: SupabaseClient | null = null

function getSupabaseAdminClient(): SupabaseClient {
  if (cachedClient) return cachedClient
  REQUIRED_ENV_VARS.forEach((key) => {
    if (!process.env[key]) {
      throw new Error(`Environment variable ${key} is required for live PowerSync tests.`)
    }
  })
  const url = getEnv('SUPABASE_URL')
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY')
  cachedClient = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
    db: { schema: 'public' },
  })
  return cachedClient
}

async function resetRepoTables(orgId: string, repoId: string) {
  const supabase = getSupabaseAdminClient()

  const tables = ['file_changes', 'commits', 'refs', 'objects']
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

export type DaemonStubStatus = 'ready' | 'auth_required' | 'pending' | 'error'

export interface DaemonStubControls {
  setStatus: (status: DaemonStubStatus, overrides?: { token?: string; reason?: string | null }) => void
  getStatus: () => { status: DaemonStubStatus; token: string; reason: string | null }
}

export async function installDaemonAuthStub(page: Page, options: {
  initialStatus?: DaemonStubStatus
  token?: string
  reason?: string | null
  readyExpiresAt?: string
} = {}): Promise<DaemonStubControls> {
  const state: { status: DaemonStubStatus; token: string; reason: string | null; expiresAt: string } = {
    status: options.initialStatus ?? 'ready',
    token: options.token ?? 'daemon-token',
    reason: options.reason ?? null,
    expiresAt: options.readyExpiresAt ?? '2099-01-01T00:00:00Z',
  }

  await page.route('**/auth/status', async (route) => {
    if (state.status === 'ready') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'ready', token: state.token, expiresAt: state.expiresAt }),
      })
      return
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: state.status, reason: state.reason ?? undefined }),
    })
  })

  await page.route('**/auth/logout', async (route) => {
    state.status = 'auth_required'
    state.reason = 'signed out'
    await route.fulfill({ status: 204, body: '' })
  })

  return {
    setStatus(status, overrides) {
      state.status = status
      if (overrides?.token) {
        state.token = overrides.token
      }
      if (status === 'ready') {
        state.reason = null
      } else {
        state.reason = overrides?.reason ?? state.reason ?? null
      }
    },
    getStatus() {
      return { status: state.status, token: state.token, reason: state.reason }
    },
  }
}

export interface SupabaseMockOptions {
  userId?: string
  email?: string
  accessToken?: string
  authenticated?: boolean
}

export async function installSupabaseMock(page: Page, options: SupabaseMockOptions = {}): Promise<void> {
  const {
    userId = 'user-123',
    email = 'user@example.com',
    accessToken = 'supabase-access-token',
    authenticated = false,
  } = options
  await page.addInitScript(({ baseUserId, baseEmail, baseToken, startAuthenticated }) => {
    const globalWindow = window as typeof window & { __skipSupabaseMock?: boolean }
    if (globalWindow.__skipSupabaseMock) {
      return
    }
    console.log('[SupabaseMock] installing mock client')
    type MockSession = {
      access_token: string
      user: {
        id: string
        email: string | null
      }
    } | null

    const listeners = new Set<(event: string, nextSession: MockSession) => void>()
    let session: MockSession = null

    const notify = (event: string, nextSession: MockSession) => {
      for (const listener of Array.from(listeners)) {
        try {
          listener(event, nextSession)
        } catch (error) {
          console.warn('[SupabaseMock] listener failed', error)
        }
      }
    }

    const makeSession = (overrideEmail?: string | null): NonNullable<MockSession> => ({
      access_token: baseToken,
      user: {
        id: baseUserId,
        email: overrideEmail ?? baseEmail,
      },
    })

    const auth = {
      async getSession() {
        return { data: { session }, error: null }
      },
      async signInWithPassword(params?: { email?: string; password?: string }) {
        const loginEmail = typeof params?.email === 'string' ? params.email : baseEmail
        session = makeSession(loginEmail)
        notify('SIGNED_IN', session)
        return { data: { session }, error: null } as const
      },
      async signUp(params?: { email?: string; password?: string }) {
        const signUpEmail = typeof params?.email === 'string' ? params.email : baseEmail
        session = makeSession(signUpEmail)
        notify('SIGNED_IN', session)
        return { data: { user: session.user, session }, error: null } as const
      },
      async signOut() {
        session = null
        notify('SIGNED_OUT', session)
        return { error: null } as const
      },
      async resetPasswordForEmail() {
        return { data: {}, error: null } as const
      },
      async updateUser() {
        return { data: {}, error: null } as const
      },
      async signInAnonymously() {
        session = {
          access_token: 'anon-access-token',
          user: {
            id: 'anon-user',
            email: null,
          },
        }
        notify('SIGNED_IN', session)
        return { data: { session }, error: null } as const
      },
      onAuthStateChange(callback: (event: string, nextSession: MockSession) => void) {
        listeners.add(callback)
        callback('INITIAL_SESSION', session)
        return {
          data: {
            subscription: {
              unsubscribe() {
                listeners.delete(callback)
              },
            },
          },
        } as const
      },
    }

    Object.defineProperty(window, '__supabaseMock', {
      value: { auth },
      writable: false,
      enumerable: false,
      configurable: true,
    })

    Object.defineProperty(window, '__supabaseMockControls', {
      value: {
        getSession: () => session,
        setSession: (nextSession: MockSession) => {
          session = nextSession
          notify('SIGNED_IN', session)
        },
        clearSession: () => {
          session = null
          notify('SIGNED_OUT', session)
        },
      },
      writable: false,
      enumerable: false,
      configurable: true,
    })

    if (startAuthenticated) {
      session = makeSession(baseEmail)
      notify('SIGNED_IN', session)
    }
  }, {
    baseUserId: userId,
    baseEmail: email,
    baseToken: accessToken,
    startAuthenticated: authenticated,
  })
}
