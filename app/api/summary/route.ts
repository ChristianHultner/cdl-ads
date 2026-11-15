export const dynamic = 'force-dynamic'

import { NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { CAMPAIGN_METRICS_CTE } from '@/lib/amazon/campaign-display'
import { money, pct, marketName } from '@/lib/amazon/yardstick'

// Launcher summary, contract v1 (doctrine: "Launcher summary").
// Read-only. dashboard.cuentodeluz.com calls this from the viewer's browser with the
// viewer's own Cloudflare Access session and only renders what it gets. Every figure
// is this app's own and matches a page here. If anything cannot be read the request
// fails (503), so the launcher shows "No status" and never a zero.

const SELF = 'https://ads.cuentodeluz.com'
const HEADERS = {
  'Access-Control-Allow-Origin': 'https://dashboard.cuentodeluz.com',
  'Access-Control-Allow-Credentials': 'true',
  'Cache-Control': 'no-store',
  Vary: 'Origin',
}

// The six nightly steps the Data health page expects (app/amazon/health/page.tsx).
const STEP_ORDER = ['request-reports', 'structure', 'sweep', 'ingest-reports', 'rollup', 'stamp']

type Action = { label: string; href: string; severity: 'now' | 'soon' | 'info'; count?: number }
type Metric = { label: string; value: string }
type StepRow = { step: string; ok: boolean | null }
type MarketRow = { country_code: string; currency_code: string; spend: number; sales: number }

export async function GET() {
  try {
    const sql = neon(process.env.DATABASE_URL!)
    const [steps, draftRows, markets] = (await Promise.all([
      // Same window and "latest run per step" rule as Data health.
      sql`
        SELECT DISTINCT ON (step) step, ok
        FROM amazon_sync_log
        WHERE run_started_at >= now() - interval '30 hours'
        ORDER BY step, run_started_at DESC
      `,
      // Same count as "changes to approve" on the Overview.
      sql`
        SELECT count(*)::int AS n
        FROM recommendations r JOIN amazon_profiles p ON p.profile_id = r.profile_id
        WHERE r.status = 'DRAFT'
      `,
      // 30-day totals per market, all ad types, from the metrics every Amazon page uses.
      sql.query(CAMPAIGN_METRICS_CTE + `
        SELECT ap.country_code, ap.currency_code,
          coalesce(sum(m.spend),0)::float AS spend, coalesce(sum(m.sales),0)::float AS sales
        FROM amazon_profiles ap LEFT JOIN campaign_metrics m ON m.profile_id = ap.profile_id
        WHERE ap.is_active
        GROUP BY ap.country_code, ap.currency_code
        ORDER BY coalesce(array_position(ARRAY['US','ES','MX','UK','CA'], ap.country_code), 99), ap.country_code
      `),
    ])) as unknown as [StepRow[], { n: number }[], MarketRow[]]

    const drafts = draftRows[0]?.n
    if (typeof drafts !== 'number') throw new Error('draft count missing')

    const missing = STEP_ORDER.filter(k => !steps.some(r => r.step === k))
    const bad = steps.filter(r => r.ok === false)

    const actions: Action[] = []
    if (missing.length > 0) {
      actions.push({ label: 'Nightly steps with no run in 30 hours', href: `${SELF}/amazon/health`, severity: 'now', count: missing.length })
    }
    if (bad.length > 0) {
      actions.push({ label: 'Nightly steps that had a problem', href: `${SELF}/amazon/health`, severity: 'soon', count: bad.length })
    }
    if (drafts > 0) {
      actions.push({ label: 'Changes to approve', href: `${SELF}/amazon/decisions`, severity: 'soon', count: drafts })
    }

    // One market only, in its own currency: the US if it has spend, else the next market
    // that does. Currencies are never added together.
    const metrics: Metric[] = []
    const m = markets.find(r => r.spend > 0)
    if (m) {
      const name = marketName(m.country_code)
      metrics.push({ label: `Spend, 30 days (${name})`, value: money(m.spend, m.currency_code) })
      if (m.sales > 0) metrics.push({ label: `ACoS, 30 days (${name})`, value: pct(m.spend / m.sales) })
    }

    return NextResponse.json(
      { app: 'cdl-ads', generated_at: new Date().toISOString(), actions, metrics },
      { status: 200, headers: HEADERS },
    )
  } catch (e) {
    console.error('[api/summary] unavailable:', e instanceof Error ? e.message : 'unknown error')
    return NextResponse.json({ error: 'summary unavailable' }, { status: 503, headers: HEADERS })
  }
}
