// @ts-nocheck

import { serve } from 'https://deno.land/std@0.224.0/http/server.ts'
import { getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts'
import { signJwt as signRs256Jwt } from '../_shared/jwt.ts'

interface CredentialResponse {
  endpoint: string
  token: string
}

const DEFAULT_ENDPOINT = Deno.env.get('POWERSYNC_ENDPOINT') ?? 'http://localhost:8090'
function resolveUserId(body: Record<string, unknown>): string {
  const candidate = body.user_id ?? body.userId ?? '00000000-0000-0000-0000-000000000000'
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : '00000000-0000-0000-0000-000000000000'
}

async function signUserJwt(userId: string, ttlSeconds = 60 * 60) {
  const issuedAt = getNumericDate(0)
  const expiresAt = getNumericDate(ttlSeconds)
  return await signRs256Jwt({
    aud: 'authenticated',
    exp: expiresAt,
    iat: issuedAt,
    iss: 'powersync-dev-stack',
    role: 'authenticated',
    sub: userId,
  })
}

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
    console.log('[powersync-creds] request', body)

  const userId = resolveUserId(body)
  const token = await signUserJwt(userId)

    const payload: CredentialResponse = {
      endpoint: DEFAULT_ENDPOINT,
      token,
    }

    return new Response(JSON.stringify(payload), {
      headers: { 'Content-Type': 'application/json' },
      status: 200,
    })
  } catch (error) {
    console.error('[powersync-creds] error', error)
    return new Response('Internal Server Error', { status: 500 })
  }
})


