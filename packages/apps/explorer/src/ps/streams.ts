
import * as React from 'react'
import { usePowerSync } from '@powersync/react'
import type { PowerSyncDatabase, SyncStreamSubscription } from '@powersync/web'
import { buildRepoStreamTargets } from '@shared/core/powersync/streams'

declare global {
  // eslint-disable-next-line no-var
  var __powersyncForceEnable: boolean | undefined
  // eslint-disable-next-line no-var
  var __powersyncForceDisable: boolean | undefined
}

function isPowerSyncDisabled(): boolean {
  const envDisabled = import.meta.env.VITE_POWERSYNC_DISABLED === 'true'
  if (typeof globalThis === 'object' && globalThis) {
    const globalOverrides = globalThis as typeof globalThis & {
      __powersyncForceEnable?: unknown
      __powersyncForceDisable?: unknown
    }
    if (globalOverrides.__powersyncForceEnable === true) {
      return false
    }
    if (globalOverrides.__powersyncForceDisable === true) {
      return true
    }
  }
  return envDisabled
}

export const DEFAULT_REPO_SLUGS = resolveDefaultRepos(import.meta.env.VITE_POWERSYNC_DEFAULT_REPOS)

type StreamTarget = {
  id: string
  params?: Record<string, unknown> | null
}

function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function hasDatabaseClosingMessage(message: unknown): boolean {
  if (typeof message !== 'string') return false
  const normalized = message.toLowerCase()
  return normalized.includes('database is closing') || normalized.includes('database closing')
}

function isDatabaseClosingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if (hasDatabaseClosingMessage(error.message)) {
    return true
  }
  const cause = (error as { cause?: unknown }).cause
  if (cause instanceof Error) {
    return isDatabaseClosingError(cause)
  }
  if (hasDatabaseClosingMessage(cause)) {
    return true
  }
  return false
}

async function subscribeToStreams(ps: PowerSyncDatabase, targets: readonly StreamTarget[]) {
  const maxAttempts = 5
  let lastError: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await ps.waitForReady().catch(() => undefined)
    const subscriptions: SyncStreamSubscription[] = []
    try {
      for (const target of targets) {
        const stream = ps.syncStream(target.id, target.params ?? undefined)
        const subscription = await stream.subscribe()
        subscriptions.push(subscription)
        if (import.meta.env.DEV) {
          console.debug('[PowerSync][streams] subscribed', target.id, target.params ?? null)
        }
      }
      return subscriptions
    } catch (error) {
      subscriptions.forEach((subscription) => subscription.unsubscribe())

      if (isDatabaseClosingError(error)) {
        if (import.meta.env.DEV) {
          console.debug('[PowerSync][streams] database closing detected, retrying subscribe', error)
        }
        lastError = error
        if (attempt === maxAttempts) {
          return []
        }
        await delay(50 * attempt)
        continue
      }

      lastError = error
      if (attempt === maxAttempts) {
        throw error
      }
      await delay(Math.min(500 * attempt, 2000))
    }
  }
  if (lastError) {
    throw lastError
  }
  return []
}

export async function openRepo(ps: PowerSyncDatabase, orgId: string, repoId: string) {
  const targets: StreamTarget[] = buildRepoStreamTargets(orgId, repoId).map(({ id, parameters }) => ({
    id,
    params: parameters,
  }))
  return subscribeToStreams(ps, targets)
}

export async function openOrg(ps: PowerSyncDatabase, orgId: string, repoIds: readonly string[]) {
  const targets = resolveRepoTargets(repoIds)
  const subscriptions = await Promise.all(
    targets.map((repoId) =>
      subscribeToStreams(
        ps,
        buildRepoStreamTargets(orgId, repoId).map(({ id, parameters }) => ({
          id,
          params: parameters,
        })),
      ),
    ),
  )
  return subscriptions.flat()
}

export function useRepoStreams(orgId: string, repoId: string) {
  const ps = usePowerSync() as PowerSyncDatabase | null

  React.useEffect(() => {
    if (!ps || !repoId || isPowerSyncDisabled()) return undefined
    if (import.meta.env.DEV) {
      console.debug('[PowerSync][streams] useRepoStreams start', { orgId, repoId, hasPs: !!ps })
    }
    let disposed = false
    let active: SyncStreamSubscription[] = []

    const task = async () => {
      try {
        const subscriptions = await openRepo(ps, orgId, repoId)
        if (disposed) {
          subscriptions.forEach((subscription) => subscription.unsubscribe())
          return
        }
        active = subscriptions
        if (import.meta.env.DEV) {
          console.debug('[PowerSync][streams] repo subscriptions active', active.length)
        }
      } catch (error) {
        if (!disposed) console.error('[PowerSync] failed to subscribe repo stream', error)
      }
    }

    void task()

    return () => {
      disposed = true
      if (active.length > 0) {
        active.forEach((subscription) => subscription.unsubscribe())
        active = []
      }
    }
  }, [ps, orgId, repoId])
}

export function useOrgStreams(orgId: string, repoIds: readonly string[]) {
  const ps = usePowerSync() as PowerSyncDatabase | null
  const key = React.useMemo(() => normalizeRepoList(repoIds).join('|'), [repoIds])

  React.useEffect(() => {
    if (!ps || isPowerSyncDisabled()) return undefined
    const targets = resolveRepoTargets(repoIds)
    if (targets.length === 0) return undefined

    let disposed = false
    let active: SyncStreamSubscription[] = []

    const task = async () => {
      try {
        active = await Promise.all(targets.map((repoId) => openRepo(ps, orgId, repoId))).then((rows) => rows.flat())
      } catch (error) {
        if (!disposed) console.error('[PowerSync] failed to subscribe org streams', error)
      }
    }

    void task()

    return () => {
      disposed = true
      active.forEach((subscription) => subscription.unsubscribe())
    }
  }, [ps, orgId, key])
}

export function normalizeRepoList(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
}

export function resolveDefaultRepos(raw?: string): string[] {
  const parsed = normalizeRepoList(raw ? raw.split(',') : [])
  if (parsed.length > 0) return parsed
  return ['infra']
}

export function resolveRepoTargets(input: readonly string[]): string[] {
  const fromInput = normalizeRepoList(input)
  if (fromInput.length > 0) return fromInput
  return DEFAULT_REPO_SLUGS
}
