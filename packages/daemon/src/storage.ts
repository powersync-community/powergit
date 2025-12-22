import type { SupabaseClient } from '@supabase/supabase-js'

export interface PackStorageOptions {
  bucket: string
  baseUrl: string
  signExpiresIn?: number
  /**
   * Creating a bucket generally requires admin/service-role privileges.
   * When false, missing buckets surface a helpful error instead of attempting creation.
   */
  allowCreateBucket?: boolean
}

const MIN_SIGN_TTL = 15

export class PackStorage {
  private readonly bucket: string
  private readonly baseUrl: string
  private readonly signTtl: number
  private readonly allowCreateBucket: boolean
  private bucketReadyPromise: Promise<void> | null = null

  constructor(private readonly client: SupabaseClient, options: PackStorageOptions) {
    this.bucket = options.bucket
    this.baseUrl = options.baseUrl.replace(/\/$/, '')
    this.signTtl = Math.max(MIN_SIGN_TTL, options.signExpiresIn ?? 60)
    this.allowCreateBucket = options.allowCreateBucket ?? false
  }

  async ensureBucket(): Promise<void> {
    if (this.bucketReadyPromise) {
      return this.bucketReadyPromise
    }

    const task = (async () => {
      if (this.allowCreateBucket) {
        const { data, error } = await this.client.storage.getBucket(this.bucket)
        if (data) return

        const message = String((error as { message?: unknown } | null | undefined)?.message ?? '')
        const isNotFound = message.toLowerCase().includes('not found')

        if (!isNotFound && error) {
          throw new Error(this.describeStorageError('bucket lookup', error))
        }

        const { error: createError } = await this.client.storage.createBucket(this.bucket, { public: false })
        if (
          createError &&
          !String((createError as { message?: unknown } | null | undefined)?.message ?? '').includes('already exists')
        ) {
          throw new Error(this.describeStorageError('bucket create', createError))
        }
        return
      }

      // For non-admin credentials, avoid bucket metadata calls (they can return 404 even when the bucket exists).
      // Instead, probe via the object API which is governed by storage.objects RLS policies.
      const { error: probeError } = await this.client.storage.from(this.bucket).list('', { limit: 1 })
      if (!probeError) return

      const probeMessage = String((probeError as { message?: unknown } | null | undefined)?.message ?? '')
      const probeStatus =
        (probeError as { status?: unknown; statusCode?: unknown } | null | undefined)?.status ??
        (probeError as { statusCode?: unknown } | null | undefined)?.statusCode
      const notFound =
        (typeof probeStatus === 'number' && probeStatus === 404) || probeMessage.toLowerCase().includes('not found')

      if (!notFound) {
        throw new Error(this.describeStorageError('bucket access', probeError))
      }

      throw new Error(
        `Supabase Storage bucket "${this.bucket}" is missing or not accessible with the current credentials (SUPABASE_URL=${this.baseUrl}). ` +
          `If the bucket exists, ensure storage RLS policies allow the authenticated user to read/write it (or provide SUPABASE_SERVICE_ROLE_KEY). ` +
          `See supabase/migrations/20251208120000_recreate_git_packs.sql.`,
      )
    })()

    this.bucketReadyPromise = task

    try {
      await task
    } catch (error) {
      this.bucketReadyPromise = null
      throw error
    }
  }

  async uploadPack(key: string, contents: Uint8Array | Buffer): Promise<number> {
    await this.ensureBucket()
    const payload = contents instanceof Uint8Array ? contents : new Uint8Array(contents)
    const { error } = await this.client.storage.from(this.bucket).upload(key, payload, {
      contentType: 'application/octet-stream',
      upsert: true,
    })
    if (error) throw new Error(this.describeStorageError('upload', error))
    return payload.byteLength
  }

  async createSignedUrl(key: string): Promise<{ url: string; expiresAt: string } | null> {
    await this.ensureBucket()
    const { data, error } = await this.client.storage.from(this.bucket).createSignedUrl(key, this.signTtl)
    if (error || !data?.signedUrl) {
      return null
    }
    const signedUrl = data.signedUrl.startsWith('http') ? data.signedUrl : `${this.baseUrl}${data.signedUrl}`
    const expiresAt = new Date(Date.now() + this.signTtl * 1000).toISOString()
    return { url: signedUrl, expiresAt }
  }

  async deleteObjects(keys: string[]): Promise<void> {
    if (!keys.length) return
    await this.ensureBucket()
    const { error } = await this.client.storage.from(this.bucket).remove(keys)
    if (error) {
      throw new Error(this.describeStorageError('delete', error))
    }
  }

  private describeStorageError(operation: string, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    if (message.toLowerCase().includes('row-level security')) {
      return (
        `Supabase Storage ${operation} blocked by RLS for bucket "${this.bucket}". ` +
        `If you are the stack admin, apply supabase/migrations/20251208120000_recreate_git_packs.sql. ` +
        `If you are an end user, ensure you ran \`powergit login\` and retry. (${message})`
      )
    }
    return `Supabase Storage ${operation} failed for bucket "${this.bucket}": ${message}`
  }
}
