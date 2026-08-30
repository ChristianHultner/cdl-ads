export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { profileGP } from '../../lib/scorecard'
import VerdictStrip,  { type MarketVerdictRow }  from './components/VerdictStrip'
import ChartSection,  { type MarketChartData }   from './components/ChartSection'
import MoversRow,     { type MoverRow, type ClusterStats } from './components/MoversRow'
import MachineFooter, { type MachineData }       from './components/MachineFooter'
import LongTermSection, {
  type LongTermMarket,
  type LongTermPoint,
  type VendorLongTermMarket,
  type VendorLongTermPoint,
} from './components/LongTermSection'
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
    longTermRows,
    vendorRows,
  ] = await Promise.all([

    // ── Verdict strip: this week + 4-week prior-avg, per profile/currency ──
    // L3.2: gp_per_order + orders fetched for basis-resolved GP display.
    sql`
      SELECT
        p.country_code,
        p.currency_code,
        p.target_acos::float,
        p.gp_per_order::float,
        COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-7  AND dr.date < CURRENT_DATE THEN dr.sales  ELSE 0 END),0)::float AS sales_this,
        COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-7  AND dr.date < CURRENT_DATE THEN dr.spend  ELSE 0 END),0)::float AS spend_this,
        COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-7  AND dr.date < CURRENT_DATE THEN dr.orders ELSE 0 END),0)::float AS orders_this,
        ((COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-14 AND dr.date < CURRENT_DATE-7  THEN dr.sales ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-21 AND dr.date < CURRENT_DATE-14 THEN dr.sales ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-28 AND dr.date < CURRENT_DATE-21 THEN dr.sales ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-35 AND dr.date < CURRENT_DATE-28 THEN dr.sales ELSE 0 END),0)
        )/4.0)::float AS sales_prior_avg,
        ((COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-14 AND dr.date < CURRENT_DATE-7  THEN dr.spend ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-21 AND dr.date < CURRENT_DATE-14 THEN dr.spend ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-28 AND dr.date < CURRENT_DATE-21 THEN dr.spend ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-35 AND dr.date < CURRENT_DATE-28 THEN dr.spend ELSE 0 END),0)
        )/4.0)::float AS spend_prior_avg,
        ((COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-14 AND dr.date < CURRENT_DATE-7  THEN dr.orders ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-21 AND dr.date < CURRENT_DATE-14 THEN dr.orders ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-28 AND dr.date < CURRENT_DATE-21 THEN dr.orders ELSE 0 END),0)+
          COALESCE(SUM(CASE WHEN dr.date >= CURRENT_DATE-35 AND dr.date < CURRENT_DATE-28 THEN dr.orders ELSE 0 END),0)
        )/4.0)::float AS orders_prior_avg
      FROM daily_rollup dr
      JOIN amazon_profiles p USING (profile_id)
      WHERE dr.date >= CURRENT_DATE - 35
      GROUP BY p.country_code, p.currency_code, p.target_acos, p.gp_per_order
      ORDER BY spend_this DESC
    `,

    // ── Chart data: 90 days per profile ──
    // L3.3: gp_per_order + orders fetched for basis-resolved GP line.
    sql`
      SELECT
        p.profile_id::text,
        p.country_code,
        p.currency_code,
        p.target_acos::float,
        p.gp_per_order::float,
        dr.date::text,
        dr.spend::float,
        dr.sales::float,
        dr.orders::float,
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

    // ── Campaign movers: top 3 gainers + 3 decliners by GP delta, estate-wide ──
    // L3.2: gp_per_order + purchases fetched; delta computed on correct basis in shaping.
    sql`
      SELECT
        COALESCE(c.name, d.campaign_id::text)              AS name,
        p.country_code,
        p.currency_code,
        p.gp_per_order::float,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.sales_14d     ELSE 0 END),0)::float AS sales_this,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.sales_14d   ELSE 0 END),0)::float AS sales_last,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.cost          ELSE 0 END),0)::float AS spend_this,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.cost        ELSE 0 END),0)::float AS spend_last,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-7  AND d.date < CURRENT_DATE THEN d.purchases_14d ELSE 0 END),0)::float AS purchases_this,
        COALESCE(SUM(CASE WHEN d.date >= CURRENT_DATE-14 AND d.date < CURRENT_DATE-7 THEN d.purchases_14d ELSE 0 END),0)::float AS purchases_last
      FROM amazon_campaign_daily d
      JOIN amazon_profiles    p ON p.profile_id  = d.profile_id
      LEFT JOIN amazon_campaigns c ON c.campaign_id = d.campaign_id AND c.profile_id = d.profile_id
      WHERE d.date >= CURRENT_DATE - 14
        AND c.state IN ('ENABLED','PAUSED')
      GROUP BY COALESCE(c.name, d.campaign_id::text), p.country_code, p.currency_code, p.gp_per_order
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

    // ── Long-term: console_history + gp_per_order from amazon_profiles ──
    // display-only truth layer — never joined to daily_rollup.
    // Rolling-12 computation and window validation done in TypeScript shaping below.
    sql`
      SELECT
        ch.market,
        ch.year,
        ch.month,
        ch.spend::float,
        ch.sales::float,
        ch.orders::float,
        (SELECT MAX(p2.gp_per_order)::float
           FROM amazon_profiles p2
          WHERE p2.country_code = ch.market) AS gp_per_order,
        (SELECT MAX(p2.currency_code)
           FROM amazon_profiles p2
          WHERE p2.country_code = ch.market) AS currency_code
      FROM console_history ch
      ORDER BY ch.market, ch.year, ch.month
    `,

    // ── Long-term: vendor_history, read in its own standalone query ──
    // Never joined to console_history or any other table. The series meet only
    // when the separately shaped props reach LongTermSection.
    sql`
      SELECT
        market,
        currency,
        year,
        month,
        units::float,
        net_revenue::float
      FROM vendor_history
      ORDER BY market, year, month
    `,
  ])

  // ── Shape verdict rows ───────────────────────────────────────────────────
  const verdict: MarketVerdictRow[] = (verdictRows as {
    country_code: string; currency_code: string; target_acos: number; gp_per_order: number | null;
    sales_this: number; spend_this: number; orders_this: number;
    sales_prior_avg: number; spend_prior_avg: number; orders_prior_avg: number;
  }[]).map(r => ({
    country:        r.country_code,
    currency:       r.currency_code,
    targetAcos:     r.target_acos,
    gpPerOrder:     r.gp_per_order ?? null,
    salesThis:      r.sales_this,
    salesPriorAvg:  r.sales_prior_avg,
    spendThis:      r.spend_this,
    spendPriorAvg:  r.spend_prior_avg,
    ordersThis:     r.orders_this,
    ordersPriorAvg: r.orders_prior_avg,
  }))

  // ── Shape chart data ─────────────────────────────────────────────────────
  const profileMap: Record<string, MarketChartData> = {}
  for (const r of chartRows as {
    profile_id: string; country_code: string; currency_code: string; target_acos: number;
    gp_per_order: number | null; date: string; spend: number; sales: number; orders: number; acos: number | null
  }[]) {
    if (!profileMap[r.country_code]) {
      profileMap[r.country_code] = {
        country:    r.country_code,
        currency:   r.currency_code,
        targetAcos: r.target_acos,
        gpPerOrder: r.gp_per_order ?? null,
        points:     [],
      }
    }
    profileMap[r.country_code].points.push({
      date:   r.date,
      sales:  r.sales,
      spend:  r.spend,
      orders: r.orders,
      acos:   r.acos,
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
  // L3.2: delta uses profileGP for correct basis; revenue sort order preserved.
  const allMovers: MoverRow[] = (moverRows as {
    name: string; country_code: string; currency_code: string; gp_per_order: number | null;
    sales_this: number; sales_last: number; spend_this: number; spend_last: number;
    purchases_this: number; purchases_last: number;
  }[]).map(r => ({
    name:       r.name,
    country:    r.country_code,
    currency:   r.currency_code,
    gpPerOrder: r.gp_per_order ?? null,
    salesThis:  r.sales_this,
    salesLast:  r.sales_last,
    spendThis:  r.spend_this,
    spendLast:  r.spend_last,
    ordersThis: r.purchases_this,
    ordersLast: r.purchases_last,
    delta:      profileGP(r.gp_per_order ?? null, r.purchases_this, r.sales_this, r.spend_this)
              - profileGP(r.gp_per_order ?? null, r.purchases_last, r.sales_last, r.spend_last),
  }))
  const gainers   = allMovers.slice(0, 3)
  const decliners = [...allMovers].sort((a, b) => a.delta - b.delta).slice(0, 3)

  // ── Shape long-term rolling-12 data ──────────────────────────────────────
  // console_history is never joined to daily_rollup; read standalone here.
  type LtRaw = {
    market: string; year: number; month: number;
    spend: number; sales: number; orders: number;
    gp_per_order: number | null; currency_code: string
  }
  const ltByMarket: Record<string, LtRaw[]> = {}
  for (const r of longTermRows as LtRaw[]) {
    (ltByMarket[r.market] ??= []).push(r)
  }

  const ltMarkets: LongTermMarket[] = []
  for (const [country, rows] of Object.entries(ltByMarket)) {
    const gpPerOrder = rows[0]?.gp_per_order ?? null
    const currency   = rows[0]?.currency_code ?? ''
    const pts: LongTermPoint[] = []

    for (let i = 11; i < rows.length; i++) {
      // A rolling-12 point is only valid when all 12 months are consecutive.
      let consecutive = true
      for (let k = i - 11; k < i; k++) {
        const ym0 = rows[k].year * 12 + rows[k].month
        const ym1 = rows[k + 1].year * 12 + rows[k + 1].month
        if (ym1 !== ym0 + 1) { consecutive = false; break }
      }
      if (!consecutive) continue

      const win = rows.slice(i - 11, i + 1)
      pts.push({
        label:   `${rows[i].year}-${String(rows[i].month).padStart(2, '0')}`,
        spend12:  win.reduce((s, r) => s + r.spend,  0),
        sales12:  win.reduce((s, r) => s + r.sales,  0),
        orders12: win.reduce((s, r) => s + r.orders, 0),
      })
    }

    if (pts.length === 0) continue  // < 12 consecutive months (e.g. CA) — silently omit
    ltMarkets.push({ country, currency, gpPerOrder, points: pts })
  }

  // vendor_history stays a separate display-only truth layer. Its rolling-12
  // windows are shaped independently and meet console data only via component props.
  type VendorRaw = {
    market: string; currency: string; year: number; month: number;
    units: number; net_revenue: number
  }
  const vendorByMarket: Record<string, VendorRaw[]> = {}
  for (const r of vendorRows as VendorRaw[]) {
    (vendorByMarket[r.market] ??= []).push(r)
  }

  const vendorMarkets: VendorLongTermMarket[] = []
  for (const [country, rows] of Object.entries(vendorByMarket)) {
    const points: VendorLongTermPoint[] = []

    for (let i = 11; i < rows.length; i++) {
      let consecutive = true
      for (let k = i - 11; k < i; k++) {
        const ym0 = rows[k].year * 12 + rows[k].month
        const ym1 = rows[k + 1].year * 12 + rows[k + 1].month
        if (ym1 !== ym0 + 1) { consecutive = false; break }
      }
      if (!consecutive) continue

      const win = rows.slice(i - 11, i + 1)
      points.push({
        label:     `${rows[i].year}-${String(rows[i].month).padStart(2, '0')}`,
        revenue12: win.reduce((sum, row) => sum + row.net_revenue, 0),
        units12:   win.reduce((sum, row) => sum + row.units, 0),
      })
    }

    if (points.length === 0) continue
    vendorMarkets.push({ country, currency: rows[0]?.currency ?? '', points })
  }

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

      {/* LONG-TERM · ROLLING-12 — clearly separate from 90-day trends */}
      <h2 style={{ marginTop: '2rem', marginBottom: '0.6rem' }}>Long-term · 12-month rolling</h2>
      <LongTermSection markets={ltMarkets} vendorMarkets={vendorMarkets} />

      {/* 4. WHAT MOVED */}
      <MoversRow cluster={cluster} gainers={gainers} decliners={decliners} />

      {/* 5. MACHINE FOOTER */}
      <MachineFooter data={machine} />
    </div>
  )
}
