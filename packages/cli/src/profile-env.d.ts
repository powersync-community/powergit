import type { ResolvedProfile } from './profile-manager.js'

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

export declare function loadProfileEnvironment(options?: LoadProfileEnvironmentOptions): ProfileEnvironmentResult
export declare function resolveProfileDirectory(): string
export declare function resolveProfilesPath(): string
