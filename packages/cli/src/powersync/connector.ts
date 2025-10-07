import type { AbstractPowerSyncDatabase, PowerSyncBackendConnector, PowerSyncCredentials } from '@powersync/node'
import { invokeSupabaseEdgeFunction } from '@shared/core'
import { isCredentialExpired, loadStoredCredentials } from '../auth/session.js'

interface SupabaseCredentialResponse {
  endpoint: string
  token: string
}

interface SupabaseUploadRequest {
  operations: unknown[]
}

export interface CliConnectorOptions {
  endpoint?: string
  token?: string
  credentialFunction?: string
  uploadFunction?: string
  enableUploads?: boolean
  sessionPath?: string
}

const DEFAULT_CREDENTIAL_FUNCTION = process.env.POWERSYNC_SUPABASE_CREDS_FN ?? 'powersync-creds'
const DEFAULT_UPLOAD_FUNCTION = process.env.POWERSYNC_SUPABASE_UPLOAD_FN ?? 'powersync-upload'

export class CliPowerSyncConnector implements PowerSyncBackendConnector {
  constructor(private readonly options: CliConnectorOptions = {}) {}

  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const stored = await loadStoredCredentials(this.options.sessionPath)
      .catch((error) => {
        console.warn('[psgit] failed to read cached credentials', error)
        return null
      })

    if (stored) {
      if (!isCredentialExpired(stored)) {
        return { endpoint: stored.endpoint, token: stored.token }
      }
      console.warn('[psgit] cached PowerSync credentials have expired; attempting refresh...')
    }

    const endpoint =
      this.options.endpoint ??
      process.env.POWERSYNC_ENDPOINT ??
      process.env.PSGIT_TEST_ENDPOINT ??
      null
    const token =
      this.options.token ??
      process.env.POWERSYNC_TOKEN ??
      process.env.PSGIT_TEST_REMOTE_TOKEN ??
      null

    if (endpoint && token) {
      return { endpoint, token }
    }

    const functionName = this.options.credentialFunction ?? DEFAULT_CREDENTIAL_FUNCTION
    if (!functionName) {
      return null
    }

    const credentials = await invokeSupabaseEdgeFunction<SupabaseCredentialResponse>(functionName)
      .catch((error) => {
        console.warn('[psgit] failed to fetch PowerSync credentials via Supabase function', error)
        return null
      })

    if (!credentials) {
      return null
    }

    return { endpoint: credentials.endpoint, token: credentials.token }
  }

  async uploadData(db: AbstractPowerSyncDatabase): Promise<void> {
    if (this.options.enableUploads === false) {
      return
    }

    const functionName = this.options.uploadFunction ?? DEFAULT_UPLOAD_FUNCTION
    if (!functionName) {
      return
    }

    while (true) {
      const batch = await db.getCrudBatch().catch((error) => {
        console.warn('[psgit] failed to fetch CRUD batch for upload', error)
        return null
      })

      if (!batch) {
        break
      }

      const operations = batch.crud.map((entry) => entry.toJSON())

      if (operations.length === 0) {
        try {
          await batch.complete()
        } catch (error) {
          console.warn('[psgit] failed to acknowledge empty CRUD batch', error)
          throw error
        }
        if (!batch.haveMore) {
          break
        }
        continue
      }

      try {
        await invokeSupabaseEdgeFunction<SupabaseUploadRequest>(functionName, { operations })
        await batch.complete()
      } catch (error) {
        console.error('[psgit] failed to upload CRUD batch via Supabase function', error)
        throw error
      }

      if (!batch.haveMore) {
        break
      }
    }
  }
}
