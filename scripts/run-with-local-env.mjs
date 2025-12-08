#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [, , ...cliArgs] = process.argv
if (cliArgs.length === 0) {
  console.error('[run-with-local-env] Missing command to execute. Usage: node run-with-local-env.mjs <cmd> [args...]')
  process.exit(1)
}

function loadEnvFile(path, { overwrite = false } = {}) {
  if (!existsSync(path)) return
  try {
    const content = readFileSync(path, 'utf8')
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx === -1) continue
      const key = trimmed.slice(0, idx).trim()
      if (!key) continue
      let value = trimmed.slice(idx + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      if (overwrite || !(key in process.env)) {
        process.env[key] = value
      }
    }
  } catch (error) {
    console.warn(`[run-with-local-env] Failed to load ${path}:`, error.message ?? error)
  }
}

const cwd = process.cwd()
const envLocalPath = resolve(cwd, '.env.local')
const envProdPath = resolve(cwd, '.env.prod')
const isProdMode =
  process.env.STACK_PROFILE === 'prod' ||
  process.env.NODE_ENV === 'production' ||
  cliArgs.some((arg) => typeof arg === 'string' && arg.includes('dev:prod'))

// Base defaults
loadEnvFile(envLocalPath, { overwrite: false })
// In prod mode, allow .env.prod to override anything previously loaded
if (isProdMode) {
  loadEnvFile(envProdPath, { overwrite: true })
}

const [command, ...args] = cliArgs
const child = spawn(command, args, { stdio: 'inherit', env: process.env })
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
  } else {
    process.exit(code ?? 0)
  }
})
child.on('error', (error) => {
  console.error('[run-with-local-env] Failed to launch', command, error)
  process.exit(1)
})
