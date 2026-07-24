import { NextResponse } from 'next/server'

export async function GET() {
  const url = process.env.DATABASE_URL ?? ''
  const match = url.match(/@([^/?]+)/)
  const host = match ? match[1] : 'NOT_FOUND'
  return NextResponse.json({ host })
}
