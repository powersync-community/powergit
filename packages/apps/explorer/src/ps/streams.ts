
import * as React from 'react'
import { usePowerSync } from '@powersync/react'
import type { PowerSyncDatabase } from '@powersync/web'

const STREAM_NAMES = ['refs', 'commits', 'file_changes', 'objects'] as const

export const DEFAULT_REPO_SLUGS = resolveDefaultRepos(import.meta.env.VITE_POWERSYNC_DEFAULT_REPOS)

export async function openRepo(ps: PowerSyncDatabase, orgId: string, repoId: string) {
  await Promise.all(
    STREAM_NAMES.map((name) => ps.subscribeStream(`orgs/${orgId}/repos/${repoId}/${name}`))
  )
}

export async function openOrg(ps: PowerSyncDatabase, orgId: string, repoIds: readonly string[]) {
  const targets = resolveRepoTargets(repoIds)
  await Promise.all(targets.map((repoId) => openRepo(ps, orgId, repoId)))
}

export function useRepoStreams(orgId: string, repoId: string) {
  const ps = usePowerSync()
  React.useEffect(() => {
    if (!repoId) return
    let cancelled = false
    const task = async () => {
      try {
        await openRepo(ps, orgId, repoId)
      } catch (error) {
        if (!cancelled) console.error('[PowerSync] failed to subscribe repo stream', error)
      }
    }
    void task()
    return () => {
      cancelled = true
    }
  }, [ps, orgId, repoId])
}

export function useOrgStreams(orgId: string, repoIds: readonly string[]) {
  const ps = usePowerSync()
  const key = React.useMemo(() => normalizeRepoList(repoIds).join('|'), [repoIds])
  React.useEffect(() => {
    const targets = resolveRepoTargets(repoIds)
    if (targets.length === 0) return
    let cancelled = false
    const task = async () => {
      try {
        await Promise.all(targets.map((repoId) => openRepo(ps, orgId, repoId)))
      } catch (error) {
        if (!cancelled) console.error('[PowerSync] failed to subscribe org streams', error)
      }
    }
    void task()
    return () => {
      cancelled = true
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
