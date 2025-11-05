import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import os from 'node:os'
import { cloneProfileDefaults } from './profile-defaults-data.js'

export interface PowerSyncProfileConfig {
  url?: string
  endpoint?: string
  /** @deprecated legacy compatibility */
  daemonUrl?: string
  /** @deprecated legacy compatibility */
  deviceUrl?: string
  /** @deprecated legacy compatibility */
  deviceLoginUrl?: string
  /** @deprecated legacy compatibility */
  token?: string
  /** @deprecated legacy compatibility */
  tokenExpiresAt?: string | null
}

export interface DaemonProfileConfig {
  endpoint?: string
  deviceLoginUrl?: string
  /** @deprecated legacy compatibility */
  deviceUrl?: string
  token?: string
  tokenExpiresAt?: string | null
}

export interface SupabaseProfileConfig {
  url?: string
  anonKey?: string
  serviceRoleKey?: string
  email?: string
  password?: string
  schema?: string
}

export interface ProfileConfig {
  powersync?: PowerSyncProfileConfig
  daemon?: DaemonProfileConfig
  supabase?: SupabaseProfileConfig
  env?: Record<string, string | undefined>
  stackEnvPath?: string
}

export interface ProfilesFile {
  [name: string]: ProfileConfig
}

export interface ResolvedProfile {
  name: string
  config: ProfileConfig
  stackEnvPath?: string
  env: Record<string, string>
  source: 'default' | 'file'
}

function resolvePsgitHome(): string {
  const override = process.env.PSGIT_HOME
  if (override && override.trim().length > 0) {
    return resolve(override)
  }
  return resolve(os.homedir(), '.psgit')
}

export const PSGIT_DIR = resolvePsgitHome()
export const PROFILES_PATH = resolve(PSGIT_DIR, 'profiles.json')
export const STATE_PATH = resolve(PSGIT_DIR, 'profile.json')

function ensureDir(path: string) {
  mkdirSync(path, { recursive: true })
}

function readJsonFile<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function writeJsonFile(path: string, data: unknown) {
  ensureDir(dirname(path))
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

function createDefaultProfiles(): ProfilesFile {
  return cloneProfileDefaults() as ProfilesFile
}

function loadProfiles(): { profiles: ProfilesFile; source: 'default' | 'file' } {
  const fileData = readJsonFile<ProfilesFile>(PROFILES_PATH)
  if (!fileData || typeof fileData !== 'object' || Array.isArray(fileData)) {
    const defaults = createDefaultProfiles()
    writeJsonFile(PROFILES_PATH, defaults)
    return { profiles: defaults, source: 'default' }
  }
  return { profiles: fileData, source: 'file' }
}

function loadProfileState(): { current: string; exists: boolean } {
  const state = readJsonFile<{ current?: string }>(STATE_PATH)
  if (state && typeof state.current === 'string' && state.current.trim().length > 0) {
    return { current: state.current.trim(), exists: true }
  }
  return { current: 'local-dev', exists: false }
}

function saveProfileState(name: string) {
  writeJsonFile(STATE_PATH, { current: name })
}

export function buildEnvFromProfile(profile: ProfileConfig): { env: Record<string, string>; stackEnvPath?: string } {
  const result: Record<string, string> = {}

  const powersyncEndpoint =
    profile.powersync?.url ?? profile.powersync?.endpoint ?? undefined
  if (powersyncEndpoint) {
    const endpoint = powersyncEndpoint
    result.POWERSYNC_ENDPOINT = endpoint
    result.POWERSYNC_DAEMON_ENDPOINT = endpoint
    result.PSGIT_TEST_ENDPOINT = endpoint
  }

  const daemonEndpoint =
    profile.daemon?.endpoint ?? profile.powersync?.daemonUrl ?? undefined
  if (daemonEndpoint) {
    result.POWERSYNC_DAEMON_URL = daemonEndpoint
  }

  const daemonDeviceLoginUrl =
    profile.daemon?.deviceLoginUrl ??
    profile.daemon?.deviceUrl ??
    profile.powersync?.deviceLoginUrl ??
    profile.powersync?.deviceUrl ??
    undefined
  if (daemonDeviceLoginUrl) {
    result.POWERSYNC_DAEMON_DEVICE_URL = daemonDeviceLoginUrl
    result.POWERSYNC_EXPLORER_URL = daemonDeviceLoginUrl
  }

  const daemonToken = profile.daemon?.token ?? profile.powersync?.token
  const daemonTokenExpires =
    profile.daemon?.tokenExpiresAt ?? profile.powersync?.tokenExpiresAt ?? null
  if (daemonToken) {
    const token = daemonToken
    const expiresAt = daemonTokenExpires
    const isExpired =
      typeof expiresAt === 'string' && expiresAt.trim().length > 0
        ? Date.parse(expiresAt) <= Date.now() + 5_000
        : false
    if (!isExpired) {
      result.POWERSYNC_DAEMON_TOKEN = token
      result.POWERSYNC_SERVICE_TOKEN = token
      result.POWERSYNC_DAEMON_GUEST_TOKEN = token
    }
  }

  if (profile.supabase?.url) {
    const url = profile.supabase.url
    result.POWERSYNC_SUPABASE_URL = url
    result.PSGIT_TEST_SUPABASE_URL = url
  }

  if (profile.supabase?.anonKey) {
    const anonKey = profile.supabase.anonKey
    result.POWERSYNC_SUPABASE_ANON_KEY = anonKey
    result.PSGIT_TEST_SUPABASE_ANON_KEY = anonKey
  }

  if (profile.supabase?.serviceRoleKey) {
    const serviceRoleKey = profile.supabase.serviceRoleKey
    result.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey
    result.PSGIT_TEST_SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey
  }

  if (profile.supabase?.email) {
    const email = profile.supabase.email
    result.POWERSYNC_SUPABASE_EMAIL = email
    result.PSGIT_TEST_SUPABASE_EMAIL = email
  }

  if (profile.supabase?.password) {
    const password = profile.supabase.password
    result.POWERSYNC_SUPABASE_PASSWORD = password
    result.PSGIT_TEST_SUPABASE_PASSWORD = password
  }

  if (profile.supabase?.schema) {
    result.POWERSYNC_SUPABASE_SCHEMA = profile.supabase.schema
  }

  if (profile.env) {
    for (const [key, value] of Object.entries(profile.env)) {
      if (value === undefined || value === null) continue
      result[key] = String(value)
    }
  }

  return { env: result, stackEnvPath: profile.stackEnvPath }
}

export interface ResolveProfileOptions {
  name?: string | null
  updateState?: boolean
  strict?: boolean
}

export function resolveProfile(options: ResolveProfileOptions = {}): ResolvedProfile {
  const { name = null, updateState = true, strict = false } = options
  const requestedName = typeof name === 'string' && name.trim().length > 0 ? name.trim() : null
  const { profiles, source } = loadProfiles()
  const defaults = createDefaultProfiles()
  const mergedProfiles: ProfilesFile = { ...defaults, ...profiles }
  const state = loadProfileState()
  const candidates: Array<string> = []

  if (requestedName) {
    candidates.push(requestedName)
  }
  if (state.current && mergedProfiles[state.current]) {
    candidates.push(state.current)
  }
  if (!candidates.includes('local-dev')) {
    candidates.push('local-dev')
  }

  const profileName = candidates.find((candidate) => Boolean(candidate && mergedProfiles[candidate])) ?? 'local-dev'

  if (strict && requestedName && profileName !== requestedName) {
    throw new Error(`Unknown profile "${requestedName}". Use "psgit profile list" to inspect available profiles.`)
  }

  if (updateState) {
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

export function resolveActiveProfile(): ResolvedProfile {
  return resolveProfile({ updateState: true })
}

export function listProfiles(): Array<{ name: string; config: ProfileConfig }> {
  const { profiles } = loadProfiles()
  return Object.entries(profiles).map(([name, config]) => ({ name, config }))
}

export function getProfile(name: string): ProfileConfig | undefined {
  const { profiles } = loadProfiles()
  return profiles[name]
}

export function setActiveProfile(name: string): void {
  const { profiles } = loadProfiles()
  if (!profiles[name]) {
    throw new Error(`Unknown profile "${name}". Use "psgit profile list" to inspect available profiles.`)
  }
  saveProfileState(name)
}

export function ensureProfileExists(name: string, config: ProfileConfig): void {
  const { profiles } = loadProfiles()
  if (!profiles[name]) {
    const updated = { ...profiles, [name]: config }
    writeJsonFile(PROFILES_PATH, updated)
  }
}

export function saveProfile(name: string, config: ProfileConfig): void {
  const { profiles } = loadProfiles()
  const updated = { ...profiles, [name]: config }
  writeJsonFile(PROFILES_PATH, updated)
}
