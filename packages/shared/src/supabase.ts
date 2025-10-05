import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseServerConfig {
  url: string
  serviceRoleKey: string
  schema?: string
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
  })
  return cachedServerClient
}

export async function invokeSupabaseEdgeFunction<T = unknown>(
  functionName: string,
  payload?: Record<string, unknown>,
  config?: SupabaseServerConfig,
): Promise<T> {
  const client = getServerSupabaseClient(config)
  if (!client) throw new Error('Supabase server client not configured')
  const { data, error } = await client.functions.invoke(functionName, { body: payload ?? {} })
  if (error) throw error
  return data as T
}
