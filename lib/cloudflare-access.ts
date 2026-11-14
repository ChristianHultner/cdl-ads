import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'

const STAFF_EMAILS = new Set([
  'christian@hultner.com', 'christian@cuentodeluz.com',
  'daniel@cuentodeluz.com', 'ana@cuentodeluz.com',
])

export function isExemptPath(pathname: string): boolean {
  return pathname === '/api/health'
    || pathname.startsWith('/api/amazon/sync/')
    || pathname.startsWith('/api/google/sync/')
    || pathname.startsWith('/.well-known/acme-challenge/')
}

export type AccessDecision =
  | { allow: true; status: 200; reason: 'valid' | 'exempt' | 'missing-env' }
  | { allow: false; status: 401 | 403; reason: 'missing-token' | 'invalid-token' | 'unknown-email' }

const remoteKeySets = new Map<string, JWTVerifyGetKey>()

function tokenFrom(request: Request): string | undefined {
  const assertion = request.headers.get('cf-access-jwt-assertion')
  if (assertion) return assertion
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === 'CF_Authorization') return value.join('=') || undefined
  }
  return undefined
}

export async function authorizeCloudflareRequest(options: {
  request: Request; teamDomain?: string; audience?: string
  isExempt: (pathname: string) => boolean; key?: JWTVerifyGetKey
}): Promise<AccessDecision> {
  const { request, teamDomain, audience, isExempt } = options
  const pathname = new URL(request.url).pathname
  const status = pathname.startsWith('/api/') ? 401 as const : 403 as const
  if (isExempt(pathname)) return { allow: true, status: 200, reason: 'exempt' }
  if (!teamDomain || !audience) return { allow: true, status: 200, reason: 'missing-env' }
  const token = tokenFrom(request)
  if (!token) return { allow: false, status, reason: 'missing-token' }

  const issuer = `https://${teamDomain}`
  let key = options.key
  if (!key) {
    const certsUrl = `${issuer}/cdn-cgi/access/certs`
    key = remoteKeySets.get(certsUrl)
    if (!key) {
      key = createRemoteJWKSet(new URL(certsUrl))
      remoteKeySets.set(certsUrl, key)
    }
  }
  try {
    const { payload } = await jwtVerify(token, key, { issuer, audience })
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : ''
    return STAFF_EMAILS.has(email)
      ? { allow: true, status: 200, reason: 'valid' }
      : { allow: false, status, reason: 'unknown-email' }
  } catch {
    return { allow: false, status, reason: 'invalid-token' }
  }
}
