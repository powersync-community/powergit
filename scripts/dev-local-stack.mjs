#!/usr/bin/env node

import { spawn, execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve, relative } from 'node:path'
import { writeFile, mkdir as mkdirAsync, readFile } from 'node:fs/promises'
import { createWriteStream, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createConnection } from 'node:net'
import { inspect } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from 'pg'

const STACK_ENV_FILENAME = '.env.powersync-stack'
const DEFAULT_ORG = process.env.POWERSYNC_STACK_ORG ?? 'demo'
const DEFAULT_REPO = process.env.POWERSYNC_STACK_REPO ?? 'infra'
const DEFAULT_REMOTE_NAME = process.env.POWERSYNC_STACK_REMOTE ?? 'powersync'
const POWERSYNC_PORT = process.env.POWERSYNC_PORT ?? '55440'
const POWERSYNC_INTERNAL_PORT = process.env.POWERSYNC_INTERNAL_PORT ?? '3000'
const SUPABASE_PORT = process.env.SUPABASE_API_PORT ?? process.env.SUPABASE_PORT ?? '55431'
const DEFAULT_LOCAL_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:55432/postgres'
const DEFAULT_SUPABASE_URL = `http://127.0.0.1:${SUPABASE_PORT}`

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const repoRoot = resolve(__dirname, '..')
const requireForScript = createRequire(import.meta.url)

function resolveSupabaseBinFromWorkspace() {
  try {
    const packagePath = requireForScript.resolve('@supabase/cli/package.json')
    const packageDir = dirname(packagePath)
    const candidate = resolve(packageDir, 'bin', 'supabase')
    if (existsSync(candidate)) {
      return candidate
    }
  } catch {
    // ignored – fall back to system binary
  }
  return null
}

const DEFAULT_SUPABASE_BIN = resolveSupabaseBinFromWorkspace() ?? 'supabase'
const SUPABASE_BIN = process.env.SUPABASE_BIN ?? DEFAULT_SUPABASE_BIN
const DOCKER_BIN = process.env.DOCKER_BIN ?? 'docker'

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

function normalizeEnvValues(entries) {
  return Object.entries(entries).reduce((accumulator, [key, value]) => {
    if (value == null) return accumulator
    accumulator[key] = typeof value === 'string' ? value : String(value)
    return accumulator
  }, {})
}

function transformLocalUrlForDocker(urlString) {
  if (!urlString) return urlString
  try {
    const url = new URL(urlString)
    if (['localhost', '127.0.0.1', '0.0.0.0'].includes(url.hostname)) {
      url.hostname = 'host.docker.internal'
      return url.toString()
    }
    return urlString
  } catch {
    return urlString
  }
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
  await runCommand('pnpm', ['--filter', '@pkg/remote-helper', 'build']).catch((error) => {
    errorLog('[dev:stack] Failed to build remote helper.', error?.message ?? error)
    throw error
  })

  await runCommand('pnpm', ['--filter', '@pkg/cli', 'build']).catch((error) => {
    errorLog('[dev:stack] Failed to build @pkg/cli.', error?.message ?? error)
    throw error
  })
}

async function supabaseStatusEnv() {
  if (cliOptions.dryRun) {
    return {}
  }

  try {
    const { stdout } = await new Promise((resolvePromise, rejectPromise) => {
      execFile(SUPABASE_BIN, ['status', '--output', 'env'], { cwd: repoRoot }, (error, out, err) => {
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
  const resolvedDatabaseUrl =
    statusEnv.DATABASE_URL ??
    statusEnv.DB_URL ??
    statusEnv.DB_CONNECTION_STRING ??
    process.env.SUPABASE_DB_URL ??
    process.env.SUPABASE_DB_CONNECTION_STRING ??
    process.env.DATABASE_URL ??
    DEFAULT_LOCAL_DB_URL
  const primaryDatabaseUrl =
    process.env.POWERSYNC_DATABASE_URL ?? statusEnv.POWERSYNC_DATABASE_URL ?? resolvedDatabaseUrl
  const hostDatabaseUrl = primaryDatabaseUrl
  const containerDatabaseUrl =
    process.env.POWERSYNC_CONTAINER_DATABASE_URL ??
    transformLocalUrlForDocker(primaryDatabaseUrl)
  const primaryStorageUri =
    process.env.POWERSYNC_STORAGE_URI ?? statusEnv.POWERSYNC_STORAGE_URI ?? primaryDatabaseUrl
  const hostStorageUri = primaryStorageUri
  const containerStorageUri =
    process.env.POWERSYNC_CONTAINER_STORAGE_URI ??
    transformLocalUrlForDocker(primaryStorageUri)
  const powersyncPort =
    `${process.env.POWERSYNC_PORT ?? statusEnv.POWERSYNC_PORT ?? POWERSYNC_PORT ?? '55440'}`
  const psDatabaseUrl =
    process.env.PS_DATABASE_URL ?? statusEnv.PS_DATABASE_URL ?? containerDatabaseUrl
  const psStorageUri =
    process.env.PS_STORAGE_URI ?? statusEnv.PS_STORAGE_URI ?? containerStorageUri
  const psPort = `${process.env.PS_PORT ?? statusEnv.PS_PORT ?? POWERSYNC_INTERNAL_PORT}`
  const powersyncEndpoint =
    process.env.POWERSYNC_ENDPOINT ?? statusEnv.POWERSYNC_ENDPOINT ?? `http://127.0.0.1:${powersyncPort}`
  const defaultRemoteEndpoint = functionsUrl ? `${functionsUrl}/powersync-remote` : powersyncEndpoint
  const powersyncRemoteEndpoint = (process.env.POWERSYNC_REMOTE_ENDPOINT ?? defaultRemoteEndpoint).replace(/\/$/, '')
  const powersyncToken =
    process.env.POWERSYNC_TOKEN ?? process.env.POWERSYNC_REMOTE_TOKEN ?? undefined
  const remoteUrl = `powersync::${powersyncRemoteEndpoint.replace(/\/$/, '')}/orgs/${DEFAULT_ORG}/repos/${DEFAULT_REPO}`
  const databaseUrl = resolvedDatabaseUrl

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
    databaseUrl: hostDatabaseUrl,
    powersyncDatabaseUrl: hostDatabaseUrl,
    powersyncStorageUri: hostStorageUri,
    powersyncContainerDatabaseUrl: containerDatabaseUrl,
    powersyncContainerStorageUri: containerStorageUri,
    powersyncPort,
    psDatabaseUrl,
    psStorageUri,
    psPort,
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
    `export POWERSYNC_SUPABASE_DATABASE_URL=${JSON.stringify(env.databaseUrl)}`,
    `export POWERSYNC_DATABASE_URL=${JSON.stringify(env.powersyncDatabaseUrl)}`,
    `export POWERSYNC_STORAGE_URI=${JSON.stringify(env.powersyncStorageUri)}`,
    `export POWERSYNC_PORT=${JSON.stringify(env.powersyncPort)}`,
    `export PS_DATABASE_URL=${JSON.stringify(env.psDatabaseUrl)}`,
    `export PS_STORAGE_URI=${JSON.stringify(env.psStorageUri)}`,
    `export PS_PORT=${JSON.stringify(env.psPort)}`,
    `export SUPABASE_BIN=${JSON.stringify(SUPABASE_BIN)}`,
    `export DOCKER_BIN=${JSON.stringify(DOCKER_BIN)}`,
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

  const seedEnv = normalizeEnvValues({
    POWERSYNC_DATABASE_URL: env.powersyncDatabaseUrl ?? env.databaseUrl ?? process.env.POWERSYNC_DATABASE_URL,
    SUPABASE_DB_URL: env.databaseUrl ?? process.env.SUPABASE_DB_URL,
    SUPABASE_DB_CONNECTION_STRING: env.databaseUrl ?? process.env.SUPABASE_DB_CONNECTION_STRING,
    DATABASE_URL: env.databaseUrl ?? process.env.DATABASE_URL,
    PS_DATABASE_URL:
      env.psDatabaseUrl ?? env.powersyncDatabaseUrl ?? env.databaseUrl ?? process.env.PS_DATABASE_URL,
    PS_STORAGE_URI:
      env.psStorageUri ?? env.powersyncStorageUri ?? env.databaseUrl ?? process.env.PS_STORAGE_URI,
    PS_PORT: env.psPort ?? process.env.PS_PORT,
  })

  await runCommand('node', ['scripts/seed-sync-rules.mjs'], {
    env: seedEnv,
  })
  infoLog('✅ Supabase stream metadata synced from config.yaml')
}

async function applySupabaseSchema(env) {
  const databaseUrl = env.databaseUrl ?? env.powersyncDatabaseUrl
  if (!databaseUrl) {
    warnLog('[dev:stack] Skipping schema apply – database URL unavailable.')
    return
  }

  const schemaPath = resolve(repoRoot, 'supabase', 'schema.sql')
  let sql = ''
  try {
    sql = await readFile(schemaPath, 'utf8')
  } catch (error) {
    warnLog('[dev:stack] Failed to read supabase/schema.sql', error?.message ?? error)
    return
  }

  const client = new Client({ connectionString: databaseUrl })
  try {
    await client.connect()
    await client.query('begin')
    await client.query(sql)
    await client.query('commit')
    infoLog('✅ Supabase schema ensured via supabase/schema.sql')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    warnLog('[dev:stack] Failed to apply supabase/schema.sql', error?.message ?? error)
  } finally {
    await client.end().catch(() => undefined)
  }
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
  await runCommand(SUPABASE_BIN, ['start', '--ignore-health-check'])
  const statusEnv = await supabaseStatusEnv()
  const env = buildStackEnv(statusEnv)

  const hostEnvVars = normalizeEnvValues({
    POWERSYNC_DATABASE_URL: env.powersyncDatabaseUrl,
    POWERSYNC_STORAGE_URI: env.powersyncStorageUri,
    POWERSYNC_PORT: env.powersyncPort,
    PS_DATABASE_URL: env.psDatabaseUrl,
    PS_STORAGE_URI: env.psStorageUri,
    PS_PORT: env.psPort,
    SUPABASE_BIN,
    DOCKER_BIN,
  })
  Object.assign(process.env, hostEnvVars)

  const powersyncEnv = normalizeEnvValues({
    POWERSYNC_DATABASE_URL: env.powersyncContainerDatabaseUrl ?? env.powersyncDatabaseUrl,
    POWERSYNC_STORAGE_URI: env.powersyncContainerStorageUri ?? env.powersyncStorageUri,
    POWERSYNC_PORT: env.powersyncPort,
    PS_DATABASE_URL: env.psDatabaseUrl,
    PS_STORAGE_URI: env.psStorageUri,
    PS_PORT: env.psPort,
  })

  await runCommand(DOCKER_BIN, ['compose', '-f', 'supabase/docker-compose.powersync.yml', 'up', '-d', '--wait'], {
    env: powersyncEnv,
  })
  await runCommand(SUPABASE_BIN, ['functions', 'deploy'], {
    env: powersyncEnv,
  })

  await ensureWorkspaceBinaries()

  await ensurePowerSyncToken(env)
  await applySupabaseSchema(env)

  const exportLines = await writeStackEnvFile(env)

  await waitForPowerSyncReady(env.powersyncEndpoint)

  await seedSyncRules(env)

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
  await runCommand(DOCKER_BIN, ['compose', '-f', 'supabase/docker-compose.powersync.yml', 'down'])
  await runCommand(SUPABASE_BIN, ['stop'])
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
