#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function requireEnv(name) {
  const value = process.env[name]
  if (!value || !value.trim()) {
    throw new Error(`Missing required env: ${name}`)
  }
  return value.trim()
}

function randomString(len = 12) {
  return randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len)
}

async function main() {
  const supabaseUrl = requireEnv('SUPABASE_URL')
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY')
  const email = process.env.TEST_USER_EMAIL?.trim() || `powergit-${randomString(6)}@example.com`
  const password = process.env.TEST_USER_PASSWORD?.trim() || `pw-${randomString(12)}`

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })

  if (error) {
    console.error('[create-test-user] Failed to create user:', error.message ?? error)
    process.exit(1)
  }

  console.log('User created:')
  console.log(`  email: ${email}`)
  console.log(`  password: ${password}`)
  console.log(`  id: ${data?.user?.id ?? 'n/a'}`)
  console.log('')
  console.log('Set these in your GitHub secrets for the daemon:')
  console.log('  POWERGIT_EMAIL=', email)
  console.log('  POWERGIT_PASSWORD=', password)
}

main().catch((error) => {
  console.error('[create-test-user] Unexpected error:', error?.message ?? error)
  process.exit(1)
})
