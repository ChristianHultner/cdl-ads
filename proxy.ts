import { NextRequest, NextResponse } from 'next/server'
import { authorizeCloudflareRequest, isExemptPath } from './lib/cloudflare-access'

let warnedMissingEnv = false

export async function proxy(request: NextRequest) {
  const teamDomain = process.env.CF_ACCESS_TEAM_DOMAIN
  const audience = process.env.CF_ACCESS_AUD
  const decision = await authorizeCloudflareRequest({ request, teamDomain, audience, isExempt: isExemptPath })
  if (decision.reason === 'missing-env' && !warnedMissingEnv) {
    warnedMissingEnv = true
    console.warn('Cloudflare Access gate disabled: CF_ACCESS_TEAM_DOMAIN or CF_ACCESS_AUD is missing')
  }
  if (decision.allow) return NextResponse.next()
  if (decision.status === 401) {
    return NextResponse.json({ error: 'Cloudflare sign-in required' }, { status: 401 })
  }
  return new NextResponse('Sign in at https://ads.cuentodeluz.com', {
    status: 403, headers: { 'content-type': 'text/plain; charset=utf-8' },
  })
}
