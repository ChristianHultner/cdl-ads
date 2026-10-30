import { Fraunces, Nunito_Sans } from 'next/font/google'
import { neon } from '@neondatabase/serverless'
import AmazonFrame from './AmazonFrame'
import s from './ui.module.css'

export const dynamic = 'force-dynamic'

const display = Fraunces({ subsets: ['latin'], variable: '--ads-display', display: 'swap' })
const body = Nunito_Sans({ subsets: ['latin'], variable: '--ads-body', display: 'swap' })

// Header facts for every Amazon page. A failed read never breaks a page:
// the chip then says it could not check.
async function headerFacts(): Promise<{ drafts: number; dataTo: string | null; failed: number; checked: boolean }> {
  try {
    const sql = neon(process.env.DATABASE_URL!)
    const rows = (await sql`
      SELECT
        (SELECT count(*)::int FROM recommendations WHERE status = 'DRAFT') AS drafts,
        (SELECT max(date)::text FROM amazon_campaign_daily) AS data_to,
        (SELECT count(*)::int FROM amazon_sync_log
          WHERE run_started_at >= now() - interval '24 hours' AND ok = false) AS failed
    `) as { drafts: number; data_to: string | null; failed: number }[]
    const r = rows[0]
    return { drafts: r?.drafts ?? 0, dataTo: r?.data_to ?? null, failed: r?.failed ?? 0, checked: true }
  } catch {
    return { drafts: 0, dataTo: null, failed: 0, checked: false }
  }
}

export default async function AmazonLayout({ children }: { children: React.ReactNode }) {
  const facts = await headerFacts()
  return (
    <div className={`${display.variable} ${body.variable} ${s.shell}`}>
      <AmazonFrame drafts={facts.drafts} dataTo={facts.dataTo} failed={facts.failed} checked={facts.checked}>
        {children}
      </AmazonFrame>
    </div>
  )
}
