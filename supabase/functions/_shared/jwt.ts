// @ts-nocheck

const RSA_PRIVATE_KEY = Deno.env.get('POWERSYNC_REMOTE_TOKEN_PRIVATE_KEY')?.trim()
const RSA_KEY_ID = Deno.env.get('POWERSYNC_REMOTE_TOKEN_KEY_ID')?.trim()

let rsaSigningKeyPromise: Promise<CryptoKey> | null = null

function requireRsaKeyConfig(): { pem: string; kid: string } {
  if (!RSA_PRIVATE_KEY) {
    throw new Error('RS256 private key not configured')
  }
  if (!RSA_KEY_ID) {
    throw new Error('RS256 key id (POWERSYNC_REMOTE_TOKEN_KEY_ID) is required when providing a private key')
  }
  return { pem: RSA_PRIVATE_KEY, kid: RSA_KEY_ID }
}

function pemToBinary(pem: string): Uint8Array {
  const base64 = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '')
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

async function getRsaSigningKey(): Promise<CryptoKey> {
  if (!rsaSigningKeyPromise) {
    const { pem } = requireRsaKeyConfig()
    const keyBytes = pemToBinary(pem)
    rsaSigningKeyPromise = crypto.subtle.importKey(
      'pkcs8',
      keyBytes,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    )
  }
  return rsaSigningKeyPromise
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i])
  }
  const base64 = btoa(binary)
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export async function signJwt(payload: Record<string, unknown>): Promise<string> {
  const encoder = new TextEncoder()
  const { kid } = requireRsaKeyConfig()
  const header: Record<string, unknown> = { alg: 'RS256', typ: 'JWT', kid }
  const headerSegment = base64UrlEncode(encoder.encode(JSON.stringify(header)))
  const payloadSegment = base64UrlEncode(encoder.encode(JSON.stringify(payload)))
  const signingInput = `${headerSegment}.${payloadSegment}`

  const signatureBytes = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await getRsaSigningKey(), encoder.encode(signingInput)),
  )

  const signatureSegment = base64UrlEncode(signatureBytes)
  return `${signingInput}.${signatureSegment}`
}

export function resetJwtSignerCache() {
  rsaSigningKeyPromise = null
}
