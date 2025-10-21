#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { loadProfileEnvironment } from '../../../cli/src/profile-env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '../../../..')
function parseOptions(rawArgs) {
  const options = {
    profile: null,
    printEnv: false,
    passthrough: [],
  }

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]
    if (arg === '--profile') {
      if (i + 1 >= rawArgs.length) {
        throw new Error('--profile expects a value')
      }
      options.profile = rawArgs[i + 1]
      i += 1
      continue
    }
    if (arg === '--print-env') {
      options.printEnv = true
      continue
    }
    options.passthrough.push(arg)
  }

  return options
}

function applyDefaults(env) {
  if (!env.VITE_PORT || env.VITE_PORT.trim().length === 0) {
    env.VITE_PORT = '5783'
  }
  if (!env.VITE_SUPABASE_URL || env.VITE_SUPABASE_URL.trim().length === 0) {
    env.VITE_SUPABASE_URL = 'http://127.0.0.1:55431'
  }
  if (!env.VITE_SUPABASE_ANON_KEY || env.VITE_SUPABASE_ANON_KEY.trim().length === 0) {
    env.VITE_SUPABASE_ANON_KEY =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0'
  }
  if (!env.VITE_POWERSYNC_ENDPOINT || env.VITE_POWERSYNC_ENDPOINT.trim().length === 0) {
    env.VITE_POWERSYNC_ENDPOINT = 'http://127.0.0.1:55440'
  }
  if (!env.POWERSYNC_DAEMON_DEVICE_URL || env.POWERSYNC_DAEMON_DEVICE_URL.trim().length === 0) {
    env.POWERSYNC_DAEMON_DEVICE_URL = `http://localhost:${env.VITE_PORT}/auth`
  }
  if (!env.NODE_ENV || env.NODE_ENV.trim().length === 0) {
    env.NODE_ENV = 'development'
  }
}

function main() {
  const options = parseOptions(process.argv.slice(2))
  let profileResult
  try {
    profileResult = loadProfileEnvironment({
      profile: options.profile,
      startDir: repoRoot,
      updateState: false,
      strict: Boolean(options.profile),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[explorer] ${message}`)
    process.exit(1)
  }

  const mergedEnv = { ...process.env, ...profileResult.combinedEnv }
  applyDefaults(mergedEnv)

  if (!options.printEnv) {
    console.info('[explorer] dev server starting with:')
    console.info(`  profile=${profileResult.profile.name}`)
    if (profileResult.stackEnvPath) {
      console.info(`  stack-env=${profileResult.stackEnvPath}`)
    }
    console.info(`  VITE_SUPABASE_URL=${mergedEnv.VITE_SUPABASE_URL}`)
    console.info(`  VITE_POWERSYNC_ENDPOINT=${mergedEnv.VITE_POWERSYNC_ENDPOINT}`)
    console.info(`  POWERSYNC_DAEMON_DEVICE_URL=${mergedEnv.POWERSYNC_DAEMON_DEVICE_URL}`)
  }

  const childEnv = { ...mergedEnv }
  if (options.printEnv) {
    for (const [key, value] of Object.entries(childEnv)) {
      console.log(`${key}=${value}`)
    }
    return
  }

  const child = spawn(
    'vite',
    options.passthrough,
    {
      stdio: 'inherit',
      env: childEnv,
    },
  )

  child.on('close', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal)
    } else {
      process.exit(code ?? 0)
    }
  })

  child.on('error', (error) => {
    console.error('[explorer] failed to launch Vite dev server:', error)
    process.exit(1)
  })
}

main()
