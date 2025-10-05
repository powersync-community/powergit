import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@shared/core', async () => {
  const actual = await vi.importActual<typeof import('@shared/core')>('@shared/core')
  return {
    ...actual,
    invokeSupabaseEdgeFunction: vi.fn(),
  }
})

import { __internals } from './index.js'
import { invokeSupabaseEdgeFunction } from '@shared/core'

describe('remote helper Supabase integration', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.resetAllMocks()
    process.env = { ...originalEnv }
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it('fetches token via Supabase edge function when configured', async () => {
    process.env.POWERSYNC_SUPABASE_URL = 'https://supabase.local'
    process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY = 'service-key'
    ;(invokeSupabaseEdgeFunction as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ token: 'from-supabase' })

    const token = await __internals.requestSupabaseToken({ endpoint: 'https://ps.example', org: 'acme', repo: 'infra' })
    expect(token).toBe('from-supabase')
    expect(invokeSupabaseEdgeFunction).toHaveBeenCalledWith(
      'powersync-remote-token',
      { remoteUrl: 'https://ps.example/orgs/acme/repos/infra' },
      { url: 'https://supabase.local', serviceRoleKey: 'service-key' },
    )
  })
})
