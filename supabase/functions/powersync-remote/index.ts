// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { Pool } from 'https://deno.land/x/postgres@v0.17.0/mod.ts'

const DATABASE_URL =
  Deno.env.get('POWERSYNC_DATABASE_URL') ||
  Deno.env.get('SUPABASE_DB_URL') ||
  Deno.env.get('SUPABASE_DB_CONNECTION_STRING') ||
  Deno.env.get('DATABASE_URL')

if (!DATABASE_URL) {
  console.error('[powersync-remote] DATABASE_URL missing')
  throw new Error('powersync-remote requires a Postgres connection string')
}

const pool = new Pool(DATABASE_URL, 3, true)

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers ?? {})
  headers.set('Content-Type', 'application/json')
  return new Response(JSON.stringify(body), { ...init, headers })
}

function failure(status: number, message: string): Response {
  return jsonResponse({ error: message }, { status })
}

function parseJwtClaims(req: Request): Record<string, unknown> {
  const header = req.headers.get('x-jwt-claims')
  if (!header) {
    throw new Error('Missing x-jwt-claims header; ensure verify_jwt is enabled')
  }
  try {
    return JSON.parse(header)
  } catch (error) {
    console.error('[powersync-remote] failed to parse x-jwt-claims', error)
    throw new Error('Invalid JWT claims header')
  }
}

async function authenticate(req: Request, expectedRemoteUrl: string) {
  const payload = parseJwtClaims(req)
  const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
  if (!audience.includes('authenticated')) throw new Error('Invalid audience')
  if (payload.remote_url && payload.remote_url !== expectedRemoteUrl) {
    console.warn('[powersync-remote] remote URL mismatch', payload.remote_url, expectedRemoteUrl)
    throw new Error('Remote URL mismatch')
  }
  return payload
}

function parseRequest(url: URL) {
  const queryPath = url.searchParams.get('path')
  const pathname = queryPath ?? url.pathname
  const orgIdx = pathname.indexOf('/orgs/')
  if (orgIdx === -1) return null

  const basePath = pathname.slice(0, orgIdx)
  const tail = pathname.slice(orgIdx)
  const parts = tail.split('/').filter(Boolean)
  if (parts.length < 4) return null
  if (parts[0] !== 'orgs' || parts[2] !== 'repos') return null

  const org = decodeURIComponent(parts[1] ?? '')
  const repo = decodeURIComponent(parts[3] ?? '')
  const remainder = parts.slice(4)

  if (!org || !repo) return null

  const effectiveBasePath = queryPath ? url.pathname : basePath
  const encodedOrg = encodeURIComponent(org)
  const encodedRepo = encodeURIComponent(repo)
  const resourcePath = `/orgs/${encodedOrg}/repos/${encodedRepo}`

  let expectedRemoteUrl: string
  if (queryPath) {
    const baseUrl = new URL(url.origin + url.pathname)
    baseUrl.searchParams.set('path', resourcePath)
    expectedRemoteUrl = baseUrl.toString()
  } else {
    expectedRemoteUrl = `${url.origin}${effectiveBasePath}${resourcePath}`
  }

  return {
    org,
    repo,
    basePath: effectiveBasePath,
    remainder,
    expectedRemoteUrl,
  }
}

async function handleListRefs(org: string, repo: string) {
  const client = await pool.connect()
  try {
    const result = await client.queryObject<{ name: string; target_sha: string; updated_at: string }>(
      'SELECT name, target_sha, updated_at FROM refs WHERE org_id = $1 AND repo_id = $2 ORDER BY name ASC',
      org,
      repo,
    )
    const rows = result.rows ?? []
    const head = rows.find((row) => row.name === 'HEAD')

    return jsonResponse({
      refs: rows.map((row) => ({
        name: row.name,
        target_sha: row.target_sha,
        updated_at: row.updated_at,
      })),
      head: head ? { target: head.target_sha, oid: head.target_sha } : undefined,
    })
  } finally {
    client.release()
  }
}

serve(async (req) => {
  const url = new URL(req.url)
  const parsed = parseRequest(url)
  if (!parsed) {
    return failure(404, 'Not Found')
  }

  try {
    await authenticate(req, parsed.expectedRemoteUrl)
  } catch (error) {
    console.warn('[powersync-remote] auth failed', error)
    return failure(401, 'Unauthorized')
  }

  if (req.method === 'GET' && parsed.remainder.length === 1 && parsed.remainder[0] === 'refs') {
    try {
      return await handleListRefs(parsed.org, parsed.repo)
    } catch (error) {
      console.error('[powersync-remote] failed to list refs', error)
      return failure(500, 'Failed to list refs')
    }
  }

  if (req.method === 'POST' && parsed.remainder.length === 2 && parsed.remainder[0] === 'git' && parsed.remainder[1] === 'fetch') {
    try {
      return await handleFetchPack(parsed.org, parsed.repo)
    } catch (error) {
      console.error('[powersync-remote] failed to serve pack', error)
      return failure(500, 'Failed to serve pack')
    }
  }

  if (parsed.remainder.length >= 1 && parsed.remainder[0] === 'git') {
    return failure(501, 'Git operations not implemented yet')
  }

  return failure(404, 'Not Found')
})

async function handleFetchPack(org: string, repo: string) {
  const client = await pool.connect()
  try {
    const result = await client.queryObject<{ pack_bytes: Uint8Array; pack_oid?: string }>(
      'SELECT pack_bytes, pack_oid FROM git_packs WHERE org_id = $1 AND repo_id = $2 ORDER BY created_at DESC LIMIT 1',
      org,
      repo,
    )
    const row = result.rows?.[0]
    const packBytes = row?.pack_bytes
    if (!packBytes || packBytes.length === 0) {
      return failure(404, 'Pack not found')
    }
    const headers = new Headers({
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(packBytes.length),
    })
    if (row?.pack_oid) {
      headers.set('X-PowerSync-Pack-Oid', row.pack_oid)
    }
    return new Response(packBytes, { headers })
  } finally {
    client.release()
  }
}
