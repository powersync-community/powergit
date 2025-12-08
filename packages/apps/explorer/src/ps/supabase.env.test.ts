import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      resetPasswordForEmail: vi.fn(),
      updateUser: vi.fn(),
      signOut: vi.fn(),
    },
  })),
}))

import { isSupabaseConfigured, __resetSupabaseClientForTests } from './supabase.js'

describe('supabase env fallbacks', () => {
  beforeEach(() => {
    __resetSupabaseClientForTests()
    vi.unstubAllEnvs()
    delete process.env.PSGIT_TEST_SUPABASE_URL
    delete process.env.PSGIT_TEST_SUPABASE_ANON_KEY
    delete process.env.VITE_SUPABASE_URL
    delete process.env.VITE_SUPABASE_ANON_KEY
  })

  it('falls back to PSGIT_TEST_SUPABASE_* when available', () => {
    process.env.PSGIT_TEST_SUPABASE_URL = 'http://127.0.0.1:55431'
    process.env.PSGIT_TEST_SUPABASE_ANON_KEY = 'anon-key'

    expect(isSupabaseConfigured()).toBe(true)
  })

  it('falls back to local defaults when no env vars are present', () => {
    expect(isSupabaseConfigured()).toBe(true)
  })
})
