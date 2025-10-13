#!/usr/bin/env node
import { addPowerSyncRemote, syncPowerSyncRepository, seedDemoRepository } from './index.js'
import { loginViaSupabaseFunction, loginWithExplicitToken, logout as logoutSession } from './auth/login.js'

interface LoginCliOptions {
  endpoint?: string
  token?: string
  functionsUrl?: string
  functionName?: string
  serviceRoleKey?: string
  sessionPath?: string
  mode: 'auto' | 'manual'
}

const [, , cmd, ...rest] = process.argv

async function main() {
  if (cmd === 'remote' && rest[0] === 'add' && rest[1] === 'powersync') {
    const url = rest[2]
    const name = process.env.REMOTE_NAME || 'origin'
    if (!url) {
      console.error('Usage: psgit remote add powersync powersync::https://<endpoint>/orgs/<org>/repos/<repo>')
      process.exit(2)
    }
    await addPowerSyncRemote(process.cwd(), name, url)
    console.log(`Added PowerSync remote (${name}):`, url)
  } else if (cmd === 'sync') {
    const { remoteName, dbPath } = parseSyncArgs(rest)
    const result = await syncPowerSyncRepository(process.cwd(), {
      remoteName,
      dbPath,
    })
    console.log(`Synced PowerSync repo ${result.org}/${result.repo}`)
    console.log(`  Endpoint: ${result.endpoint}`)
    console.log(`  Database: ${result.databasePath}`)
    console.log(
      `  Rows: ${result.counts.refs} refs, ${result.counts.commits} commits, ${result.counts.file_changes} file changes, ${result.counts.objects} objects`,
    )
  } else if (cmd === 'demo-seed') {
    const parsed = parseSeedArgs(rest)
    const result = await seedDemoRepository(parsed)
    console.log('✅ Seeded demo repository via PowerSync remote.')
    console.log(`   Remote: ${result.remoteUrl}`)
    console.log(`   Branch: ${result.branch}`)
    if (parsed.keepWorkingDir) {
      console.log(`   Temp repo kept at: ${result.workingDirectory}`)
    }
    if (!parsed.skipSync && result.syncedDatabase) {
      console.log(`   Local snapshot: ${result.syncedDatabase}`)
    }
  } else if (cmd === 'login') {
    await handleLogin(rest)
  } else if (cmd === 'logout') {
    await handleLogout(rest)
  } else {
    printUsage()
  }
}

function parseLoginArgs(args: string[]): LoginCliOptions {
  const options: LoginCliOptions = { mode: 'auto' }

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    switch (arg) {
      case '--endpoint':
        options.endpoint = args[++i]
        break
      case '--token':
        options.token = args[++i]
        options.mode = 'manual'
        break
      case '--function':
        options.functionName = args[++i]
        break
      case '--functions-url':
        options.functionsUrl = args[++i]
        break
      case '--service-role-key':
        options.serviceRoleKey = args[++i]
        break
      case '--session':
        options.sessionPath = args[++i]
        break
      case '--manual':
        options.mode = 'manual'
        break
      case '--auto':
        options.mode = 'auto'
        break
      case '--help':
      case '-h':
        printLoginUsage()
        process.exit(0)
        break
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`)
          printLoginUsage()
          process.exit(2)
        }
        break
    }
  }

  if (options.mode === 'manual' && !options.token) {
    console.error('Manual login requires --token (and optionally --endpoint).')
    process.exit(2)
  }

  return options
}

async function handleLogin(args: string[]) {
  const options = parseLoginArgs(args)

  if (options.mode === 'manual') {
    const result = await loginWithExplicitToken({
      endpoint: options.endpoint,
      token: options.token,
      sessionPath: options.sessionPath,
    })
    console.log('✅ Stored PowerSync credentials from provided token.')
    console.log(`   Endpoint: ${result.credentials.endpoint}`)
    if (result.credentials.expiresAt) {
      console.log(`   Expires:  ${result.credentials.expiresAt}`)
    }
    return
  }

  const result = await loginViaSupabaseFunction({
    endpoint: options.endpoint,
    functionsUrl: options.functionsUrl,
    credentialFunction: options.functionName,
    serviceRoleKey: options.serviceRoleKey,
    sessionPath: options.sessionPath,
  })

  console.log('✅ Retrieved PowerSync credentials via Supabase function.')
  console.log(`   Endpoint: ${result.credentials.endpoint}`)
  if (result.credentials.expiresAt) {
    console.log(`   Expires:  ${result.credentials.expiresAt}`)
  }
}

async function handleLogout(args: string[]) {
  let sessionPath: string | undefined
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--session') {
      sessionPath = args[++i]
    } else if (arg === '--help' || arg === '-h') {
      printLogoutUsage()
      process.exit(0)
    } else if (arg.startsWith('--')) {
      console.error(`Unknown option: ${arg}`)
      printLogoutUsage()
      process.exit(2)
    }
  }

  await logoutSession({ sessionPath })
  console.log('✅ Cleared stored PowerSync credentials.')
}

function parseSyncArgs(args: string[]) {
  let remoteName = process.env.REMOTE_NAME || 'origin'
  let dbPath: string | undefined
  let positionalConsumed = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--remote' || arg === '-r') {
      const next = args[++i]
      if (!next) {
        console.error('Missing value for --remote')
        process.exit(2)
      }
      remoteName = next
    } else if (arg.startsWith('--remote=')) {
      remoteName = arg.split('=', 2)[1] ?? remoteName
    } else if (arg === '--db' || arg === '--database') {
      const next = args[++i]
      if (!next) {
        console.error('Missing value for --db')
        process.exit(2)
      }
      dbPath = next
    } else if (arg.startsWith('--db=')) {
      dbPath = arg.split('=', 2)[1]
    } else if (!arg.startsWith('-') && !positionalConsumed) {
      remoteName = arg
      positionalConsumed = true
    } else {
      console.error(`Unknown option: ${arg}`)
      printUsage()
      process.exit(2)
    }
  }

  return { remoteName, dbPath }
}

function parseSeedArgs(args: string[]) {
  const options: Parameters<typeof seedDemoRepository>[0] = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '--remote-url':
      case '--url':
        options.remoteUrl = args[++i]
        break
      case '--remote':
      case '-r':
        options.remoteName = args[++i]
        break
      case '--branch':
        options.branch = args[++i]
        break
      case '--db':
      case '--database':
        options.dbPath = args[++i]
        break
      case '--skip-sync':
        options.skipSync = true
        break
      case '--keep-repo':
        options.keepWorkingDir = true
        break
      case '--repo-dir':
        options.workingDir = args[++i]
        options.keepWorkingDir = true
        break
      case '--help':
      case '-h':
        printSeedUsage()
        process.exit(0)
        break
      default:
        if (arg.startsWith('--')) {
          console.error(`Unknown option: ${arg}`)
          printSeedUsage()
          process.exit(2)
        }
        break
    }
  }

  return options
}

function printUsage() {
  console.log('psgit commands:')
  console.log('  psgit remote add powersync powersync::https://<endpoint>/orgs/<org>/repos/<repo>')
  console.log('  psgit sync [--remote <name>] [--db <path>]')
  console.log('  psgit demo-seed [--remote-url <url>] [--remote <name>] [--branch <branch>] [--db <path>] [--skip-sync] [--keep-repo]')
  console.log('  psgit login [--manual] [--token <jwt>] [--endpoint <url>]')
  console.log('  psgit logout')
}

function printLoginUsage() {
  console.log('Usage: psgit login [options]')
  console.log('  --manual                 Use manual mode (requires --token).')
  console.log('  --token <jwt>            PowerSync access token to store locally.')
  console.log('  --endpoint <url>         Override PowerSync endpoint when using --manual.')
  console.log('  --function <name>        Supabase function to call (default powersync-creds).')
  console.log('  --functions-url <url>    Base URL for Supabase functions.')
  console.log('  --service-role-key <key> Supabase service role key for credential exchange.')
  console.log('  --session <path>         Override credential cache path.')
  console.log('  --manual / --auto        Force manual or automatic mode.')
}

function printLogoutUsage() {
  console.log('Usage: psgit logout [--session <path>]')
}

function printSeedUsage() {
  console.log('Usage: psgit demo-seed [options]')
  console.log('  --remote-url <url>     Override remote URL (defaults to POWERSYNC_SEED_REMOTE_URL).')
  console.log('  --remote, -r <name>    Override remote name (defaults to powersync).')
  console.log('  --branch <branch>      Branch to push (default main).')
  console.log('  --db <path>            SQLite path for local snapshot (default tmp/powersync-seed.sqlite).')
  console.log('  --skip-sync            Skip local PowerSync sync after push.')
  console.log('  --keep-repo            Keep the temporary Git repository on disk.')
  console.log('  --repo-dir <path>      Use an explicit working directory and keep it after completion.')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
