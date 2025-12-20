import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { cloneProfileDefaults } from './profile-defaults.js'

type ProfileConfig = {
  powersync?: {
    url?: string
    endpoint?: string
  }
}

type ProfilesFile = Record<string, ProfileConfig>

type ProfileState = {
  current?: string
}

const DEFAULT_PROFILE_NAME = 'prod'

export type ResolvedPowergitRemote = {
  url: string
  profileName?: string | null
}

function resolvePowergitHome(): string {
  const override = process.env.POWERGIT_HOME
  if (override && override.trim().length > 0) {
    return resolve(override.trim())
  }
  return resolve(homedir(), '.powergit')
}

function readJsonFile<T>(path: string): T | null {
  try {
    const raw = readFileSync(path, 'utf8')
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

function loadProfiles(): ProfilesFile {
  const defaults = cloneProfileDefaults() as ProfilesFile
  const profilesPath = resolve(resolvePowergitHome(), 'profiles.json')
  const fileProfiles = readJsonFile<ProfilesFile>(profilesPath)
  if (!fileProfiles || typeof fileProfiles !== 'object' || Array.isArray(fileProfiles)) {
    return defaults
  }
  return { ...defaults, ...fileProfiles }
}

function resolveProfileName(preferred?: string | null): string {
  if (preferred && preferred.trim().length > 0) {
    return preferred.trim()
  }

  const envOverride =
    process.env.POWERGIT_PROFILE ??
    process.env.STACK_PROFILE ??
    process.env.POWERGIT_ACTIVE_PROFILE
  if (envOverride && envOverride.trim().length > 0) {
    return envOverride.trim()
  }

  const statePath = resolve(resolvePowergitHome(), 'profile.json')
  const state = readJsonFile<ProfileState>(statePath)
  if (state?.current && state.current.trim().length > 0) {
    return state.current.trim()
  }

  return DEFAULT_PROFILE_NAME
}

function resolveProfileEndpoint(profileName: string): string {
  const profiles = loadProfiles()
  const profile = profiles[profileName]
  if (!profile) {
    throw new Error(`Unknown powergit profile "${profileName}".`)
  }
  const endpoint = profile.powersync?.url ?? profile.powersync?.endpoint
  if (!endpoint || endpoint.trim().length === 0) {
    throw new Error(`Profile "${profileName}" does not define a PowerSync endpoint.`)
  }
  return endpoint.trim().replace(/\/+$/, '')
}

function parseAliasPath(raw: string): { alias?: string; org: string; repo: string } {
  const trimmed = raw.replace(/^\/+/, '')
  const segments = trimmed.split('/').filter(Boolean)
  if (segments.length === 2) {
    return { org: segments[0], repo: segments[1] }
  }
  if (segments.length === 3) {
    return { alias: segments[0], org: segments[1], repo: segments[2] }
  }
  if (segments.length === 4 && segments[0] === 'orgs' && segments[2] === 'repos') {
    return { org: segments[1], repo: segments[3] }
  }
  if (segments.length === 5 && segments[1] === 'orgs' && segments[3] === 'repos') {
    return { alias: segments[0], org: segments[2], repo: segments[4] }
  }
  throw new Error('Invalid powergit URL')
}

export function resolvePowergitRemote(input: string, options: { profile?: string | null } = {}): ResolvedPowergitRemote {
  const idx = input.indexOf('::')
  if (idx === -1) {
    return { url: input }
  }
  const raw = input.slice(idx + 2)
  if (raw.includes('://')) {
    return { url: input }
  }

  const parsed = parseAliasPath(raw)
  if (!parsed.org || !parsed.repo) {
    throw new Error('Invalid powergit URL')
  }

  if (!parsed.alias && !options.profile) {
    const envEndpoint =
      process.env.POWERSYNC_URL ??
      process.env.POWERSYNC_DAEMON_ENDPOINT ??
      process.env.POWERSYNC_ENDPOINT ??
      process.env.POWERGIT_TEST_ENDPOINT ??
      null
    if (envEndpoint && envEndpoint.trim().length > 0) {
      const normalized = envEndpoint.trim().replace(/\/+$/, '')
      return {
        url: `powergit::${normalized}/orgs/${encodeURIComponent(parsed.org)}/repos/${encodeURIComponent(parsed.repo)}`,
        profileName: null,
      }
    }
  }

  const profileName = resolveProfileName(parsed.alias ?? options.profile ?? null)
  const endpoint = resolveProfileEndpoint(profileName)
  return {
    url: `powergit::${endpoint}/orgs/${encodeURIComponent(parsed.org)}/repos/${encodeURIComponent(parsed.repo)}`,
    profileName,
  }
}

export function resolvePowergitRemoteUrl(input: string, options: { profile?: string | null } = {}): string {
  return resolvePowergitRemote(input, options).url
}
