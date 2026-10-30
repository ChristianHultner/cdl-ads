'use server'

// Approve / reject / undo for the Decisions page. The SQL for approve and reject is
// the same as the old recommendations actions (status only moves out of DRAFT);
// undo moves an APPROVED row that has not been sent back to DRAFT.

import { neon } from '@neondatabase/serverless'
import { redirect } from 'next/navigation'

const SERVER_ASIN_RE = /^([0-9]{9}[0-9Xx]|B0[A-Za-z0-9]{8})$/i

function back(formData: FormData): string {
  const b = String(formData.get('back') ?? '')
  return b.startsWith('/amazon/decisions') && !b.includes('//') ? b : '/amazon/decisions'
}

function idOf(formData: FormData): number {
  const id = Number(formData.get('id'))
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id')
  return id
}

export async function approveDecision(formData: FormData) {
  const id = idOf(formData)
  const rawBid = formData.get('approved_bid')
  const bidNum = rawBid !== null && String(rawBid).trim() !== '' ? parseFloat(String(rawBid).replace(',', '.')) : NaN
  const rawAsin = formData.get('asin')
  const asin = rawAsin !== null ? String(rawAsin).trim().toUpperCase() : null
  const hasBid = !isNaN(bidNum) && isFinite(bidNum) && bidNum > 0
  const hasAsin = asin !== null && SERVER_ASIN_RE.test(asin)

  const sql = neon(process.env.DATABASE_URL!)
  if (hasBid || hasAsin) {
    const patch: Record<string, unknown> = {}
    if (hasBid) patch.approved_bid = bidNum
    if (hasAsin) patch.asin = asin
    await sql`
      UPDATE recommendations
         SET status = 'APPROVED', ruled_at = now(), evidence = evidence || ${JSON.stringify(patch)}::jsonb
       WHERE id = ${id} AND status = 'DRAFT'
    `
  } else {
    await sql`
      UPDATE recommendations SET status = 'APPROVED', ruled_at = now()
       WHERE id = ${id} AND status = 'DRAFT' AND rec_type <> 'CREATIVE_TARGET'
    `
  }
  redirect(back(formData))
}

export async function rejectDecision(formData: FormData) {
  const id = idOf(formData)
  const sql = neon(process.env.DATABASE_URL!)
  await sql`
    UPDATE recommendations SET status = 'REJECTED', ruled_at = now()
     WHERE id = ${id} AND status = 'DRAFT'
  `
  redirect(back(formData))
}

// Approve every listed DRAFT at its proposed values. CREATIVE_TARGET is never
// bulk-approved because it needs a checked ASIN.
export async function approveMany(formData: FormData) {
  const ids = String(formData.get('ids') ?? '')
    .split(',').map(Number).filter(x => Number.isInteger(x) && x > 0)
  if (ids.length === 0 || ids.length > 500) throw new Error('Invalid ids')
  const sql = neon(process.env.DATABASE_URL!)
  await sql`
    UPDATE recommendations SET status = 'APPROVED', ruled_at = now()
     WHERE id = ANY(${ids}::bigint[]) AND status = 'DRAFT' AND rec_type <> 'CREATIVE_TARGET'
  `
  redirect(back(formData))
}

export async function undoApproval(formData: FormData) {
  const id = idOf(formData)
  const sql = neon(process.env.DATABASE_URL!)
  await sql`
    UPDATE recommendations SET status = 'DRAFT', ruled_at = NULL
     WHERE id = ${id} AND status = 'APPROVED' AND pushed_at IS NULL
  `
  redirect(back(formData))
}
