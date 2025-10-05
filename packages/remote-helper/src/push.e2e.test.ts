import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Buffer } from 'node:buffer'
import jwt from 'jsonwebtoken'

import { __internals } from './index.js'

const SUPABASE_URL = process.env.E2E_SUPABASE_URL ?? process.env.POWERSYNC_SUPABASE_URL
const SUPABASE_SERVICE_ROLE_KEY = process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY
const SUPABASE_PUSH_FN = process.env.E2E_SUPABASE_PUSH_FN ?? process.env.POWERSYNC_SUPABASE_PUSH_FN

const canRun = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY)

const originalEnv = { ...process.env }

const suite = canRun ? describe : describe.skip

function createServiceRoleToken(secret: string): string {
  const payload = {
    role: 'service_role',
    iss: 'powersync-e2e',
    sub: 'service-role',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  }
  return jwt.sign(payload, secret, { algorithm: 'HS256' })
}

suite('remote helper push e2e (production Supabase)', () => {
  let internals: typeof import('./index.js')['__internals']

  beforeAll(async () => {
    process.env.POWERSYNC_SUPABASE_URL = SUPABASE_URL
    process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY = SUPABASE_SERVICE_ROLE_KEY
    if (SUPABASE_PUSH_FN) process.env.POWERSYNC_SUPABASE_PUSH_FN = SUPABASE_PUSH_FN
    process.env.POWERSYNC_REMOTE_TOKEN = createServiceRoleToken(SUPABASE_SERVICE_ROLE_KEY as string)
    
    const mod = await import('./index.js')
    internals = mod.__internals
  })

  afterAll(() => {
    process.env = { ...originalEnv }
  })

  it('uploads mock pack data to production Supabase push function', async () => {
    const { uploadPushPack } = internals
    const updates = [{ src: '0000000000000000000000000000000000000000', dst: 'refs/heads/main' }]
    const packBuffer = Buffer.from('mock-pack-data')

    const result = await uploadPushPack({ org: 'acme', repo: 'infra' }, updates, packBuffer)

    expect(result.ok).toBe(true)
    expect(result.results?.['refs/heads/main']?.status).toBe('ok')
  })

  it('handles multiple ref updates in production', async () => {
    const { uploadPushPack } = internals
    const updates = [
      { src: '0000000000000000000000000000000000000000', dst: 'refs/heads/main' },
      { src: '0000000000000000000000000000000000000000', dst: 'refs/heads/develop' }
    ]
    const packBuffer = Buffer.from('multi-ref-pack-data')

    const result = await uploadPushPack({ org: 'acme', repo: 'infra' }, updates, packBuffer)

    expect(result.ok).toBe(true)
    expect(result.results?.['refs/heads/main']?.status).toBe('ok')
    expect(result.results?.['refs/heads/develop']?.status).toBe('ok')
  })
})
