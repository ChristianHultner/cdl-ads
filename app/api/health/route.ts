import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json(
    {
      app: 'cdl-ads',
      status: 'ok',
      commit: process.env.VERCEL_GIT_COMMIT_SHA ?? 'NOT-A-GITHUB-BUILD',
      ref: process.env.VERCEL_GIT_COMMIT_REF ?? null,
    },
    { status: 200 }
  )
}
