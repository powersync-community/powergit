import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseServerConfig {
  url?: string
  serviceRoleKey?: string
  schema?: string
  functionsBaseUrl?: string
}

let cachedServerClient: SupabaseClient | null = null

export function getServerSupabaseClient(config?: SupabaseServerConfig): SupabaseClient | null {
  if (cachedServerClient && !config) return cachedServerClient
  const url = config?.url ?? process.env.POWERSYNC_SUPABASE_URL
  const key = config?.serviceRoleKey ?? process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return null
  cachedServerClient = createClient(url, key, {
    db: { schema: config?.schema ?? process.env.POWERSYNC_SUPABASE_SCHEMA ?? 'public' },
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${key}` } },
  }) as SupabaseClient
  return cachedServerClient
}

export async function invokeSupabaseEdgeFunction<T = unknown>(
  functionName: string,
  payload?: Record<string, unknown>,
  config?: SupabaseServerConfig,
): Promise<T> {
  const overrideBaseUrl = config?.functionsBaseUrl ?? process.env.POWERSYNC_SUPABASE_FUNCTIONS_URL
  const serviceRoleKey = config?.serviceRoleKey ?? process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY

  if (overrideBaseUrl) {
  const normalizedBase = overrideBaseUrl.replace(/\/+$/, '')
    const targetUrl = `${normalizedBase}/${functionName}`
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (serviceRoleKey) {
      headers.apikey = serviceRoleKey
      if (serviceRoleKey.includes('.')) {
        headers.Authorization = `Bearer ${serviceRoleKey}`
      }
    }

    const response = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload ?? {}),
    })

    if (!response.ok) {
      const errorText = await response.text().catch(() => '')
      throw new Error(`Supabase function ${functionName} failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`)
    }

    const contentType = response.headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      return (await response.json().catch(() => ({}))) as T
    }

    const text = await response.text()
    if (!text) return undefined as T
    try {
      return JSON.parse(text) as T
    } catch (error) {
      throw new Error(`Supabase function ${functionName} returned non-JSON response: ${(error as Error).message}`)
    }
  }

  const client = getServerSupabaseClient(config)
  if (!client) throw new Error('Supabase server client not configured')
  const { data, error } = await client.functions.invoke(functionName, { body: payload ?? {} })
  if (error) throw error
  return data as T
}
