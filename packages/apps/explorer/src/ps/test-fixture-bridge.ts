import * as React from 'react'
import type { RepoFixturePayload } from '../testing/fixtures'

const EVENT_NAME = '__powersync:fixtures-updated'
const STORE_KEY = '__powersyncFixtureStore'
const SETTER_KEY = '__powersyncSetRepoFixture'
const CLEAR_KEY = '__powersyncClearRepoFixtures'
const GETTER_KEY = '__powersyncGetRepoFixtures'

const fixtureBridgeEnabled = import.meta.env.DEV && import.meta.env.VITE_POWERSYNC_USE_FIXTURES !== 'false'

export type RepoFixture = RepoFixturePayload & {
  branches: NonNullable<RepoFixturePayload['branches']>
  commits: NonNullable<RepoFixturePayload['commits']>
  fileChanges: NonNullable<RepoFixturePayload['fileChanges']>
}

type FixtureStore = Record<string, RepoFixture>

type FixtureEventDetail = {
  scope: 'repo'
  key: string
}

interface FixtureGlobal {
  [STORE_KEY]?: FixtureStore
  [SETTER_KEY]?: (fixture: RepoFixturePayload) => void
  [CLEAR_KEY]?: () => void
  [GETTER_KEY]?: () => FixtureStore
}

function getGlobal(): typeof window & FixtureGlobal {
  return window as typeof window & FixtureGlobal
}

function ensureStore(): FixtureStore {
  const global = getGlobal()
  if (!global[STORE_KEY]) {
    global[STORE_KEY] = Object.create(null)
  }
  return global[STORE_KEY] as FixtureStore
}

function makeRepoKey(orgId: string, repoId: string): string {
  return `${orgId}::${repoId}`
}

function normalizeFixture(fixture: RepoFixturePayload): RepoFixture {
  return {
    ...fixture,
    branches: fixture.branches ?? [],
    commits: fixture.commits ?? [],
    fileChanges: fixture.fileChanges ?? [],
  }
}

function dispatchUpdate(key: string) {
  const event = new CustomEvent<FixtureEventDetail>(EVENT_NAME, {
    detail: { scope: 'repo', key },
  })
  window.dispatchEvent(event)
}

export function initTestFixtureBridge() {
  if (!fixtureBridgeEnabled || typeof window === 'undefined') return
  const global = getGlobal()
  if (global[SETTER_KEY] && global[CLEAR_KEY]) {
    console.debug('[TestFixtureBridge] already initialized')
    return
  }

  const store = ensureStore()
  console.debug('[TestFixtureBridge] initializing fixture store')
  global[SETTER_KEY] = (fixture: RepoFixturePayload) => {
    const key = makeRepoKey(fixture.orgId, fixture.repoId)
    store[key] = normalizeFixture(fixture)
    dispatchUpdate(key)
  }

  global[CLEAR_KEY] = () => {
    for (const key of Object.keys(store)) {
      delete store[key]
    }
    dispatchUpdate('*')
  }

  global[GETTER_KEY] = () => ({ ...store })
}

export function useRepoFixture(orgId: string, repoId: string): RepoFixture | null {
  const subscribe = React.useCallback(
    (onStoreChange: () => void) => {
      if (!fixtureBridgeEnabled || typeof window === 'undefined') {
        return () => {}
      }

      const listener = (event: Event) => {
        const detail = (event as CustomEvent<FixtureEventDetail>).detail
        if (!detail) {
          onStoreChange()
          return
        }
        if (detail.scope === 'repo') {
          const key = detail.key
          if (key === '*' || key === makeRepoKey(orgId, repoId)) {
            onStoreChange()
          }
        }
      }

      window.addEventListener(EVENT_NAME, listener)
      return () => window.removeEventListener(EVENT_NAME, listener)
    },
    [orgId, repoId]
  )

  const getSnapshot = React.useCallback(() => {
  if (!fixtureBridgeEnabled || typeof window === 'undefined') return null
    const store = getGlobal()[STORE_KEY]
    if (!store) return null
    return store[makeRepoKey(orgId, repoId)] ?? null
  }, [orgId, repoId])

  const getServerSnapshot = React.useCallback(() => null, [])

  return React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}

export function getRepoFixture(orgId: string, repoId: string): RepoFixture | null {
  if (!fixtureBridgeEnabled || typeof window === 'undefined') return null
  const store = getGlobal()[STORE_KEY]
  if (!store) return null
  return store[makeRepoKey(orgId, repoId)] ?? null
}
