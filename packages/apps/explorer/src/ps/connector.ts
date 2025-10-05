
import type { PowerSyncBackendConnector, PowerSyncCredentials, AbstractPowerSyncDatabase } from '@powersync/web'
import { getSupabaseClient, invokeSupabaseFunction } from './supabase'

interface SupabaseCredentialResponse {
  endpoint: string
  token: string
}

const DEFAULT_UPLOAD_FUNCTION = (import.meta.env.VITE_SUPABASE_POWERSYNC_UPLOAD_FN as string | undefined) ?? 'powersync-upload'
const DEFAULT_CREDENTIAL_FUNCTION = (import.meta.env.VITE_SUPABASE_POWERSYNC_CREDS_FN as string | undefined) ?? 'powersync-creds'

export class Connector implements PowerSyncBackendConnector {
  async fetchCredentials(): Promise<PowerSyncCredentials> {
    const supabase = getSupabaseClient()
    if (supabase) {
      const credentials = await invokeSupabaseFunction<SupabaseCredentialResponse>(DEFAULT_CREDENTIAL_FUNCTION)
      return credentials
    }
    return {
      endpoint: import.meta.env.VITE_POWERSYNC_ENDPOINT || 'https://YOUR-POWERSYNC-ENDPOINT',
      token: import.meta.env.VITE_POWERSYNC_TOKEN || 'DEV_TOKEN_PLACEHOLDER',
    }
  }

  async uploadData(db: AbstractPowerSyncDatabase) {
    const supabase = getSupabaseClient()
    if (!supabase) return
    const getCrudBatch = (db as unknown as { getCrudBatch?: () => Promise<any> }).getCrudBatch
    if (!getCrudBatch) return
    const batch = await getCrudBatch()
    if (!batch || !Array.isArray(batch.operations) || batch.operations.length === 0) return
    try {
      await invokeSupabaseFunction(DEFAULT_UPLOAD_FUNCTION, { operations: batch.operations })
      const acknowledge = (db as unknown as { acknowledgeCrudBatch?: (id: string) => Promise<void> }).acknowledgeCrudBatch
      if (acknowledge && batch.id) await acknowledge.call(db, batch.id)
    } catch (error) {
      console.error('[PowerSync] failed to upload CRUD batch via Supabase', error)
      throw error
    }
  }
}
