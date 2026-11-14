import assert from 'node:assert/strict'
import test from 'node:test'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { authorizeCloudflareRequest, isExemptPath } from './cloudflare-access.ts'

const issuer = 'https://hultner.cloudflareaccess.com'
const audience = 'ads-audience'
const { privateKey, publicKey } = await generateKeyPair('RS256')
const publicJwk = await exportJWK(publicKey)
Object.assign(publicJwk, { kid: 'test-key', alg: 'RS256' })
const key = createLocalJWKSet({ keys: [publicJwk] })

async function signed(email, options = {}) {
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({ email }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer).setAudience(options.audience ?? audience).setIssuedAt(now)
    .setExpirationTime(options.expires ?? now + 300).sign(options.privateKey ?? privateKey)
}

async function decide(path, token, env = {}) {
  return authorizeCloudflareRequest({
    request: new Request(`https://ads.cuentodeluz.com${path}`, { headers: token ? { 'cf-access-jwt-assertion': token } : undefined }),
    teamDomain: env.teamDomain === null ? undefined : issuer.slice(8),
    audience: env.audience === null ? undefined : audience, isExempt: isExemptPath, key,
  })
}

test('valid staff header and cookie tokens pass', async () => {
  const token = await signed('christian@hultner.com')
  assert.equal((await decide('/', token)).status, 200)
  const result = await authorizeCloudflareRequest({
    request: new Request('https://ads.cuentodeluz.com/', { headers: { cookie: `CF_Authorization=${token}` } }),
    teamDomain: issuer.slice(8), audience, isExempt: isExemptPath, key,
  })
  assert.equal(result.status, 200)
})

test('unknown email, wrong audience, expired token, bad signature and no token block pages and APIs', async () => {
  const otherPair = await generateKeyPair('RS256')
  const tokens = [await signed('outside@example.com'), await signed('christian@hultner.com', { audience: 'wrong' }),
    await signed('christian@hultner.com', { expires: Math.floor(Date.now() / 1000) - 1 }),
    await signed('christian@hultner.com', { privateKey: otherPair.privateKey }), undefined]
  for (const token of tokens) {
    assert.equal((await decide('/staff', token)).status, 403)
    assert.equal((await decide('/api/staff', token)).status, 401)
  }
})

test('every Cloudflare bypass path passes without a token', async () => {
  for (const path of ['/api/amazon/sync/probe', '/api/google/sync/probe', '/api/health', '/.well-known/acme-challenge/probe']) {
    assert.equal((await decide(path)).status, 200, path)
  }
})

test('missing configuration fails open', async () => {
  assert.equal((await decide('/staff', undefined, { teamDomain: null })).status, 200)
  assert.equal((await decide('/staff', undefined, { audience: null })).status, 200)
})
