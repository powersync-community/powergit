export type PowergitRuntimeConfig = {
  profile?: string | null
  supabaseUrl?: string | null
  supabaseAnonKey?: string | null
  supabaseSchema?: string | null
  powersyncEndpoint?: string | null
  daemonUrl?: string | null
  daemonDeviceLoginUrl?: string | null
  useDaemon?: boolean | null
}

function readGlobalConfig(): PowergitRuntimeConfig | null {
  if (typeof window === 'undefined') return null
  const globalObj = window as typeof window & { __POWERGIT_RUNTIME_CONFIG__?: unknown }
  const value = globalObj.__POWERGIT_RUNTIME_CONFIG__
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as PowergitRuntimeConfig
}

export function getRuntimeConfig(): PowergitRuntimeConfig | null {
  return readGlobalConfig()
}

export function getRuntimeConfigString(key: keyof PowergitRuntimeConfig): string | null {
  const config = getRuntimeConfig()
  const value = config?.[key]
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function getRuntimeConfigBoolean(key: keyof PowergitRuntimeConfig): boolean | null {
  const config = getRuntimeConfig()
  const value = config?.[key]
  if (typeof value === 'boolean') return value
  return null
}

