'use server'

import { neon } from '@neondatabase/serverless'
import { redirect } from 'next/navigation'

const SERVER_ASIN_RE = /^([0-9]{9}[0-9Xx]|B0[A-Za-z0-9]{8})$/i

export async function approveRecommendation(formData: FormData) {
  const id = Number(formData.get('id'))
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id')

  const rawBid = formData.get('approved_bid')
  const bidNum = rawBid !== null && String(rawBid).trim() !== ''
    ? parseFloat(String(rawBid))
    : NaN

  // CREATIVE_TARGET: ASIN supplied by reviewer after Amazon verification
  const rawAsin = formData.get('asin')
  const asin    = rawAsin !== null ? String(rawAsin).trim().toUpperCase() : null
  const asinValid = asin ? SERVER_ASIN_RE.test(asin) : false

  const sql = neon(process.env.DATABASE_URL!)

  const hasBid  = !isNaN(bidNum) && isFinite(bidNum) && bidNum > 0
  const hasAsin = asinValid && asin !== null

  if (hasBid || hasAsin) {
    const patch: Record<string, unknown> = {}
    if (hasBid)  patch.approved_bid = bidNum
    if (hasAsin) patch.asin = asin
    await sql`
      UPDATE recommendations
         SET status   = 'APPROVED',
             ruled_at = now(),
             evidence = evidence || ${JSON.stringify(patch)}::jsonb
       WHERE id     = ${id}
         AND status  = 'DRAFT'
    `
  } else {
    await sql`
      UPDATE recommendations
         SET status   = 'APPROVED',
             ruled_at = now()
       WHERE id     = ${id}
         AND status  = 'DRAFT'
    `
  }

  redirect('/recommendations')
}

export async function rejectRecommendation(formData: FormData) {
  const id = Number(formData.get('id'))
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id')
  const sql = neon(process.env.DATABASE_URL!)
  await sql`
    UPDATE recommendations
       SET status   = 'REJECTED',
           ruled_at = now()
     WHERE id     = ${id}
       AND status  = 'DRAFT'
  `
  redirect('/recommendations')
}
