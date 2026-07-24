import { NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'

export async function GET() {
  let db: 'ok' | 'unreachable' = 'unreachable'
  try {
    const sql = neon(process.env.DATABASE_URL!)
    await sql`SELECT 1`
    db = 'ok'
  } catch {
    db = 'unreachable'
  }

  return NextResponse.json(
    {
      app: 'cdl-ads',
      status: 'ok',
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'NOT-A-GITHUB-BUILD',
      ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
      db,
    },
    { status: 200 }
  )
}
