import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('loadProfileEnvironment', () => {
  const originalStackProfile = process.env.STACK_PROFILE
  const originalPsgitStackEnv = process.env.PSGIT_STACK_ENV

  let tempHome: string
  let stackEnvFile: string
  let profilesPath: string
  const originalHome = process.env.HOME

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'psgit-profile-env-'))
    mkdirSync(join(tempHome, '.psgit'), { recursive: true })
    profilesPath = join(tempHome, '.psgit', 'profiles.json')
    stackEnvFile = join(tempHome, 'stack.env')
    process.env.HOME = tempHome
    delete process.env.STACK_PROFILE
    delete process.env.PSGIT_STACK_ENV
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
    if (originalPsgitStackEnv !== undefined) {
      process.env.PSGIT_STACK_ENV = originalPsgitStackEnv
    } else {
      delete process.env.PSGIT_STACK_ENV
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('merges profile env vars with stack env exports', async () => {
    const profiles = {
      staging: {
        powersync: {
          endpoint: 'https://daemon.example.com',
          token: 'staging-token',
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
        'export POWERSYNC_SUPABASE_ANON_KEY=anon-key-staging',
        'export VITE_CUSTOM_FLAG=enabled',
      ].join('\n'),
      'utf8',
    )

    vi.resetModules()
    const { loadProfileEnvironment } = await import('./profile-env.js')

    const result = loadProfileEnvironment({
      profile: 'staging',
      stackEnvPaths: [stackEnvFile],
      startDir: tempHome,
    })

    expect(result.profile.name).toBe('staging')
    expect(result.stackEnvPath).toBe(stackEnvFile)
    expect(result.profileEnv).toMatchObject({
      POWERSYNC_ENDPOINT: 'https://daemon.example.com',
      POWERSYNC_DAEMON_TOKEN: 'staging-token',
      POWERSYNC_SUPABASE_URL: 'https://supabase.example.com',
    })
    expect(result.stackEnvValues).toMatchObject({
      POWERSYNC_SUPABASE_ANON_KEY: 'anon-key-staging',
      VITE_CUSTOM_FLAG: 'enabled',
    })
    expect(result.combinedEnv).toMatchObject({
      POWERSYNC_ENDPOINT: 'https://daemon.example.com',
      POWERSYNC_DAEMON_TOKEN: 'staging-token',
      POWERSYNC_SUPABASE_URL: 'https://supabase.example.com',
      POWERSYNC_SUPABASE_ANON_KEY: 'anon-key-staging',
      VITE_CUSTOM_FLAG: 'enabled',
      STACK_PROFILE: 'staging',
      PSGIT_ACTIVE_PROFILE: 'staging',
    })
  })
})
