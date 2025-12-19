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

function resolvePowergitHome(): string {
  const override = process.env.POWERGIT_HOME
  if (override && override.trim().length > 0) {
    return resolve(override)
  }
  return resolve(os.homedir(), '.powergit')
}

export const POWERGIT_DIR = resolvePowergitHome()
export const PROFILES_PATH = resolve(POWERGIT_DIR, 'profiles.json')
export const STATE_PATH = resolve(POWERGIT_DIR, 'profile.json')

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
  return { current: 'prod', exists: false }
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
    result.POWERSYNC_URL = endpoint
    result.POWERSYNC_DAEMON_ENDPOINT = endpoint
    result.POWERGIT_TEST_ENDPOINT = endpoint
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

  if (profile.supabase?.url) {
    const url = profile.supabase.url
    result.SUPABASE_URL = url
    result.POWERGIT_TEST_SUPABASE_URL = url
  }

  if (profile.supabase?.anonKey) {
    const anonKey = profile.supabase.anonKey
    result.SUPABASE_ANON_KEY = anonKey
    result.POWERGIT_TEST_SUPABASE_ANON_KEY = anonKey
  }

  if (profile.supabase?.serviceRoleKey) {
    const serviceRoleKey = profile.supabase.serviceRoleKey
    result.SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey
    result.POWERGIT_TEST_SUPABASE_SERVICE_ROLE_KEY = serviceRoleKey
  }

  if (profile.supabase?.email) {
    const email = profile.supabase.email
    result.SUPABASE_EMAIL = email
    result.POWERGIT_TEST_SUPABASE_EMAIL = email
  }

  if (profile.supabase?.password) {
    const password = profile.supabase.password
    result.SUPABASE_PASSWORD = password
    result.POWERGIT_TEST_SUPABASE_PASSWORD = password
  }

  if (profile.supabase?.schema) {
    result.SUPABASE_SCHEMA = profile.supabase.schema
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
  if (!candidates.includes('prod')) {
    candidates.push('prod')
  }

  const profileName = candidates.find((candidate) => Boolean(candidate && mergedProfiles[candidate])) ?? 'prod'

  if (strict && requestedName && profileName !== requestedName) {
    throw new Error(`Unknown profile "${requestedName}". Use "powergit profile list" to inspect available profiles.`)
  }

  if (updateState) {
    if (!state.exists || state.current !== profileName) {
      saveProfileState(profileName)
    }
  }

  const config = mergedProfiles[profileName] ?? defaults['prod']
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
    throw new Error(`Unknown profile "${name}". Use "powergit profile list" to inspect available profiles.`)
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
