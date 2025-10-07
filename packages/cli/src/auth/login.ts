import { invokeSupabaseEdgeFunction } from '@shared/core'
import { extractJwtMetadata } from './token.js'
import { clearStoredCredentials, saveStoredCredentials, type StoredCredentials } from './session.js'

export interface LoginOptions {
  endpoint?: string
  token?: string
  functionsUrl?: string
  credentialFunction?: string
  serviceRoleKey?: string
  sessionPath?: string
  verbose?: boolean
}

export interface LoginResult {
  credentials: StoredCredentials
  source: 'manual' | 'supabase-function'
}

const DEFAULT_CREDENTIAL_FUNCTION = process.env.POWERSYNC_SUPABASE_CREDS_FN ?? 'powersync-creds'

function inferServiceRoleKey(explicit?: string): string | undefined {
  if (explicit) return explicit
  if (process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY) {
    return process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY
  }
  if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return process.env.SUPABASE_SERVICE_ROLE_KEY
  }
  return undefined
}

function inferFunctionsUrl(explicit?: string): string | undefined {
  if (explicit) return explicit
  if (process.env.POWERSYNC_SUPABASE_FUNCTIONS_URL) {
    return process.env.POWERSYNC_SUPABASE_FUNCTIONS_URL
  }
  if (process.env.PSGIT_TEST_FUNCTIONS_URL) {
    return process.env.PSGIT_TEST_FUNCTIONS_URL
  }
  return undefined
}

export async function loginWithExplicitToken(options: LoginOptions): Promise<LoginResult> {
  const endpoint = options.endpoint ?? process.env.POWERSYNC_ENDPOINT ?? process.env.PSGIT_TEST_ENDPOINT
  const token = options.token ?? process.env.POWERSYNC_TOKEN ?? process.env.PSGIT_TEST_REMOTE_TOKEN
  if (!endpoint || !token) {
    throw new Error('Endpoint and token are required. Provide --endpoint/--token or set POWERSYNC_ENDPOINT + POWERSYNC_TOKEN.')
  }

  const metadata = extractJwtMetadata(token)
  const credentials: StoredCredentials = {
    endpoint,
    token,
    expiresAt: metadata.expiresAt,
    obtainedAt: metadata.issuedAt ?? new Date().toISOString(),
  }
  await saveStoredCredentials(credentials, options.sessionPath)
  return { credentials, source: 'manual' }
}

export async function loginViaSupabaseFunction(options: LoginOptions = {}): Promise<LoginResult> {
  const functionsUrl = inferFunctionsUrl(options.functionsUrl)
  const serviceRoleKey = inferServiceRoleKey(options.serviceRoleKey)
  const functionName = options.credentialFunction ?? DEFAULT_CREDENTIAL_FUNCTION

  if (!functionName) {
    throw new Error('Credential function name is required. Set POWERSYNC_SUPABASE_CREDS_FN or pass --function.')
  }
  if (!functionsUrl) {
    throw new Error('Supabase Functions URL is required. Set POWERSYNC_SUPABASE_FUNCTIONS_URL or PSGIT_TEST_FUNCTIONS_URL.')
  }
  if (!serviceRoleKey) {
    throw new Error('Supabase service role key is required. Set POWERSYNC_SUPABASE_SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY.')
  }

  const response = await invokeSupabaseEdgeFunction<{ endpoint: string; token: string }>(functionName, undefined, {
    functionsBaseUrl: functionsUrl,
    serviceRoleKey,
  })

  if (!response?.endpoint || !response?.token) {
    throw new Error('Supabase credential function returned an invalid payload.')
  }

  const metadata = extractJwtMetadata(response.token)
  const credentials: StoredCredentials = {
    endpoint: response.endpoint,
    token: response.token,
    expiresAt: metadata.expiresAt,
    obtainedAt: metadata.issuedAt ?? new Date().toISOString(),
  }

  await saveStoredCredentials(credentials, options.sessionPath)
  return { credentials, source: 'supabase-function' }
}

export async function logout(options: { sessionPath?: string } = {}) {
  await clearStoredCredentials(options.sessionPath)
}
