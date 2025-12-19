import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolvePowergitRemoteUrl } from './remote-alias.js'
import { PROFILE_DEFAULTS } from './profile-defaults.js'

describe('resolvePowergitRemoteUrl', () => {
  const originalHome = process.env.POWERGIT_HOME
  const originalPoweryncUrl = process.env.POWERSYNC_URL
  const originalPowergitTestEndpoint = process.env.POWERGIT_TEST_ENDPOINT
  let tempHome: string

  beforeEach(() => {
    tempHome = mkdtempSync(join(tmpdir(), 'powergit-alias-'))
    process.env.POWERGIT_HOME = tempHome
    delete process.env.POWERSYNC_URL
    delete process.env.POWERGIT_TEST_ENDPOINT
  })

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.POWERGIT_HOME = originalHome
    } else {
      delete process.env.POWERGIT_HOME
    }
    if (originalPoweryncUrl !== undefined) {
      process.env.POWERSYNC_URL = originalPoweryncUrl
    } else {
      delete process.env.POWERSYNC_URL
    }
    if (originalPowergitTestEndpoint !== undefined) {
      process.env.POWERGIT_TEST_ENDPOINT = originalPowergitTestEndpoint
    } else {
      delete process.env.POWERGIT_TEST_ENDPOINT
    }
    rmSync(tempHome, { recursive: true, force: true })
  })

  it('falls back to the prod profile when alias is omitted', () => {
    const remote = resolvePowergitRemoteUrl('powergit::/acme/infra')
    const endpoint = PROFILE_DEFAULTS.prod.powersync.url
    expect(remote).toBe(`powergit::${endpoint}/orgs/acme/repos/infra`)
  })

  it('expands profile aliases from profiles.json', () => {
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

    const remote = resolvePowergitRemoteUrl('powergit::staging/acme/infra')
    expect(remote).toBe('powergit::https://powersync.staging.example.com/orgs/acme/repos/infra')
  })

  it('respects POWERSYNC_URL when alias is omitted', () => {
    process.env.POWERSYNC_URL = 'https://powersync.env.example.com'
    const remote = resolvePowergitRemoteUrl('powergit::/acme/infra')
    expect(remote).toBe('powergit::https://powersync.env.example.com/orgs/acme/repos/infra')
  })
})
