'use server'

import { revalidatePath } from 'next/cache'
import { getGoogleDb } from '@/lib/google/db'

export async function approveRec(formData: FormData) {
  const id   = Number(String(formData.get('id')))
  const raw  = (formData.get('note') as string | null) ?? ''
  const note = raw.trim() || null
  const sql  = getGoogleDb()
  await sql`
    UPDATE google_recommendations
       SET state        = 'APPROVED',
           decided_at   = now(),
           decided_note = ${note}
     WHERE id    = ${id}
       AND state = 'DRAFT'
  `
  revalidatePath('/google/recommendations')
}

export async function rejectRec(formData: FormData) {
  const id   = Number(String(formData.get('id')))
  const raw  = (formData.get('note') as string | null) ?? ''
  const note = raw.trim() || null
  const sql  = getGoogleDb()
  await sql`
    UPDATE google_recommendations
       SET state        = 'REJECTED',
           decided_at   = now(),
           decided_note = ${note}
     WHERE id    = ${id}
       AND state = 'DRAFT'
  `
  revalidatePath('/google/recommendations')
}
