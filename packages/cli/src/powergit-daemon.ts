#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { loadProfileEnvironment } from './profile-env.js'

const require = createRequire(import.meta.url)

async function main() {
  hydrateProfileEnv()
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

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
