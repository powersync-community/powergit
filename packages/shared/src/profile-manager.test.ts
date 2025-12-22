import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneProfileDefaults, PROFILE_DEFAULTS } from './profile-defaults.js'

describe('profile-manager migrations', () => {
  const originalHome = process.env.POWERGIT_HOME
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'powergit-profile-manager-'))
    process.env.POWERGIT_HOME = tempHome
  })

  afterEach(() => {
    vi.resetModules()
    if (originalHome !== undefined) {
      process.env.POWERGIT_HOME = originalHome
    } else {
      delete process.env.POWERGIT_HOME
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('migrates legacy GitHub Pages device login URL to daemon-hosted UI', async () => {
    const profilesPath = join(tempHome, 'profiles.json')
    const profiles = cloneProfileDefaults() as Record<string, any>
    profiles.prod = profiles.prod ?? {}
    profiles.prod.daemon = profiles.prod.daemon ?? {}
    profiles.prod.daemon.deviceLoginUrl = 'https://powersync-community.github.io/powergit/auth'
    writeFileSync(profilesPath, JSON.stringify(profiles, null, 2))

    vi.resetModules()
    const { resolveProfile } = await import('./profile-manager.js')

    const resolved = resolveProfile({ name: 'prod', updateState: false })
    expect(resolved.config.daemon?.deviceLoginUrl).toBe(PROFILE_DEFAULTS.prod.daemon.deviceLoginUrl)

    const migrated = JSON.parse(readFileSync(profilesPath, 'utf8')) as Record<string, any>
    expect(migrated.prod.daemon.deviceLoginUrl).toBe(PROFILE_DEFAULTS.prod.daemon.deviceLoginUrl)
  })
})

