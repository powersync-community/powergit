import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import os from 'node:os'

export interface PowerSyncProfileConfig {
  endpoint?: string
  daemonUrl?: string
  deviceUrl?: string
  token?: string
}

export interface SupabaseProfileConfig {
  url?: string
  anonKey?: string
  serviceRoleKey?: string
  email?: string
  password?: string
}

export interface ProfileConfig {
  stackEnvPath?: string
  powersync?: PowerSyncProfileConfig
  supabase?: SupabaseProfileConfig
  env?: Record<string, string | undefined>
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

export const PSGIT_DIR = resolve(os.homedir(), '.psgit')
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
  return {
    'local-dev': {
      stackEnvPath: '.env.powersync-stack',
      powersync: {
        endpoint: 'http://127.0.0.1:55440',
        daemonUrl: 'http://127.0.0.1:5030',
        deviceUrl: 'http://localhost:5783/auth',
      },
      supabase: {
        url: 'http://127.0.0.1:55431',
      },
    },
  }
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

  if (profile.powersync?.endpoint) {
    const endpoint = profile.powersync.endpoint
    result.POWERSYNC_ENDPOINT = endpoint
    result.POWERSYNC_DAEMON_ENDPOINT = endpoint
    result.PSGIT_TEST_ENDPOINT = endpoint
  }

  if (profile.powersync?.daemonUrl) {
    result.POWERSYNC_DAEMON_URL = profile.powersync.daemonUrl
  }

  if (profile.powersync?.deviceUrl) {
    result.POWERSYNC_DAEMON_DEVICE_URL = profile.powersync.deviceUrl
    result.POWERSYNC_EXPLORER_URL = profile.powersync.deviceUrl
  }

  if (profile.powersync?.token) {
    const token = profile.powersync.token
    result.POWERSYNC_DAEMON_TOKEN = token
    result.POWERSYNC_SERVICE_TOKEN = token
    result.POWERSYNC_DAEMON_GUEST_TOKEN = token
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
  const state = loadProfileState()
  const candidates: Array<string> = []

  if (requestedName) {
    candidates.push(requestedName)
  }
  if (state.current && profiles[state.current]) {
    candidates.push(state.current)
  }
  if (!candidates.includes('local-dev')) {
    candidates.push('local-dev')
  }

  const profileName = candidates.find((candidate) => Boolean(candidate && profiles[candidate])) ?? 'local-dev'

  if (strict && requestedName && profileName !== requestedName) {
    throw new Error(`Unknown profile "${requestedName}". Use "psgit profile list" to inspect available profiles.`)
  }

  if (updateState) {
    if (!state.exists || state.current !== profileName) {
      saveProfileState(profileName)
    }
  }

  const config = profiles[profileName] ?? createDefaultProfiles()['local-dev']
  const { env, stackEnvPath } = buildEnvFromProfile(config)
  return {
    name: profileName,
    config,
    env,
    stackEnvPath,
    source,
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
