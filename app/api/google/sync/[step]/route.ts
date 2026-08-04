// app/api/google/sync/[step]/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/google/sync/<step>
//
// Invoked automatically by Vercel cron (vercel.json). Vercel sends:
//   Authorization: Bearer <CRON_SECRET>
//
// Six valid steps: structure | targeting | campaign-daily |
//                  search-terms | asset-daily | recommendations
//
// Guards:
//   401  — missing/wrong Authorization header
//   400  — unknown step
//   500  — GOOGLE_DATABASE_URL absent or wrong endpoint
//   500  — step logic error (ok=false also stored in google_sync_log)
//
// maxDuration = 300 s; runtime = nodejs (google-ads-api + Pool require Node).
// ─────────────────────────────────────────────────────────────────────────────

import { type NextRequest, NextResponse } from 'next/server'
import { isKnownStep, runStep } from '@/lib/google/sync-runner'

export const runtime    = 'nodejs'
export const maxDuration = 300

const EXPECTED_HOST = 'ep-holy-star-afsf5u86'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ step: string }> },
) {
  // ── Auth: Vercel cron sends Bearer <CRON_SECRET> automatically ────────────
  const auth = req.headers.get('authorization')
  if (!process.env.CRON_SECRET || auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // ── Validate step ─────────────────────────────────────────────────────────
  const { step } = await params
  if (!isKnownStep(step)) {
    return NextResponse.json(
      {
        error: `Unknown step: "${step}". Valid: structure, targeting, campaign-daily, search-terms, asset-daily, recommendations`,
      },
      { status: 400 },
    )
  }

  // ── DB guard: GOOGLE_DATABASE_URL must present + target ep-holy-star-afsf5u86
  const dbUrl = process.env.GOOGLE_DATABASE_URL
  if (!dbUrl || !dbUrl.includes(EXPECTED_HOST)) {
    return new Response('WRONG DATABASE', { status: 500 })
  }

  // ── Run step (logs start/finish to google_sync_log; never throws) ─────────
  const { ok, rows } = await runStep(step)

  return NextResponse.json({ step, ok, rows }, { status: ok ? 200 : 500 })
}
