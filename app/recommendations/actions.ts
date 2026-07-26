'use server'

import { neon } from '@neondatabase/serverless'
import { redirect } from 'next/navigation'

export async function approveRecommendation(formData: FormData) {
  const id = Number(formData.get('id'))
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id')

  const rawBid = formData.get('approved_bid')
  const bidNum = rawBid !== null && String(rawBid).trim() !== ''
    ? parseFloat(String(rawBid))
    : NaN

  const sql = neon(process.env.DATABASE_URL!)

  if (!isNaN(bidNum) && isFinite(bidNum) && bidNum > 0) {
    await sql`
      UPDATE recommendations
         SET status   = 'APPROVED',
             ruled_at = now(),
             evidence = evidence || jsonb_build_object('approved_bid', ${bidNum}::numeric)
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
