'use server'

import { neon } from '@neondatabase/serverless'
import { redirect } from 'next/navigation'

async function rule(id: number, newStatus: 'APPROVED' | 'REJECTED') {
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid id')
  const sql = neon(process.env.DATABASE_URL!)
  await sql`
    UPDATE recommendations
       SET status   = ${newStatus},
           ruled_at = now()
     WHERE id     = ${id}
       AND status  = 'DRAFT'
  `
}

export async function approveRecommendation(formData: FormData) {
  await rule(Number(formData.get('id')), 'APPROVED')
  redirect('/recommendations')
}

export async function rejectRecommendation(formData: FormData) {
  await rule(Number(formData.get('id')), 'REJECTED')
  redirect('/recommendations')
}
