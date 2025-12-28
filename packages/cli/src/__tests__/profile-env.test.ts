import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('loadProfileEnvironment', () => {
  const originalStackProfile = process.env.STACK_PROFILE
  const originalPowergitStackEnv = process.env.POWERGIT_STACK_ENV
  const originalPowergitHome = process.env.POWERGIT_HOME

  let tempHome: string
  let stackEnvFile: string
  let profilesPath: string
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'powergit-profile-env-'))
    const homeDir = join(tempHome, '.powergit')
    mkdirSync(homeDir, { recursive: true })
    profilesPath = join(homeDir, 'profiles.json')
    stackEnvFile = join(tempHome, 'stack.env')
    process.env.HOME = tempHome
    process.env.POWERGIT_HOME = homeDir
    delete process.env.STACK_PROFILE
    delete process.env.POWERGIT_STACK_ENV
  })

  afterEach(() => {
    vi.resetModules()
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    if (originalStackProfile !== undefined) {
      process.env.STACK_PROFILE = originalStackProfile
    } else {
      delete process.env.STACK_PROFILE
    }
    if (originalPowergitStackEnv !== undefined) {
      process.env.POWERGIT_STACK_ENV = originalPowergitStackEnv
    } else {
      delete process.env.POWERGIT_STACK_ENV
    }
    if (originalPowergitHome !== undefined) {
      process.env.POWERGIT_HOME = originalPowergitHome
    } else {
      delete process.env.POWERGIT_HOME
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('merges profile env vars with stack env exports', async () => {
    const profiles = {
      staging: {
        powersync: {
          url: 'https://powersync.example.com',
        },
        daemon: {
          endpoint: 'https://daemon.example.com',
        },
        supabase: {
          url: 'https://supabase.example.com',
        },
        stackEnvPath: stackEnvFile,
      },
    }
    writeFileSync(profilesPath, JSON.stringify(profiles, null, 2))
    writeFileSync(
      stackEnvFile,
      [
        'export SUPABASE_ANON_KEY=anon-key-staging',
        'export VITE_CUSTOM_FLAG=enabled',
      ].join('\n'),
      'utf8',
    )

    vi.resetModules()
    const { loadProfileEnvironment } = await import('@powersync-community/powergit-core/profile-env')

    const result = loadProfileEnvironment({
      profile: 'staging',
      stackEnvPaths: [stackEnvFile],
      startDir: tempHome,
    })

    expect(result.profile.name).toBe('staging')
    expect(result.stackEnvPath).toBe(stackEnvFile)
    expect(result.profileEnv).toMatchObject({
      POWERSYNC_URL: 'https://powersync.example.com',
      POWERGIT_DAEMON_URL: 'https://daemon.example.com',
      POWERSYNC_DAEMON_URL: 'https://daemon.example.com',
      SUPABASE_URL: 'https://supabase.example.com',
    })
    expect(result.stackEnvValues).toMatchObject({
      SUPABASE_ANON_KEY: 'anon-key-staging',
      VITE_CUSTOM_FLAG: 'enabled',
    })
    expect(result.combinedEnv).toMatchObject({
      POWERSYNC_URL: 'https://powersync.example.com',
      POWERGIT_DAEMON_URL: 'https://daemon.example.com',
      POWERSYNC_DAEMON_URL: 'https://daemon.example.com',
      SUPABASE_URL: 'https://supabase.example.com',
      SUPABASE_ANON_KEY: 'anon-key-staging',
      VITE_CUSTOM_FLAG: 'enabled',
      STACK_PROFILE: 'staging',
      POWERGIT_ACTIVE_PROFILE: 'staging',
    })
  })
})
