#!/usr/bin/env node

import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative } from 'node:path'
import { writeFile, mkdir as mkdirAsync } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createConnection } from 'node:net'
import { inspect } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'

const STACK_ENV_FILENAME = '.env.powersync-stack'
const DEFAULT_ORG = process.env.POWERSYNC_STACK_ORG ?? 'demo'
const DEFAULT_REPO = process.env.POWERSYNC_STACK_REPO ?? 'infra'
const DEFAULT_REMOTE_NAME = process.env.POWERSYNC_STACK_REMOTE ?? 'powersync'
const POWERSYNC_PORT = process.env.POWERSYNC_PORT ?? '55440'
const SUPABASE_PORT = process.env.SUPABASE_API_PORT ?? process.env.SUPABASE_PORT ?? '55431'
const DEFAULT_POWERSYNC_ENDPOINT = `http://127.0.0.1:${POWERSYNC_PORT}`
const DEFAULT_SUPABASE_URL = `http://127.0.0.1:${SUPABASE_PORT}`

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..')

let cliOptions
let logStream
let logFilePath

function parseArgs(rawArgs) {
  const options = {
    command: 'start',
    log: false,
    logDir: resolve(repoRoot, 'logs', 'dev-stack'),
    printExports: false,
    skipEnvFile: false,
    skipSeeds: false,
    skipDemoSeed: false,
    skipSyncRules: false,
    dryRun: false,
    unknown: [],
  }

  for (let i = 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i]

    if (arg === '--') {
      options.unknown.push(...rawArgs.slice(i + 1))
      break
    }

    switch (arg) {
      case 'start':
      case '--start':
        options.command = 'start'
        break
      case 'stop':
      case '--stop':
        options.command = 'stop'
        break
      case 'help':
      case '--help':
      case '-h':
        options.command = 'help'
        break
      case '--log':
        options.log = true
        break
      case '--log-dir':
        if (i + 1 >= rawArgs.length) {
          throw new Error('--log-dir expects a directory path')
        }
        options.log = true
        options.logDir = resolve(repoRoot, rawArgs[i + 1])
        i += 1
        break
      case '--print-exports':
      case '--print-env':
      case '--shell-output':
        options.printExports = true
        break
      case '--no-env-file':
      case '--no-file':
        options.skipEnvFile = true
        break
      case '--skip-seeds':
      case '--no-seed':
        options.skipSeeds = true
        options.skipDemoSeed = true
        options.skipSyncRules = true
        break
      case '--skip-demo-seed':
      case '--no-demo-seed':
      case '--no-demo':
        options.skipDemoSeed = true
        break
      case '--skip-sync-rules':
      case '--no-sync-rules':
        options.skipSyncRules = true
        break
      case '--dry-run':
        options.dryRun = true
        break
      default:
        if (!arg.startsWith('-') && options.command === 'start') {
          // Allow positional command without requiring explicit keyword first.
          options.command = arg
        } else {
          options.unknown.push(arg)
        }
        break
    }
  }

  if (options.command !== 'start' && options.command !== 'stop' && options.command !== 'help') {
    throw new Error(`Unknown command: ${options.command}`)
  }

  return options
}

function formatForLog(args) {
  return args
    .map((arg) => (typeof arg === 'string' ? arg : inspect(arg, { depth: 5, colors: false })))
    .join(' ')
}

function writeLogLine(...args) {
  if (!logStream) return
  const line = formatForLog(args)
  logStream.write(line)
  if (!line.endsWith('\n')) {
    logStream.write('\n')
  }
}

function infoLog(...args) {
  if (cliOptions?.printExports) {
    console.error(...args)
  } else {
    console.log(...args)
  }
  writeLogLine(...args)
}

function warnLog(...args) {
  console.warn(...args)
  writeLogLine(...args)
}

function errorLog(...args) {
  console.error(...args)
  writeLogLine(...args)
}

async function initLogging() {
  if (!cliOptions.log) {
    return { close: async () => {}, path: null }
  }

  await mkdirAsync(cliOptions.logDir, { recursive: true })
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  const filename = `${cliOptions.command}-${timestamp}.log`
  logFilePath = resolve(cliOptions.logDir, filename)
  logStream = createWriteStream(logFilePath, { flags: 'a' })
  writeLogLine(`# pnpm dev:stack ${cliOptions.command} @ ${new Date().toISOString()}`)

  const handleSignal = (signal) => {
    process.off('SIGINT', handleSignal)
    process.off('SIGTERM', handleSignal)

    if (!logStream) {
      process.kill(process.pid, signal)
      return
    }

    logStream.end(() => {
      logStream = null
      process.kill(process.pid, signal)
    })
  }

  process.on('SIGINT', handleSignal)
  process.on('SIGTERM', handleSignal)

  return {
    path: logFilePath,
    close: async () =>
      new Promise((resolvePromise) => {
        if (!logStream) {
          resolvePromise()
          return
        }
        logStream.end(resolvePromise)
        logStream = null
      }),
  }
}

async function runCommand(cmd, args, options = {}) {
  const display = `${cmd} ${args.join(' ')}`
  writeLogLine(`$ ${display}`)

  if (cliOptions.dryRun) {
    infoLog(`[dry-run] ${display}`)
    return
  }

  infoLog(`→ ${display}`)

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd: options.cwd ?? repoRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: options.stdio ?? ['inherit', 'pipe', 'pipe'],
    })

    if (!options.stdio || options.stdio[1] !== 'inherit') {
      child.stdout?.on('data', (chunk) => {
        const target = cliOptions.printExports ? process.stderr : process.stdout
        target.write(chunk)
        if (logStream) logStream.write(chunk)
      })
    }

    if (!options.stdio || options.stdio[2] !== 'inherit') {
      child.stderr?.on('data', (chunk) => {
        process.stderr.write(chunk)
        if (logStream) logStream.write(chunk)
      })
    }

    child.on('error', (error) => rejectPromise(error))

    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise()
      } else {
        rejectPromise(new Error(`${cmd} exited with code ${code}`))
      }
    })
  })
}

async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(url, { signal: controller.signal })
    return { ok: true, status: response.status }
  } catch (error) {
    return { ok: false, error }
  } finally {
    clearTimeout(timer)
  }
}

async function checkTcpConnectivity(host, port, timeoutMs) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host, port })
    let settled = false

    const finish = (ok, error) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolvePromise({ ok, error })
    }

    socket.setTimeout(timeoutMs)
    socket.once('error', (error) => finish(false, error))
    socket.once('timeout', () => finish(false, new Error(`TCP timeout after ${timeoutMs}ms`)))
    socket.once('connect', () => finish(true))
  })
}

async function probePowerSyncEndpoint(endpoint, requestTimeoutMs) {
  let lastError
  const baseUrl = new URL(endpoint)
  const candidates = [new URL('/health', baseUrl), baseUrl]

  for (const candidate of candidates) {
    const result = await fetchWithTimeout(candidate, requestTimeoutMs)
    if (result.ok) {
      return { ok: true }
    }
    if (result.error) {
      lastError = result.error
    }
  }

  const port = baseUrl.port ? Number.parseInt(baseUrl.port, 10) : baseUrl.protocol === 'https:' ? 443 : 80
  const tcpResult = await checkTcpConnectivity(baseUrl.hostname, port, requestTimeoutMs)
  if (tcpResult.ok) {
    return { ok: true }
  }

  return { ok: false, error: tcpResult.error ?? lastError }
}

async function waitForPowerSyncReady(endpoint) {
  if (!endpoint) {
    throw new Error('PowerSync endpoint is not defined; set POWERSYNC_ENDPOINT or ensure Supabase status output includes API_URL.')
  }

  if (cliOptions?.dryRun) {
    infoLog(`[dry-run] Skipping PowerSync readiness check for ${endpoint}`)
    return
  }

  const maxAttempts = Number.parseInt(process.env.POWERSYNC_READY_ATTEMPTS ?? '15', 10)
  const requestTimeoutMs = Number.parseInt(process.env.POWERSYNC_READY_REQUEST_TIMEOUT_MS ?? '2000', 10)
  const backoffMs = Number.parseInt(process.env.POWERSYNC_READY_DELAY_MS ?? '1000', 10)

  infoLog(`[dev:stack] Verifying PowerSync availability at ${endpoint}`)

  let lastError

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await probePowerSyncEndpoint(endpoint, requestTimeoutMs)
    if (result.ok) {
      const attemptText = attempt === 1 ? 'immediately' : `after ${attempt} attempt(s)`
      infoLog(`[dev:stack] PowerSync endpoint responded ${attemptText}.`)
      return
    }

    if (result.error) {
      lastError = result.error
    }

    if (attempt < maxAttempts) {
      const waitMs = Math.min(backoffMs * attempt, 5000)
      infoLog(`[dev:stack] PowerSync not ready yet (attempt ${attempt}/${maxAttempts}). Retrying in ${waitMs}ms...`)
      await delay(waitMs)
    }
  }

  const hint = lastError?.message ? ` Last error: ${lastError.message}` : ''
  throw new Error(`PowerSync endpoint ${endpoint} did not become reachable.${hint}`)
}

async function ensureWorkspaceBinaries() {
  try {
    await runCommand('pnpm', ['--filter', '@pkg/remote-helper', 'build'])
  } catch (error) {
    warnLog('[dev:stack] Warning: failed to build remote helper.', error?.message ?? error)
  }

  try {
    await runCommand('pnpm', ['--filter', '@pkg/cli', 'build'])
  } catch (error) {
    warnLog('[dev:stack] Warning: failed to build @pkg/cli.', error?.message ?? error)
  }
}

async function supabaseStatusEnv() {
  if (cliOptions.dryRun) {
    return {}
  }

  try {
    const { stdout } = await new Promise((resolvePromise, rejectPromise) => {
      execFile('supabase', ['status', '--output', 'env'], { cwd: repoRoot }, (error, out, err) => {
        if (error) {
          rejectPromise(Object.assign(error, { stderr: err }))
        } else {
          resolvePromise({ stdout: out })
        }
      })
    })

    const entries = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const idx = line.indexOf('=')
        if (idx === -1) return null
        const key = line.slice(0, idx).trim()
        let value = line.slice(idx + 1).trim()
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }
        return [key, value]
      })
      .filter(Boolean)
    return Object.fromEntries(entries)
  } catch (error) {
    warnLog('[dev:stack] Failed to read Supabase status env – using defaults.', error?.message ?? error)
    return {}
  }
}

function stripPowersyncScheme(remoteUrl) {
  if (!remoteUrl) return remoteUrl
  if (remoteUrl.startsWith('powersync::')) {
    return remoteUrl.slice('powersync::'.length)
  }
  return remoteUrl
}

function buildStackEnv(statusEnv) {
  const supabaseUrl = (statusEnv.API_URL ?? statusEnv.SUPABASE_URL ?? DEFAULT_SUPABASE_URL).replace(/\/$/, '')
  const functionsUrl = `${supabaseUrl}/functions/v1`
  const serviceRoleKey = statusEnv.SERVICE_ROLE_KEY ?? process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY ?? 'service-role-placeholder'
  const anonKey = statusEnv.ANON_KEY ?? process.env.POWERSYNC_SUPABASE_ANON_KEY ?? 'anon-placeholder'
  const powersyncEndpoint = process.env.POWERSYNC_ENDPOINT ?? DEFAULT_POWERSYNC_ENDPOINT
  const defaultRemoteEndpoint = functionsUrl ? `${functionsUrl}/powersync-remote` : powersyncEndpoint
  const powersyncRemoteEndpoint = (process.env.POWERSYNC_REMOTE_ENDPOINT ?? defaultRemoteEndpoint).replace(/\/$/, '')
  const powersyncToken =
    process.env.POWERSYNC_TOKEN ?? process.env.POWERSYNC_REMOTE_TOKEN ?? undefined
  const remoteUrl = `powersync::${powersyncRemoteEndpoint.replace(/\/$/, '')}/orgs/${DEFAULT_ORG}/repos/${DEFAULT_REPO}`
  const databaseUrl = statusEnv.DATABASE_URL ?? statusEnv.DB_URL ?? process.env.POWERSYNC_DATABASE_URL ?? process.env.SUPABASE_DB_URL

  return {
    supabaseUrl,
    functionsUrl,
    serviceRoleKey,
    anonKey,
    powersyncEndpoint,
    powersyncRemoteEndpoint,
    powersyncToken,
    remoteUrl,
    remoteHttpUrl: stripPowersyncScheme(remoteUrl),
    databaseUrl,
  }
}

function buildExportLines(env) {
  const lines = [
    '# Auto-generated by pnpm dev:stack',
    `export PSGIT_TEST_REMOTE_URL=${JSON.stringify(env.remoteUrl)}`,
    `export PSGIT_TEST_REMOTE_NAME=${JSON.stringify(DEFAULT_REMOTE_NAME)}`,
    `export PSGIT_TEST_FUNCTIONS_URL=${JSON.stringify(env.functionsUrl)}`,
    `export PSGIT_TEST_SERVICE_ROLE_KEY=${JSON.stringify(env.serviceRoleKey)}`,
    `export PSGIT_TEST_SUPABASE_URL=${JSON.stringify(env.supabaseUrl)}`,
    `export PSGIT_TEST_ENDPOINT=${JSON.stringify(env.powersyncEndpoint)}`,
    `export PSGIT_TEST_REMOTE_TOKEN=${JSON.stringify(env.powersyncToken)}`,
    '',
    '# Optional extras for explorer / local tooling',
    `export POWERSYNC_ENDPOINT=${JSON.stringify(env.powersyncEndpoint)}`,
    `export POWERSYNC_REMOTE_ENDPOINT=${JSON.stringify(env.powersyncRemoteEndpoint)}`,
    `export POWERSYNC_SUPABASE_URL=${JSON.stringify(env.supabaseUrl)}`,
    `export POWERSYNC_SUPABASE_FUNCTIONS_URL=${JSON.stringify(env.functionsUrl)}`,
    `export POWERSYNC_SUPABASE_SERVICE_ROLE_KEY=${JSON.stringify(env.serviceRoleKey)}`,
    `export POWERSYNC_SUPABASE_ANON_KEY=${JSON.stringify(env.anonKey)}`,
  ]

  if (env.powersyncToken) {
    lines.push(`export POWERSYNC_TOKEN=${JSON.stringify(env.powersyncToken)}`)
  } else {
    lines.push('# export POWERSYNC_TOKEN=<use pnpm dev:stack creds or Supabase function powersync-creds>')
  }

  lines.push('')
  return lines
}

async function writeStackEnvFile(env) {
  const lines = buildExportLines(env)
  const filePath = resolve(repoRoot, STACK_ENV_FILENAME)

  if (cliOptions.dryRun || cliOptions.skipEnvFile) {
    infoLog(`[skip] ${STACK_ENV_FILENAME} ${cliOptions.dryRun ? '(dry-run)' : '(disabled via flag)'}`)
    return lines
  }

  await writeFile(filePath, lines.join('\n'))
  infoLog(`💾 Wrote stack environment exports to ${STACK_ENV_FILENAME}`)
  infoLog(`   source ${STACK_ENV_FILENAME}  # apply in your current shell (zsh/bash/fish)`)
  return lines
}

async function seedSyncRules(env) {
  if (cliOptions.skipSeeds || cliOptions.skipSyncRules) {
    infoLog('[skip] Sync rules seed disabled via flag.')
    return
  }

  await runCommand('node', ['scripts/seed-sync-rules.mjs'], {
    env: {
      POWERSYNC_DATABASE_URL: env.databaseUrl ?? process.env.POWERSYNC_DATABASE_URL,
      SUPABASE_DB_URL: env.databaseUrl ?? process.env.SUPABASE_DB_URL,
      SUPABASE_DB_CONNECTION_STRING: env.databaseUrl ?? process.env.SUPABASE_DB_CONNECTION_STRING,
      DATABASE_URL: env.databaseUrl ?? process.env.DATABASE_URL,
    },
  })
  infoLog('✅ Supabase stream metadata synced from config.yaml')
}

async function seedDemoRepo(env) {
  if (cliOptions.skipSeeds || cliOptions.skipDemoSeed) {
    infoLog('[skip] Demo repository seed disabled via flag.')
    return
  }

  const cliBin = resolve(repoRoot, 'packages/cli/dist/cli/src/bin.js')
  const branch = process.env.POWERSYNC_SEED_BRANCH ?? 'main'

  await runCommand('node', [cliBin, 'demo-seed', '--remote-url', env.remoteUrl, '--remote', DEFAULT_REMOTE_NAME, '--branch', branch], {
    env: {
      POWERSYNC_SUPABASE_FUNCTIONS_URL: env.functionsUrl,
      POWERSYNC_SUPABASE_SERVICE_ROLE_KEY: env.serviceRoleKey,
      POWERSYNC_SUPABASE_URL: env.supabaseUrl,
      POWERSYNC_ENDPOINT: env.powersyncEndpoint,
      POWERSYNC_TOKEN: env.powersyncToken,
    },
  })
  infoLog(`✅ Seeded demo repo to ${env.remoteUrl}`)
}

async function ensurePowerSyncToken(env) {
  if (env.powersyncToken) {
    return env.powersyncToken
  }

  const functionsUrl = env.functionsUrl?.replace(/\/+$/, '')
  const serviceRoleKey = env.serviceRoleKey
  const remoteUrl = env.remoteHttpUrl
  const functionName = process.env.POWERSYNC_SUPABASE_REMOTE_FN ?? 'powersync-remote-token'

  if (!functionsUrl || !serviceRoleKey || !remoteUrl) {
    return undefined
  }

  const targetUrl = `${functionsUrl}/${functionName}`
  infoLog(`[dev:stack] Requesting PowerSync remote token via ${functionName}`)

  try {
    const response = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ remoteUrl }),
    })

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }

    const result = await response.json().catch(() => ({}))
    const token = typeof result?.token === 'string' && result.token.length > 0 ? result.token : null

    if (!token) {
      warnLog('[dev:stack] Supabase remote token response did not include a token.')
      return undefined
    }

    env.powersyncToken = token
    infoLog('[dev:stack] Obtained PowerSync remote token for default repo.')
    return token
  } catch (error) {
    warnLog('[dev:stack] Failed to fetch PowerSync remote token.', error?.message ?? error)
    return undefined
  }
}

async function startStack() {
  await runCommand('supabase', ['start'])
  const statusEnv = await supabaseStatusEnv()
  const env = buildStackEnv(statusEnv)

  const powersyncEnv = {}

  await runCommand('docker', ['compose', '-f', 'supabase/docker-compose.powersync.yml', 'up', '-d', '--wait'], {
    env: powersyncEnv,
  })
  await runCommand('supabase', ['functions', 'deploy'], {
    env: powersyncEnv,
  })

  await ensureWorkspaceBinaries()

  await ensurePowerSyncToken(env)

  const exportLines = await writeStackEnvFile(env)

  await waitForPowerSyncReady(env.powersyncEndpoint)

  try {
    await seedSyncRules(env)
  } catch (error) {
    warnLog('[dev:stack] Warning: failed to apply sync rules.', error?.message ?? error)
  }

  try {
    await seedDemoRepo(env)
  } catch (error) {
    warnLog('[dev:stack] Warning: failed to seed demo repo.', error?.message ?? error)
  }

  infoLog('✨ Supabase + PowerSync stack is ready.')
  infoLog(`   Remote name: ${DEFAULT_REMOTE_NAME}`)
  infoLog(`   Remote URL: ${env.remoteUrl}`)
  infoLog(`   Functions URL: ${env.functionsUrl}`)
  infoLog('   Use source .env.powersync-stack before running CLI e2e tests.')

  if (cliOptions.printExports) {
    exportLines.forEach((line) => process.stdout.write(`${line}\n`))
  } else if (!cliOptions.skipEnvFile) {
    infoLog('   Tip: run source <(pnpm dev:stack -- --print-exports) to auto-apply in your shell.')
  }
}

async function stopStack() {
  await runCommand('docker', ['compose', '-f', 'supabase/docker-compose.powersync.yml', 'down'])
  await runCommand('supabase', ['stop'])
  infoLog('✅ Supabase + PowerSync stack stopped.')
}

function printHelp() {
  const relLogDir = relative(repoRoot, cliOptions.logDir)
  const lines = [
    'Usage: pnpm dev:stack [command] [options]',
    '',
    'Commands:',
    '  start               Start Supabase + PowerSync (default).',
    '  stop                Stop the running services.',
    '  help                Show this help message.',
    '',
    'Options:',
    '  --log               Tee output to logs/dev-stack/<timestamp>.log.',
    `  --log-dir <dir>     Override log directory (default ${relLogDir || './logs/dev-stack'}).`,
    '  --print-exports     Emit shell exports to stdout for sourcing.',
    '  --no-env-file       Skip writing .env.powersync-stack.',
    '  --skip-sync-rules   Skip seeding sync rules into Supabase.',
    '  --skip-demo-seed    Skip seeding the demo repository.',
    '  --skip-seeds        Skip all seeding (sync rules + demo).',
    '  --dry-run           Print the steps without executing commands.',
    '',
    'Examples:',
    '  pnpm dev:stack                            # Start the stack',
    '  pnpm dev:stack stop                       # Stop everything',
    '  pnpm dev:stack -- --print-exports         # Start and emit shell exports',
    '  pnpm dev:stack start --log --log-dir tmp  # Start with logs in tmp/',
  ]

  lines.forEach((line) => console.log(line))
}

async function main() {
  try {
    cliOptions = parseArgs(process.argv.slice(2))
  } catch (error) {
    errorLog(error.message)
    process.exit(1)
    return
  }

  if (cliOptions.unknown.length > 0) {
    warnLog(`[dev:stack] Ignoring unknown arguments: ${cliOptions.unknown.join(', ')}`)
  }

  if (cliOptions.command === 'help') {
    printHelp()
    return
  }

  const { path: logPath, close } = await initLogging()

  if (logPath) {
    const rel = relative(process.cwd(), logPath)
    console.log(`📜 Logging stack output to ${rel}`)
  }

  try {
    if (cliOptions.command === 'start') {
      await startStack()
    } else if (cliOptions.command === 'stop') {
      await stopStack()
    }
  } catch (error) {
    errorLog('Local stack command failed:', error)
    process.exitCode = 1
  } finally {
    await close()
  }
}

main().catch((error) => {
  errorLog('Local stack script crashed:', error)
  process.exit(1)
})

