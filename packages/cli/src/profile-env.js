import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import os from 'node:os'
import { cloneProfileDefaults } from './profile-defaults-data.js'

function resolvePsgitHome() {
  const override = process.env.PSGIT_HOME
  if (override && override.trim().length > 0) {
    return resolve(override)
  }
  return resolve(os.homedir(), '.psgit')
}

const PSGIT_DIR = resolvePsgitHome()
const PROFILES_PATH = resolve(PSGIT_DIR, 'profiles.json')
const STATE_PATH = resolve(PSGIT_DIR, 'profile.json')

function ensureDir(path) {
  mkdirSync(path, { recursive: true })
}

function readJsonFile(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // ignore
  }
  return null
}

function writeJsonFile(path, data) {
  ensureDir(dirname(path))
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function createDefaultProfiles() {
  return cloneProfileDefaults()
}

function loadProfiles() {
  const fileData = readJsonFile(PROFILES_PATH)
  if (!fileData) {
    const defaults = createDefaultProfiles()
    writeJsonFile(PROFILES_PATH, defaults)
    return { profiles: defaults, source: 'default' }
  }
  return { profiles: fileData, source: 'file' }
}

function loadProfileState() {
  const state = readJsonFile(STATE_PATH)
  if (state && typeof state.current === 'string' && state.current.trim().length > 0) {
    return { current: state.current.trim(), exists: true }
  }
  return { current: 'local-dev', exists: false }
}

function saveProfileState(name) {
  writeJsonFile(STATE_PATH, { current: name })
}

function buildEnvFromProfile(profile) {
  const result = {}

  const powersyncEndpoint =
    profile?.powersync?.url ?? profile?.powersync?.endpoint
  if (powersyncEndpoint) {
    const endpoint = powersyncEndpoint
    result.POWERSYNC_ENDPOINT = endpoint
    result.POWERSYNC_DAEMON_ENDPOINT = endpoint
    result.PSGIT_TEST_ENDPOINT = endpoint
  }

  const daemonEndpoint =
    profile?.daemon?.endpoint ?? profile?.powersync?.daemonUrl
  if (daemonEndpoint) {
    result.POWERSYNC_DAEMON_URL = daemonEndpoint
  }

  const daemonDeviceLoginUrl =
    profile?.daemon?.deviceLoginUrl ??
    profile?.daemon?.deviceUrl ??
    profile?.powersync?.deviceLoginUrl ??
    profile?.powersync?.deviceUrl
  if (daemonDeviceLoginUrl) {
    result.POWERSYNC_DAEMON_DEVICE_URL = daemonDeviceLoginUrl
    result.POWERSYNC_EXPLORER_URL = daemonDeviceLoginUrl
  }

  if (profile?.supabase?.url) {
    const url = profile.supabase.url
    result.POWERSYNC_SUPABASE_URL = url
    result.PSGIT_TEST_SUPABASE_URL = url
  }

  if (profile?.supabase?.anonKey) {
    const anonKey = profile.supabase.anonKey
    result.POWERSYNC_SUPABASE_ANON_KEY = anonKey
    result.PSGIT_TEST_SUPABASE_ANON_KEY = anonKey
  }

  if (profile?.supabase?.serviceRoleKey) {
    const serviceRoleKey = profile.supabase.serviceRoleKey
    result.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey
    result.PSGIT_TEST_SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey
  }

  if (profile?.supabase?.email) {
    const email = profile.supabase.email
    result.POWERSYNC_SUPABASE_EMAIL = email
    result.PSGIT_TEST_SUPABASE_EMAIL = email
  }

  if (profile?.supabase?.password) {
    const password = profile.supabase.password
    result.POWERSYNC_SUPABASE_PASSWORD = password
    result.PSGIT_TEST_SUPABASE_PASSWORD = password
  }

  if (profile?.supabase?.schema) {
    result.POWERSYNC_SUPABASE_SCHEMA = profile.supabase.schema
  }

  if (profile?.env && typeof profile.env === 'object') {
    for (const [key, value] of Object.entries(profile.env)) {
      if (value === undefined || value === null) continue
      result[key] = String(value)
    }
  }

  return { env: result, stackEnvPath: profile?.stackEnvPath }
}

function resolveProfile(options = {}) {
  const { profiles, source } = loadProfiles()
  const defaults = createDefaultProfiles()
  const mergedProfiles = { ...defaults, ...profiles }
  const state = loadProfileState()
  const requestedName = typeof options.name === 'string' && options.name.trim().length > 0 ? options.name.trim() : null

  const candidates = []
  if (requestedName) candidates.push(requestedName)
  if (state.current && mergedProfiles[state.current]) candidates.push(state.current)
  if (!candidates.includes('local-dev')) candidates.push('local-dev')

  const profileName = candidates.find((candidate) => Boolean(candidate && mergedProfiles[candidate])) ?? 'local-dev'

  if (options.strict && requestedName && profileName !== requestedName) {
    throw new Error(`Unknown profile "${requestedName}". Use "psgit profile list" to inspect available profiles.`)
  }

  if (options.updateState) {
    if (!state.exists || state.current !== profileName) {
      saveProfileState(profileName)
    }
  }

  const config = mergedProfiles[profileName] ?? defaults['local-dev']
  const { env, stackEnvPath } = buildEnvFromProfile(config)
  return {
    name: profileName,
    config,
    env,
    stackEnvPath,
    source: profileName in profiles ? source : 'default',
  }
}

function normalizeProfileName(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function stripWrappingQuotes(value) {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed) return trimmed
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseStackEnvContent(content) {
  const result = {}
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed)
    if (!match) continue
    const [, key, rawValue] = match
    result[key] = stripWrappingQuotes(rawValue)
  }
  return result
}

function locateStackEnvPath(path, { startDir = process.cwd() } = {}) {
  if (isAbsolute(path)) {
    return existsSync(path) ? path : null
  }

  let current = startDir
  const visited = new Set()
  while (!visited.has(current)) {
    visited.add(current)
    const candidate = resolve(current, path)
    if (existsSync(candidate)) {
      return candidate
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return null
}

function loadStackEnv(path, options) {
  const resolvedPath = locateStackEnvPath(path, options)
  if (!resolvedPath) {
    return null
  }
  const content = readFileSync(resolvedPath, 'utf8')
  const values = parseStackEnvContent(content)
  return { path: resolvedPath, values }
}

function dedupePaths(entries) {
  const seen = new Set()
  const result = []
  for (const entry of entries) {
    if (!entry.path) continue
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    result.push(entry)
  }
  return result
}

export function loadProfileEnvironment(options = {}) {
  const profileOverride = normalizeProfileName(options.profile ?? process.env.STACK_PROFILE)
  const profile = resolveProfile({
    name: profileOverride,
    updateState: options.updateState ?? false,
    strict: options.strict ?? Boolean(profileOverride),
  })

  const profileEnv = { ...profile.env }
  let stackEnvPath = null
  let stackEnvValues = {}

  if (options.includeStackEnv !== false) {
    const startDir = options.startDir ?? process.cwd()
    const entries = []

    const explicitPaths = options.stackEnvPaths ?? null
    if (explicitPaths && explicitPaths.length > 0) {
      const allowMissingExplicit = options.stackEnvPathsAllowMissing ?? false
      for (const path of explicitPaths) {
        entries.push({ path, allowMissing: allowMissingExplicit })
      }
    } else {
      const envOverride = normalizeProfileName(process.env.PSGIT_STACK_ENV)
      if (envOverride) {
        entries.push({ path: envOverride, allowMissing: false })
      }
      if (profile.stackEnvPath) {
        entries.push({ path: profile.stackEnvPath, allowMissing: true })
      }
    }

    const candidates = dedupePaths(entries)
    for (const candidate of candidates) {
      const loaded = loadStackEnv(candidate.path, { startDir })
      if (loaded) {
        stackEnvPath = stackEnvPath ?? loaded.path
        stackEnvValues = { ...stackEnvValues, ...loaded.values }
        continue
      }
      if (!candidate.allowMissing) {
        throw new Error(`Stack env file not found: ${candidate.path}`)
      }
    }
  }

  const combinedEnv = { ...profileEnv }
  for (const [key, value] of Object.entries(stackEnvValues)) {
    combinedEnv[key] = value
  }
  // Provide sensible fallbacks between historical/local env names
  const fallbackPairs = [
    ['POWERSYNC_SUPABASE_URL', 'PSGIT_TEST_SUPABASE_URL'],
    ['POWERSYNC_SUPABASE_ANON_KEY', 'PSGIT_TEST_SUPABASE_ANON_KEY'],
    ['POWERSYNC_SUPABASE_SERVICE_ROLE_KEY', 'PSGIT_TEST_SUPABASE_SERVICE_ROLE_KEY'],
    ['POWERSYNC_SUPABASE_EMAIL', 'PSGIT_TEST_SUPABASE_EMAIL'],
    ['POWERSYNC_SUPABASE_PASSWORD', 'PSGIT_TEST_SUPABASE_PASSWORD'],
    ['POWERSYNC_ENDPOINT', 'PSGIT_TEST_ENDPOINT'],
  ]
  for (const [target, fallback] of fallbackPairs) {
    if (!combinedEnv[target] && combinedEnv[fallback]) {
      combinedEnv[target] = combinedEnv[fallback]
    }
  }
  combinedEnv.STACK_PROFILE = profile.name
  combinedEnv.PSGIT_ACTIVE_PROFILE = profile.name

  return {
    profile,
    profilesPath: PROFILES_PATH,
    psgitDir: PSGIT_DIR,
    profileEnv,
    stackEnvPath,
    stackEnvValues,
    combinedEnv,
  }
}

export function resolveProfileDirectory() {
  return PSGIT_DIR
}

export function resolveProfilesPath() {
  return PROFILES_PATH
}
