import { loadStackEnv } from './stack-env.js'
import { POWERGIT_DIR, PROFILES_PATH, resolveProfile, type ResolvedProfile } from './profile-manager.js'

export interface LoadProfileEnvironmentOptions {
  profile?: string | null
  includeStackEnv?: boolean
  stackEnvPaths?: string[]
  stackEnvPathsAllowMissing?: boolean
  startDir?: string
  updateState?: boolean
  strict?: boolean
}

export interface ProfileEnvironmentResult {
  profile: ResolvedProfile
  profilesPath: string
  powergitDir: string
  profileEnv: Record<string, string>
  stackEnvPath: string | null
  stackEnvValues: Record<string, string>
  combinedEnv: Record<string, string>
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function dedupePaths(entries: Array<{ path: string; allowMissing: boolean }>): Array<{ path: string; allowMissing: boolean }> {
  const seen = new Set<string>()
  const result: Array<{ path: string; allowMissing: boolean }> = []
  for (const entry of entries) {
    if (!entry.path) continue
    if (seen.has(entry.path)) continue
    seen.add(entry.path)
    result.push(entry)
  }
  return result
}

export function loadProfileEnvironment(options: LoadProfileEnvironmentOptions = {}): ProfileEnvironmentResult {
  const profileOverride = normalizeString(options.profile ?? process.env.STACK_PROFILE)
  const profile = resolveProfile({
    name: profileOverride,
    updateState: options.updateState ?? false,
    strict: options.strict ?? Boolean(profileOverride),
  })

  const profileEnv = { ...profile.env }
  let stackEnvPath: string | null = null
  let stackEnvValues: Record<string, string> = {}

  if (options.includeStackEnv !== false) {
    const startDir = options.startDir ?? process.cwd()
    const entries: Array<{ path: string; allowMissing: boolean }> = []

    const explicitPaths = options.stackEnvPaths ?? null
    if (explicitPaths && explicitPaths.length > 0) {
      const allowMissingExplicit = options.stackEnvPathsAllowMissing ?? false
      for (const path of explicitPaths) {
        const normalized = normalizeString(path)
        if (normalized) {
          entries.push({ path: normalized, allowMissing: allowMissingExplicit })
        }
      }
    } else {
      const envOverride = normalizeString(process.env.POWERGIT_STACK_ENV)
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

  const combinedEnv: Record<string, string> = { ...profileEnv, ...stackEnvValues }

  // Provide sensible fallbacks between historical/local env names
  const fallbackPairs: Array<[string, string]> = [
    ['SUPABASE_URL', 'POWERGIT_TEST_SUPABASE_URL'],
    ['SUPABASE_ANON_KEY', 'POWERGIT_TEST_SUPABASE_ANON_KEY'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'POWERGIT_TEST_SUPABASE_SERVICE_ROLE_KEY'],
    ['SUPABASE_EMAIL', 'POWERGIT_TEST_SUPABASE_EMAIL'],
    ['SUPABASE_PASSWORD', 'POWERGIT_TEST_SUPABASE_PASSWORD'],
    ['POWERSYNC_URL', 'POWERGIT_TEST_ENDPOINT'],
  ]
  for (const [target, fallback] of fallbackPairs) {
    if (!combinedEnv[target] && combinedEnv[fallback]) {
      combinedEnv[target] = combinedEnv[fallback]
    }
  }

  combinedEnv.STACK_PROFILE = profile.name
  combinedEnv.POWERGIT_ACTIVE_PROFILE = profile.name

  return {
    profile,
    profilesPath: PROFILES_PATH,
    powergitDir: POWERGIT_DIR,
    profileEnv,
    stackEnvPath,
    stackEnvValues,
    combinedEnv,
  }
}

export function resolveProfileDirectory(): string {
  return POWERGIT_DIR
}

export function resolveProfilesPath(): string {
  return PROFILES_PATH
}

