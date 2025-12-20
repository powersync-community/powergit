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

const DEFAULT_PROFILE_NAME = 'prod'

export type ResolvedPowergitRemote = {
  org: string
  repo: string
  /**
   * Profile name selected from the remote URL.
   * - `powergit::/org/repo` => `prod`
   * - `powergit::<profile>/org/repo` => `<profile>`
   */
  profileName: string
  /**
   * The resolved PowerSync base URL (no trailing slash).
   * This is the stack-level endpoint, not a repo-scoped URL.
   */
  powersyncUrl: string
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
  return DEFAULT_PROFILE_NAME
}

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '')
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
  return normalizeBaseUrl(endpoint)
}

function parseProfilePath(raw: string): { profileName?: string; org: string; repo: string } {
  const trimmed = raw.replace(/^\/+/, '')
  const segments = trimmed.split('/').filter(Boolean)
  if (segments.length === 2) {
    return { org: segments[0], repo: segments[1] }
  }
  if (segments.length === 3) {
    return { profileName: segments[0], org: segments[1], repo: segments[2] }
  }
  if (segments.length === 4 && segments[0] === 'orgs' && segments[2] === 'repos') {
    return { org: segments[1], repo: segments[3] }
  }
  if (segments.length === 5 && segments[1] === 'orgs' && segments[3] === 'repos') {
    return { profileName: segments[0], org: segments[2], repo: segments[4] }
  }
  throw new Error('Invalid powergit URL')
}

export function resolvePowergitRemote(
  input: string,
  options: { profile?: string | null } = {},
): ResolvedPowergitRemote {
  const idx = input.indexOf('::')
  const raw = idx === -1 ? input : input.slice(idx + 2)
  if (raw.includes('://')) {
    throw new Error(
      'Explicit endpoint remotes are not supported. Use powergit::/org/repo (prod) or powergit::<profile>/org/repo.',
    )
  }
  const looksLikeProfilePath = raw.includes('/') && !raw.startsWith('refs/')
  if (idx === -1 && !looksLikeProfilePath) {
    throw new Error('Invalid powergit URL')
  }

  const parsed = parseProfilePath(raw)
  if (!parsed.org || !parsed.repo) {
    throw new Error('Invalid powergit URL')
  }

  const profileName = resolveProfileName(parsed.profileName ?? options.profile ?? null)
  const endpoint = resolveProfileEndpoint(profileName)
  return {
    org: parsed.org,
    repo: parsed.repo,
    profileName,
    powersyncUrl: endpoint,
  }
}

export function resolvePowergitRemoteUrl(input: string, options: { profile?: string | null } = {}): string {
  const resolved = resolvePowergitRemote(input, options)
  if (resolved.profileName === DEFAULT_PROFILE_NAME) {
    return `powergit::/${resolved.org}/${resolved.repo}`
  }
  return `powergit::${resolved.profileName}/${resolved.org}/${resolved.repo}`
}
