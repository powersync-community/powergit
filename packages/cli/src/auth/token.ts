export interface JwtMetadata {
  expiresAt?: string
  issuedAt?: string
  payload?: Record<string, unknown>
}

function decodeBase64Url(segment: string): string {
  segment = segment.replace(/-/g, '+').replace(/_/g, '/')
  const padded = segment.padEnd(segment.length + ((4 - (segment.length % 4)) % 4), '=')
  return Buffer.from(padded, 'base64').toString('utf8')
}

export function extractJwtMetadata(token: string): JwtMetadata {
  const parts = token.split('.')
  if (parts.length < 2) return {}
  try {
    const payloadJson = decodeBase64Url(parts[1] ?? '')
    const payload = JSON.parse(payloadJson) as Record<string, unknown>
    const result: JwtMetadata = { payload }
    if (typeof payload.exp === 'number') {
      result.expiresAt = new Date(payload.exp * 1000).toISOString()
    }
    if (typeof payload.iat === 'number') {
      result.issuedAt = new Date(payload.iat * 1000).toISOString()
    }
    return result
  } catch (error) {
    return {}
  }
}
