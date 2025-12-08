import type { PowerSyncBackendConnector, PowerSyncCredentials, AbstractPowerSyncDatabase } from '@powersync/web'

interface ConnectorOptions {
  getToken?: () => Promise<string | null>
  endpoint?: string | null
}

const PLACEHOLDER_VALUES = new Set([
  'dev-token-placeholder',
  'anon-placeholder',
  'service-role-placeholder',
  'powersync-remote-placeholder',
])

const isPlaceholder = (value: string | undefined | null): boolean => {
  if (!value) return true
  const trimmed = value.trim()
  if (!trimmed) return true
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return true
  if (/^https?:\/\/localhost(?::\d+)?\/?$/.test(trimmed.toLowerCase()) && trimmed.includes('8090')) return true
  return false
}

function resolveEnv(name: string): string | null {
  const env = import.meta.env as Record<string, string | undefined>
  const value = env[name]
  const trimmed = value?.trim()
  if (!trimmed || isPlaceholder(trimmed)) {
    return null
  }
  return trimmed
}

export class Connector implements PowerSyncBackendConnector {
  private readonly endpoint: string | null
  private readonly getToken: () => Promise<string | null>

  constructor(options?: ConnectorOptions) {
    const fallbackEndpoint =
      resolveEnv('VITE_POWERSYNC_ENDPOINT') ?? resolveEnv('POWERSYNC_URL')
    const fallbackToken = resolveEnv('VITE_POWERSYNC_TOKEN')

    this.endpoint = options?.endpoint?.trim() || fallbackEndpoint || null
    this.getToken =
      options?.getToken ??
      (async () => {
        if (fallbackToken) return fallbackToken
        return null
      })
  }

  async fetchCredentials(): Promise<PowerSyncCredentials> {
    if (!this.endpoint) {
      throw new Error('PowerSync endpoint is not configured. Set VITE_POWERSYNC_ENDPOINT (from POWERSYNC_URL) to continue.')
    }
    console.debug('[PowerSync][connector] resolving credentials for endpoint', this.endpoint)
    const token = await this.getToken()
    if (!token) {
      throw new Error('PowerSync token is not available. Sign in or configure VITE_POWERSYNC_TOKEN.')
    }
    console.debug('[PowerSync][connector] obtained token (length)', token.length)

    return {
      endpoint: this.endpoint,
      token,
    }
  }

  async uploadData(db: AbstractPowerSyncDatabase) {
    while (true) {
      const batch = await db.getCrudBatch().catch((error) => {
        console.warn('[PowerSync] failed to fetch CRUD batch for upload', error)
        return null
      })

      if (!batch) break

      const operations = batch.crud.map((entry) => entry.toJSON())

      if (operations.length === 0) {
        try {
          await batch.complete()
        } catch (error) {
          console.warn('[PowerSync] failed to acknowledge empty CRUD batch', error)
          throw error
        }
        if (!batch.haveMore) break
        continue
      }

      throw new Error(
        'PowerSync explorer attempted to upload CRUD operations, but no upload handler is configured. Local mutations are not supported without a daemon-managed writer.',
      )
    }
  }
}
