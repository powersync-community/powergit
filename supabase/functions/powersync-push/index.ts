// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

const ZERO_SHA = '0000000000000000000000000000000000000000'
const DATABASE_URL =
  Deno.env.get('POWERSYNC_DATABASE_URL') ||
  Deno.env.get('SUPABASE_DB_URL') ||
  Deno.env.get('SUPABASE_DB_CONNECTION_STRING') ||
  Deno.env.get('DATABASE_URL')

if (!DATABASE_URL) {
  console.error('[powersync-push] DATABASE_URL missing')
  throw new Error('powersync-push requires a Postgres connection string')
}

const pool = new Pool(DATABASE_URL, 3, true)

interface GitFileChangeSummary {
  path: string
  additions: number
  deletions: number
}

interface GitCommitSummary {
  sha: string
  tree: string
  author_name: string
  author_email: string
  authored_at: string
  message: string
  parents: string[]
  files: GitFileChangeSummary[]
}

interface GitPushSummary {
  head?: string
  refs?: Array<{ name: string; target: string }>
  commits?: GitCommitSummary[]
}

interface PushMetadata {
  org: string
  repo: string
  updates: Array<{ src: string; dst: string; force?: boolean }>
  pack?: string
  packEncoding?: string
  packOid?: string
  summary?: GitPushSummary
}

interface PushResponse {
  ok: boolean
  results: Record<string, { status: 'ok' | 'error'; message?: string }>
}


serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '')
  const expected = Deno.env.get('POWERSYNC_SUPABASE_SERVICE_ROLE_KEY')
  if (!token || (expected && token !== expected)) {
    return Response.json({ msg: 'Invalid token' }, { status: 401 })
  }

  // Skip Supabase JWT verification locally (handled via function.toml verify_jwt=false).

  const contentType = (req.headers.get('content-type') ?? '').replace(/;.*$/, '').trim()

  try {
    let metadata: PushMetadata | null = null
    let packFile: File | null = null

    if (contentType === 'application/json') {
      metadata = await req.json() as PushMetadata
    } else {
      if (!contentType.includes('multipart/form-data')) {
        return new Response('Expected multipart/form-data payload', { status: 400 })
      }
      const form = await req.formData()
      const metadataRaw = form.get('metadata')
      const pack = form.get('pack')

      if (typeof metadataRaw !== 'string') {
        return new Response('Missing metadata field', { status: 400 })
      }

      try {
        metadata = JSON.parse(metadataRaw) as PushMetadata
      } catch (error) {
        console.error('[powersync-push] failed to parse metadata', error)
        return new Response('Invalid metadata JSON', { status: 400 })
      }

      if (pack instanceof File) packFile = pack
    }

    if (!metadata) {
      return new Response('Invalid metadata payload', { status: 400 })
    }

    const org = (metadata.org ?? '').trim()
    const repo = (metadata.repo ?? '').trim()
    if (!org || !repo) {
      return new Response('Missing org or repo in metadata', { status: 400 })
    }

    const updates = Array.isArray(metadata.updates) ? metadata.updates : []
    let packBytes: Uint8Array | null = null

    if (packFile) {
      const arrayBuffer = await packFile.arrayBuffer()
      packBytes = new Uint8Array(arrayBuffer)
    } else if (metadata.pack) {
      const encoding = (metadata.packEncoding ?? 'base64').toLowerCase()
      if (encoding === 'base64') {
        packBytes = decodeBase64ToBytes(metadata.pack)
      } else if (encoding === 'utf8' || encoding === 'utf-8') {
        packBytes = new TextEncoder().encode(metadata.pack)
      } else {
        console.warn('[powersync-push] unsupported inline pack encoding', encoding)
      }
    }

    console.log('[powersync-push] received push', {
      org,
      repo,
      updates: updates.length,
      packBytes: packBytes?.length ?? 0,
      summaryRefs: metadata.summary?.refs?.length ?? 0,
      summaryCommits: metadata.summary?.commits?.length ?? 0,
    })

    await persistPush({ metadata, org, repo, packBytes })

    const response: PushResponse = {
      ok: true,
      results: Object.fromEntries(
        updates.map((update) => [update.dst ?? '', { status: 'ok' as const }])
      ),
    }

    return new Response(JSON.stringify(response), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.error('[powersync-push] error', error)
    return new Response('Internal Server Error', { status: 500 })
  }
})

interface PersistPushParams {
  metadata: PushMetadata
  org: string
  repo: string
  packBytes: Uint8Array | null
}

async function persistPush(params: PersistPushParams) {
  const { metadata, org, repo, packBytes } = params
  const client = await pool.connect()
  try {
    await client.queryArray('BEGIN')

    if (packBytes && packBytes.length > 0) {
      const packOid = metadata.packOid ?? (await computePackOid(packBytes))
      await client.queryArray(
        `INSERT INTO git_packs (org_id, repo_id, pack_oid, pack_bytes, created_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (org_id, repo_id, pack_oid)
         DO UPDATE SET pack_bytes = excluded.pack_bytes, created_at = now()`,
        [org, repo, packOid, packBytes],
      )
    }

    if (metadata.summary) {
      await applyRefUpdates(client, org, repo, metadata.summary)
      await applyCommitUpdates(client, org, repo, metadata.summary)
    }

    await client.queryArray('COMMIT')
  } catch (error) {
    await client.queryArray('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function applyRefUpdates(client: any, org: string, repo: string, summary: GitPushSummary) {
  const refs = Array.isArray(summary.refs) ? summary.refs : []
  const nowIso = new Date().toISOString()
  const seenRefNames = new Set<string>()

  for (const ref of refs) {
    if (!ref || typeof ref.name !== 'string') continue
    const name = ref.name
    const target = typeof ref.target === 'string' ? ref.target : ''
    seenRefNames.add(name)

    if (!target || target === ZERO_SHA) {
      await client.queryArray('DELETE FROM refs WHERE org_id = $1 AND repo_id = $2 AND name = $3', [org, repo, name])
      continue
    }

    await client.queryArray(
      `INSERT INTO refs (org_id, repo_id, name, target_sha, updated_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, repo_id, name)
       DO UPDATE SET target_sha = excluded.target_sha, updated_at = excluded.updated_at`,
      [org, repo, name, target, nowIso],
    )
  }

  if (summary.head) {
    seenRefNames.add('HEAD')
    await client.queryArray(
      `INSERT INTO refs (org_id, repo_id, name, target_sha, updated_at)
       VALUES ($1, $2, 'HEAD', $3, $4)
       ON CONFLICT (org_id, repo_id, name)
       DO UPDATE SET target_sha = excluded.target_sha, updated_at = excluded.updated_at`,
      [org, repo, summary.head, nowIso],
    )
  }

  if (seenRefNames.size > 0) {
    await client.queryArray(
      `DELETE FROM refs WHERE org_id = $1 AND repo_id = $2 AND NOT (name = ANY($3))`,
      [org, repo, Array.from(seenRefNames)],
    )
  }
}

async function applyCommitUpdates(client: any, org: string, repo: string, summary: GitPushSummary) {
  const commits = Array.isArray(summary.commits) ? summary.commits : []

  if (commits.length === 0) {
    await client.queryArray('DELETE FROM file_changes WHERE org_id = $1 AND repo_id = $2', [org, repo])
    await client.queryArray('DELETE FROM commits WHERE org_id = $1 AND repo_id = $2', [org, repo])
    return
  }

  await client.queryArray('DELETE FROM file_changes WHERE org_id = $1 AND repo_id = $2', [org, repo])
  await client.queryArray('DELETE FROM commits WHERE org_id = $1 AND repo_id = $2', [org, repo])

  for (const commit of commits) {
    if (!commit || typeof commit.sha !== 'string') continue
    await client.queryArray(
      `INSERT INTO commits (org_id, repo_id, sha, author_name, author_email, authored_at, message, tree_sha)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (org_id, repo_id, sha)
       DO UPDATE SET author_name = excluded.author_name,
                   author_email = excluded.author_email,
                   authored_at = excluded.authored_at,
                   message = excluded.message,
                   tree_sha = excluded.tree_sha`,
      [
        org,
        repo,
        commit.sha,
        commit.author_name ?? '',
        commit.author_email ?? '',
        commit.authored_at ?? new Date().toISOString(),
        commit.message ?? '',
        commit.tree ?? '',
      ],
    )

    if (Array.isArray(commit.files)) {
      for (const file of commit.files) {
        if (!file || typeof file.path !== 'string') continue
        const additions = typeof file.additions === 'number' && Number.isFinite(file.additions) ? file.additions : 0
        const deletions = typeof file.deletions === 'number' && Number.isFinite(file.deletions) ? file.deletions : 0
        await client.queryArray(
          `INSERT INTO file_changes (org_id, repo_id, commit_sha, path, additions, deletions)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (org_id, repo_id, commit_sha, path)
           DO UPDATE SET additions = excluded.additions, deletions = excluded.deletions`,
          [org, repo, commit.sha, file.path, additions, deletions],
        )
      }
    }
  }
}

async function computePackOid(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  const hashArray = Array.from(new Uint8Array(digest))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

