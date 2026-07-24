import { NextResponse } from 'next/server'

export async function GET() {
  return NextResponse.json({ app: 'cdl-ads', status: 'ok' }, { status: 200 })
}
