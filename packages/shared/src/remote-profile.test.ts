import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePowergitRemote } from './remote-profile.js'
import { PROFILE_DEFAULTS } from './profile-defaults.js'

describe('resolvePowergitRemote', () => {
  const originalHome = process.env.POWERGIT_HOME
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'powergit-profile-'))
    process.env.POWERGIT_HOME = tempHome
  })

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.POWERGIT_HOME = originalHome
    } else {
      delete process.env.POWERGIT_HOME
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('falls back to the prod profile when profile is omitted', () => {
    const remote = resolvePowergitRemote('powergit::/acme/infra')
    expect(remote).toEqual({
      org: 'acme',
      repo: 'infra',
      profileName: 'prod',
      powersyncUrl: PROFILE_DEFAULTS.prod.powersync.url,
    })
  })

  it('accepts bare paths from git helper args', () => {
    const remote = resolvePowergitRemote('/acme/infra')
    expect(remote).toEqual({
      org: 'acme',
      repo: 'infra',
      profileName: 'prod',
      powersyncUrl: PROFILE_DEFAULTS.prod.powersync.url,
    })
  })

  it('resolves profiles from profiles.json', () => {
    const profilesPath = join(tempHome, 'profiles.json')
    writeFileSync(
      profilesPath,
      JSON.stringify(
        {
          staging: { powersync: { url: 'https://powersync.staging.example.com' } },
        },
        null,
        2,
      ),
    )

    const remote = resolvePowergitRemote('powergit::staging/acme/infra')
    expect(remote).toEqual({
      org: 'acme',
      repo: 'infra',
      profileName: 'staging',
      powersyncUrl: 'https://powersync.staging.example.com',
    })
  })
})
