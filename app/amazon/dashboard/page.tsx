export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import VerdictStrip,  { type MarketVerdictRow }  from './components/VerdictStrip'
import ChartSection,  { type MarketChartData }   from './components/ChartSection'
import MoversRow,     { type MoverRow, type ClusterStats } from './components/MoversRow'
import MachineFooter, { type MachineData }       from './components/MachineFooter'
import type { ChartPoint } from './components/SalesSpendChart'

export default async function DashboardPage() {
  const sql = neon(process.env.DATABASE_URL!)

  const [
    verdictRows,
    chartRows,
    clusterRows,
    moverRows,
    watchdogRow,
    actionsRow,
  ] = await Promise.all([

    // ── Verdict strip: this week + 4-week prior-avg, per profile/currency ──
    sql`
      SELECT
        p.country_code,
        p.currency_code,
        p.target_acos::float,
        COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-7  AND dr.date < CURRENT_DATE THEN dr.sales ELSE 0 END),0)::float AS sales_this,
        COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-7  AND dr.date < CURRENT_DATE THEN dr.spend ELSE 0 END),0)::float AS spend_this,
        ((COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-14 AND dr.date < CURRENT_DATE-7  THEN dr.sales ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-21 AND dr.date < CURRENT_DATE-14 THEN dr.sales ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-28 AND dr.date < CURRENT_DATE-21 THEN dr.sales ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-35 AND dr.date < CURRENT_DATE-28 THEN dr.sales ELSE 0 END),0)
        )/4.0)::float AS sales_prior_avg,
        ((COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-14 AND dr.date < CURRENT_DATE-7  THEN dr.spend ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-21 AND dr.date < CURRENT_DATE-14 THEN dr.spend ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-28 AND dr.date < CURRENT_DATE-21 THEN dr.spend ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-35 AND dr.date < CURRENT_DATE-28 THEN dr.spend ELSE 0 END),0)
        )/4.0)::float AS spend_prior_avg
      FROM daily_rollup dr
      JOIN amazon_profiles p USING (profile_id)
      WHERE dr.date >= CURRENT_DATE - 35
      GROUP BY p.country_code, p.currency_code, p.target_acos
      ORDER BY spend_this DESC
    `,

    // ── Chart data: 90 days per profile ──
    sql`
      SELECT
        p.profile_id::text,
        p.country_code,
        p.currency_code,
        p.target_acos::float,
        dr.date::text,
        dr.spend::float,
        dr.sales::float,
        dr.acos::float
      FROM daily_rollup dr
      JOIN amazon_profiles p USING (profile_id)
      WHERE dr.date >= CURRENT_DATE - 120
      ORDER BY p.profile_id, dr.date
    `,

    // ── CLUSTER campaigns this week vs last week (ES only — only market with data) ──
    sql`
      SELECT
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.impressions   END),0)::float AS imp_this,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.clicks        END),0)::float AS clk_this,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.cost          END),0)::float AS spend_this,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.purchases_14d END),0)::float AS ord_this,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.impressions   END),0)::float AS imp_last,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.clicks        END),0)::float AS clk_last,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.cost          END),0)::float AS spend_last,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.purchases_14d END),0)::float AS ord_last
      FROM amazon_campaign_daily d
      JOIN amazon_campaigns c ON c.campaign_id = d.campaign_id AND c.profile_id = d.profile_id
      WHERE c.name ILIKE '%CLUSTER%'
        AND d.date >= CURRENT_DATE - 14
    `,

    // ── Campaign movers: top 3 gainers + 3 decliners by sales delta, estate-wide ──
    sql`
      SELECT
        COALESCE(c.name, d.campaign_id::text)              AS name,
        p.country_code,
        p.currency_code,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.sales_14d ELSE 0 END),0)::float AS sales_this,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.sales_14d ELSE 0 END),0)::float AS sales_last,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.cost ELSE 0 END),0)::float AS spend_this,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.cost ELSE 0 END),0)::float AS spend_last
      FROM amazon_campaign_daily d
      JOIN amazon_profiles    p ON p.profile_id  = d.profile_id
      LEFT JOIN amazon_campaigns c ON c.campaign_id = d.campaign_id AND c.profile_id = d.profile_id
      WHERE d.date >= CURRENT_DATE - 14
        AND c.state IN ('ENABLED','PAUSED')
      GROUP BY COALESCE(c.name, d.campaign_id::text), p.country_code, p.currency_code
      HAVING COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.sales_14d ELSE 0 END),0) > 0
          OR COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.sales_14d ELSE 0 END),0) > 0
      ORDER BY (
        (COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.sales_14d ELSE 0 END),0) -
         COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.cost ELSE 0 END),0)) -
        (COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.sales_14d ELSE 0 END),0) -
         COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.cost ELSE 0 END),0))
      ) DESC
      LIMIT 50
    `,

    // ── Watchdog ──
    sql`SELECT verdict, checked_at::text FROM watchdog_status WHERE id = 1`,

    // ── Actions pushed this month ──
    sql`
      SELECT COUNT(*)::int AS n
      FROM recommendations
      WHERE status = 'PUSHED'
        AND pushed_at >= date_trunc('month', CURRENT_DATE)
    `,
  ])

  // ── Shape verdict rows ───────────────────────────────────────────────────
  const verdict: MarketVerdictRow[] = (verdictRows as {
    country_code: string; currency_code: string; target_acos: number;
    sales_this: number; spend_this: number; sales_prior_avg: number; spend_prior_avg: number
  }[]).map(r => ({
    country:       r.country_code,
    currency:      r.currency_code,
    targetAcos:    r.target_acos,
    salesThis:     r.sales_this,
    salesPriorAvg: r.sales_prior_avg,
    spendThis:     r.spend_this,
    spendPriorAvg: r.spend_prior_avg,
  }))

  // ── Shape chart data ─────────────────────────────────────────────────────
  const profileMap: Record<string, MarketChartData> = {}
  for (const r of chartRows as {
    profile_id: string; country_code: string; currency_code: string; target_acos: number;
    date: string; spend: number; sales: number; acos: number | null
  }[]) {
    if (!profileMap[r.country_code]) {
      profileMap[r.country_code] = {
        country:    r.country_code,
        currency:   r.currency_code,
        targetAcos: r.target_acos,
        points:     [],
      }
    }
    profileMap[r.country_code].points.push({
      date:  r.date,
      sales: r.sales,
      spend: r.spend,
      acos:  r.acos,
    } as ChartPoint)
  }
  const markets: MarketChartData[] = Object.values(profileMap)

  // ── Shape cluster stats ──────────────────────────────────────────────────
  const cr = (clusterRows as {
    imp_this: number; clk_this: number; spend_this: number; ord_this: number;
    imp_last: number; clk_last: number; spend_last: number; ord_last: number
  }[])[0] ?? null
  const cluster: ClusterStats | null = cr ? {
    impThis:   cr.imp_this,   clkThis:   cr.clk_this,
    spendThis: cr.spend_this, ordThis:   cr.ord_this,
    impLast:   cr.imp_last,   clkLast:   cr.clk_last,
    spendLast: cr.spend_last, ordLast:   cr.ord_last,
  } : null

  // ── Shape movers ─────────────────────────────────────────────────────────
  const allMovers: MoverRow[] = (moverRows as {
    name: string; country_code: string; currency_code: string;
    sales_this: number; sales_last: number; spend_this: number; spend_last: number
  }[]).map(r => ({
    name:      r.name,
    country:   r.country_code,
    currency:  r.currency_code,
    salesThis: r.sales_this,
    salesLast: r.sales_last,
    spendThis: r.spend_this,
    spendLast: r.spend_last,
    delta:     (r.sales_this - r.spend_this) - (r.sales_last - r.spend_last),
  }))
  const gainers   = allMovers.slice(0, 3)
  const decliners = [...allMovers].sort((a, b) => a.delta - b.delta).slice(0, 3)

  // ── Shape machine footer ─────────────────────────────────────────────────
  const wd = (watchdogRow as { verdict: string; checked_at: string }[])[0]
  const machine: MachineData = {
    actionsThisMonth: (actionsRow as { n: number }[])[0]?.n ?? 0,
    watchdogVerdict:  wd?.verdict  ?? '—',
    watchdogChecked:  wd?.checked_at ?? '',
  }

  return (
    <div>
      <h1 style={{ marginBottom: '1rem' }}>Dashboard</h1>

      {/* 1. VERDICT STRIP */}
      <VerdictStrip rows={verdict} />

      {/* 2 + 3. CHARTS (client wrapper for tab state) */}
      <h2 style={{ marginBottom: '0.6rem' }}>Trends · 90 days</h2>
      <ChartSection markets={markets} />

      {/* 4. WHAT MOVED */}
      <MoversRow cluster={cluster} gainers={gainers} decliners={decliners} />

      {/* 5. MACHINE FOOTER */}
      <MachineFooter data={machine} />
    </div>
  )
}
