import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface SupabaseConfig {
  url: string
  anonKey: string
  schema?: string
}

let cached: SupabaseClient | null = null

export function getSupabaseClient(): SupabaseClient | null {
  if (cached) return cached
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
  if (!url || !anonKey) return null
  cached = createClient(url, anonKey, {
    db: { schema: (import.meta.env.VITE_SUPABASE_SCHEMA as string | undefined) ?? 'public' },
    auth: { persistSession: false },
  })
  return cached
}

export async function invokeSupabaseFunction<T = unknown>(
  functionName: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const client = getSupabaseClient()
  if (!client) throw new Error('Supabase client not configured')
  const { data, error } = await client.functions.invoke(functionName, { body: payload ?? {} })
  if (error) throw error
  return data as T
}
