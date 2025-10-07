// @ts-nocheck

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts'
import { signJwt } from '../_shared/jwt.ts'

interface RemoteTokenRequest {
  remoteUrl?: string
}

interface RemoteTokenResponse {
  token: string
}

const TOKEN_AUDIENCE_RAW = Deno.env.get('POWERSYNC_REMOTE_TOKEN_AUDIENCE')?.trim()
const TOKEN_ISSUER = Deno.env.get('POWERSYNC_REMOTE_TOKEN_ISSUER')?.trim() ?? 'powersync-dev-stack'
const TOKEN_SUBJECT = Deno.env.get('POWERSYNC_REMOTE_TOKEN_SUBJECT')?.trim() ?? 'powersync-remote-helper'
const TOKEN_ROLE = Deno.env.get('POWERSYNC_REMOTE_TOKEN_ROLE')?.trim() ?? 'service_role'

function parseAudience(raw?: string): string | string[] {
  if (!raw) return 'authenticated'
  const parts = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  if (parts.length === 0) return 'authenticated'
  return parts.length === 1 ? parts[0] : parts
}

const TOKEN_AUDIENCE = parseAudience(TOKEN_AUDIENCE_RAW)

async function signRemoteToken(remoteUrl?: string, ttlSeconds = 30 * 60) {
  const issuedAt = getNumericDate(0)
  const expiresAt = getNumericDate(ttlSeconds)
  const payload: Record<string, unknown> = {
    aud: TOKEN_AUDIENCE,
    exp: expiresAt,
    iat: issuedAt,
    iss: TOKEN_ISSUER,
    role: TOKEN_ROLE,
    sub: TOKEN_SUBJECT,
  }

  if (remoteUrl) {
    payload.remote_url = remoteUrl
  }

  return await signJwt(payload)
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    const body = (await req.json().catch(() => ({}))) as RemoteTokenRequest
    console.log('[powersync-remote-token] request for', body.remoteUrl)

    const result: RemoteTokenResponse = {
      token: await signRemoteToken(body.remoteUrl),
    }

    return new Response(JSON.stringify(result), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.error('[powersync-remote-token] error', error)
    return new Response('Internal Server Error', { status: 500 })
  }
})


