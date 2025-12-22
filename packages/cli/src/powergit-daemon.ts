#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'
import { loadProfileEnvironment } from '@powersync-community/powergit-core/profile-env'

const require = createRequire(import.meta.url)

async function main() {
  hydrateProfileEnv()
  hydrateDaemonStateEnv()
  const entry = require.resolve('@powersync-community/powergit-daemon')
  const args = process.argv.slice(2)

  const child = spawn(process.execPath, [entry, ...args], {
    stdio: 'inherit',
    env: process.env,
  })

  child.on('exit', (code) => {
    process.exitCode = code ?? 1
  })

  child.on('error', (error) => {
    console.error(error)
    process.exitCode = 1
  })
}

function hydrateProfileEnv() {
  const stackEnvDisabled = (process.env.POWERGIT_NO_STACK_ENV ?? '').toLowerCase() === 'true'
  const hasProfileHint =
    Boolean(process.env.STACK_PROFILE) ||
    Boolean(process.env.POWERGIT_PROFILE) ||
    Boolean(process.env.POWERGIT_ACTIVE_PROFILE)
  const hasExplicitEndpoint =
    Boolean(process.env.POWERSYNC_URL) ||
    Boolean(process.env.POWERSYNC_DAEMON_ENDPOINT) ||
    Boolean(process.env.POWERSYNC_ENDPOINT)
  if (!hasProfileHint && hasExplicitEndpoint) {
    return
  }
  try {
    const result = loadProfileEnvironment({
      updateState: false,
      includeStackEnv: !stackEnvDisabled,
    })
    for (const [key, value] of Object.entries(result.combinedEnv)) {
      if (typeof value !== 'string' || value.length === 0) continue
      if (process.env[key] === undefined || process.env[key] === '') {
        process.env[key] = value
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[powergit-daemon] Failed to load profile defaults (${message}).`)
  }
}

function resolvePowergitHome(): string {
  const override = process.env.POWERGIT_HOME
  if (override && override.trim().length > 0) {
    return resolvePath(override.trim())
  }
  return resolvePath(homedir(), '.powergit')
}

function sanitizeProfileKey(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return 'default'
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

function resolveProfileNameFromEnv(): string {
  const candidate = process.env.POWERGIT_PROFILE ?? process.env.STACK_PROFILE ?? process.env.POWERGIT_ACTIVE_PROFILE ?? 'prod'
  const trimmed = String(candidate ?? '').trim()
  return trimmed.length > 0 ? trimmed : 'prod'
}

function hydrateDaemonStateEnv() {
  const profileName = resolveProfileNameFromEnv()
  const profileKey = sanitizeProfileKey(profileName)
  const baseDir = resolvePath(resolvePowergitHome(), 'daemon', profileKey)
  if (!process.env.POWERSYNC_DAEMON_DB_PATH || process.env.POWERSYNC_DAEMON_DB_PATH.trim().length === 0) {
    process.env.POWERSYNC_DAEMON_DB_PATH = resolvePath(baseDir, 'powersync-daemon.db')
  }
  if (
    !process.env.POWERSYNC_DAEMON_SESSION_PATH ||
    process.env.POWERSYNC_DAEMON_SESSION_PATH.trim().length === 0
  ) {
    process.env.POWERSYNC_DAEMON_SESSION_PATH = resolvePath(baseDir, 'session.json')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
