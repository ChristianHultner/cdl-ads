// GET /api/amazon/sync/<step>: Vercel cron sends Bearer <CRON_SECRET>.
// Copy-adapted from the Google dispatcher; no Google imports or modifications.
// The .mjs scripts remain the launchd path, running in parallel (no cutover).
import { type NextRequest, NextResponse } from 'next/server'
import { isAmazonDatabase, isKnownStep, KNOWN_STEPS, runStep } from '@/lib/amazon/sync-runner'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ step: string }> },
) {
  const auth = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const { step } = await params
  if (!isKnownStep(step)) {
    return NextResponse.json(
      { error: `Unknown step: "${step}". Valid: ${KNOWN_STEPS.join(', ')}` },
      { status: 400 },
    )
  }
  if (!isAmazonDatabase(process.env.DATABASE_URL)) {
    return new Response('WRONG DATABASE', { status: 500 })
  }
  const { ok, rows, detail } = await runStep(step)
  return NextResponse.json({ step, ok, rows, detail }, { status: ok ? 200 : 500 })
}
