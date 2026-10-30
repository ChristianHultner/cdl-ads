export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { neon } from '@neondatabase/serverless'
import { CAMPAIGN_METRICS_CTE, CAMPAIGN_LABEL_SQL } from '@/lib/amazon/campaign-display'
import {
  judge, money, pct, count, marketName, adTypeName, monthLabel, dayLabel, currencySymbol,
  type Judgement, type Tone,
} from '@/lib/amazon/yardstick'
import OverviewDetail, { type MarketDetail } from './OverviewDetail'
import s from './ui.module.css'

type MarketRow = {
  country_code: string; currency_code: string; gp_per_order: number | null; target_acos: number | null
  spend: number; sales: number; orders: number; enabled: number; live_total: number
}
type DraftRow = { country_code: string; n: number; drafted_at: string | null }
type ExperimentRow = { name: string; market: string | null; verdict_at: string | null }
type TopRow = {
  country_code: string; profile_id: string; campaign_id: string; name: string; type_label: string
  state: string; spend: number; sales: number; orders: number
}
type ConsoleRow = { market: string; year: number; month: number; spend: number; sales: number; orders: number }
type VendorRow = { market: string; currency: string; year: number; month: number; units: number; net_revenue: number }

const TONE: Record<Tone, string> = { pay: s.pay, even: s.even, lose: s.lose, off: s.off }
const FILL: Record<Tone, string> = { pay: '#0093D0', even: '#F5B32B', lose: '#E8743B', off: '#C5D3DB' }

export default async function OverviewPage() {
  const sql = neon(process.env.DATABASE_URL!)

  const [marketRows, draftRows, statusRows, experimentRows, topRows, consoleRows, vendorRows] = (await Promise.all([
    // 30-day totals per market, all ad types, from the same metrics the Campaigns page uses.
    sql.query(CAMPAIGN_METRICS_CTE + `
      SELECT ap.country_code, ap.currency_code,
        max(ap.gp_per_order)::float AS gp_per_order, max(ap.target_acos)::float AS target_acos,
        coalesce(sum(m.spend),0)::float AS spend, coalesce(sum(m.sales),0)::float AS sales,
        coalesce(sum(m.orders),0)::float AS orders,
        (SELECT count(*)::int FROM amazon_campaigns c JOIN amazon_profiles p2 ON p2.profile_id = c.profile_id
          WHERE p2.country_code = ap.country_code AND p2.is_active AND c.state = 'ENABLED') AS enabled,
        (SELECT count(*)::int FROM amazon_campaigns c JOIN amazon_profiles p2 ON p2.profile_id = c.profile_id
          WHERE p2.country_code = ap.country_code AND p2.is_active AND c.state IN ('ENABLED','PAUSED')) AS live_total
      FROM amazon_profiles ap LEFT JOIN campaign_metrics m ON m.profile_id = ap.profile_id
      WHERE ap.is_active
      GROUP BY ap.country_code, ap.currency_code
      ORDER BY coalesce(array_position(ARRAY['ES','US','MX','UK','CA'], ap.country_code), 99), ap.country_code
    `),
    sql`
      SELECT p.country_code, count(*)::int AS n, max(r.created_at)::text AS drafted_at
      FROM recommendations r JOIN amazon_profiles p ON p.profile_id = r.profile_id
      WHERE r.status = 'DRAFT'
      GROUP BY p.country_code
      ORDER BY count(*) DESC
    `,
    sql`
      SELECT
        (SELECT count(*)::int FROM recommendations WHERE status = 'APPROVED') AS approved,
        (SELECT count(*)::int FROM recommendations WHERE rec_type = 'SEASONAL_BUDGET_RULE' AND status = 'PUSHED') AS seasonal,
        (SELECT max(date)::text FROM amazon_campaign_daily) AS data_to
    `,
    sql`
      SELECT name, market, (started_at + make_interval(days => horizon_days))::date::text AS verdict_at
      FROM experiments
      WHERE status = 'LIVE' AND started_at IS NOT NULL
      ORDER BY started_at + make_interval(days => horizon_days)
      LIMIT 3
    `,
    sql.query(CAMPAIGN_METRICS_CTE + `
      SELECT ap.country_code, c.profile_id::text, c.campaign_id::text, c.name, ${CAMPAIGN_LABEL_SQL} AS type_label,
        c.state, m.spend::float, coalesce(m.sales,0)::float AS sales, coalesce(m.orders,0)::float AS orders
      FROM campaign_metrics m
      JOIN amazon_campaigns c ON c.profile_id = m.profile_id AND c.campaign_id = m.campaign_id AND c.campaign_type = m.campaign_type
      JOIN amazon_profiles ap ON ap.profile_id = m.profile_id
      WHERE ap.is_active AND m.spend > 0
      ORDER BY m.spend DESC
    `),
    // Monthly truth layers are read standalone and never joined (doctrine).
    sql`SELECT market, year, month, spend::float, sales::float, orders::float FROM console_history ORDER BY market, year, month`,
    sql`SELECT market, currency, year, month, units::float, net_revenue::float FROM vendor_history ORDER BY market, year, month`,
  ])) as unknown as [MarketRow[], DraftRow[], { approved: number; seasonal: number; data_to: string | null }[], ExperimentRow[], TopRow[], ConsoleRow[], VendorRow[]]

  const status = statusRows[0] ?? { approved: 0, seasonal: 0, data_to: null }
  const markets = marketRows.filter(m => m.spend > 0 || m.live_total > 0)

  // ── Needs you ──
  const drafts = draftRows.reduce((t, r) => t + r.n, 0)
  const draftedAt = draftRows.map(r => r.drafted_at).filter(Boolean).sort().pop() ?? null
  const draftSplit = draftRows.map(r => `${marketName(r.country_code)} ${r.n}`).join(' · ')

  // ── Per-market detail for the charts and the campaign table ──
  const details: MarketDetail[] = markets.map(m => buildDetail(m, consoleRows, vendorRows, topRows))
    .filter(d => d.months.length > 0 || d.rolling.labels.length > 0 || d.top.length > 0)

  const period = status.data_to ? `Last 30 days to ${dayLabel(status.data_to)}` : 'Last 30 days'

  return (
    <main className={s.main}>
      <div>
        <div className={s.eyebrow}>Amazon ads</div>
        <h1 className={s.h1}>Last 30 days</h1>
        <div className={s.lede}>{period} · all ad types · each market judged on cost per order against its margin per order</div>
      </div>

      <section aria-label="Needs you" className={s.needs}>
        <div className={s.needsLabel}>Needs you</div>
        <div className={s.needsGrid}>
          <Link href="/amazon/decisions" className={drafts > 0 ? s.needsTileGold : s.needsTile}>
            <span className={s.needsTitle}>{drafts > 0 ? `${count(drafts)} change${drafts === 1 ? '' : 's'} to approve` : 'Nothing to approve'}</span>
            <span className={s.needsSub}>{drafts > 0 ? `${draftSplit}${draftedAt ? ` · latest drafted ${dayLabel(draftedAt)}` : ''}` : 'The engine drafts new changes each morning'}</span>
          </Link>
          {status.approved > 0 ? (
            <Link href="/amazon/decisions" className={s.needsTile}>
              <span className={s.needsTitle}>{count(status.approved)} approved, not yet sent</span>
              <span className={s.needsSub}>They go to Amazon with the next send</span>
            </Link>
          ) : null}
          {experimentRows.map(e => (
            <Link key={e.name} href="/amazon/campaigns" className={s.needsTile}>
              <span className={s.needsTitle}>Test verdict {e.verdict_at ? dayLabel(e.verdict_at) : 'pending'}</span>
              <span className={s.needsSub}>{e.name}{e.market ? ` · ${marketName(e.market)}` : ''} · the engine leaves it alone until then</span>
            </Link>
          ))}
          {status.seasonal > 0 ? (
            <Link href="/amazon/decisions" className={s.needsTile}>
              <span className={s.needsTitle}>December budgets booked</span>
              <span className={s.needsSub}>{`${count(status.seasonal)} budget rule${status.seasonal === 1 ? '' : 's'} on Amazon · they revert on their own`}</span>
            </Link>
          ) : null}
        </div>
      </section>

      {markets.length === 0 ? (
        <section className={s.card}>No active market has campaigns yet.</section>
      ) : (
        <div className={s.cards}>
          {markets.map(m => <MarketCard key={m.country_code} m={m} />)}
        </div>
      )}

      {details.length > 0 ? <OverviewDetail markets={details} /> : null}

      <div className={s.foot}>
        Profit after ads = orders credited to ads × margin per order − ad spend. Monthly figures come from the ads history (to the last complete month); Amazon’s purchases from us come from vendor invoices (Spain) and Ingram (US).
      </div>
    </main>
  )
}

function MarketCard({ m }: { m: MarketRow }) {
  const j = judge({ spend: m.spend, sales: m.sales, orders: m.orders, gpPerOrder: m.gp_per_order, targetAcos: m.target_acos })
  const cur = m.currency_code
  const allPaused = m.enabled === 0
  const tone: Tone = allPaused && m.spend <= 0 ? 'off' : j.tone
  const verdict = allPaused && m.spend <= 0 ? 'Paused' : j.label

  const unit = j.basis === 'unit'
  const bigLabel = unit ? 'Profit after ads' : 'Ad spend per sale (ACoS)'
  const big = unit
    ? (m.spend > 0 && j.profitAfterAds != null ? money(j.profitAfterAds, cur, { sign: true }) : '—')
    : (j.acos != null ? pct(j.acos) : '—')
  const second = j.costPerOrder != null ? money(j.costPerOrder, cur, { decimals: 2 }) : '—'
  const secondNote = unit
    ? `against ${money(m.gp_per_order ?? 0, cur, { decimals: 2 })} margin`
    : 'no margin set yet'

  const fill = j.ratio != null ? Math.min(100, (j.ratio / 2) * 100) : 0
  let gap = 'no spend'
  if (j.ratio != null && unit && j.costPerOrder != null && m.gp_per_order != null) {
    const d = j.costPerOrder - m.gp_per_order
    gap = `${money(Math.abs(d), cur, { decimals: 2 })} ${d <= 0 ? 'under' : 'over'} the margin (the line)`
  } else if (j.ratio != null && !unit && j.acos != null && m.target_acos != null) {
    const d = (j.acos - m.target_acos) * 100
    gap = `${Math.abs(d).toLocaleString('de-DE', { maximumFractionDigits: 1 })} points ${d <= 0 ? 'under' : 'over'} the ${pct(m.target_acos, 0)} target (the line)`
  } else if (m.spend > 0) {
    gap = j.label
  }

  const foot = allPaused && m.spend <= 0
    ? `All ${count(m.live_total)} campaigns paused`
    : `${money(m.spend, cur)} spend · ${count(m.orders)} order${Math.round(m.orders) === 1 ? '' : 's'}`

  return (
    <Link href="/amazon/campaigns" className={s.marketCard}>
      <div className={s.marketHead}>
        <span className={s.marketName}>{marketName(m.country_code)} · {currencySymbol(cur)}</span>
        <span className={`${s.chip} ${TONE[tone]}`}>{verdict}</span>
      </div>
      <div>
        <div className={s.label}>{bigLabel}</div>
        <div className={`${s.big} ${s.tn} ${tone === 'lose' ? s.neg : ''}`}>{big}</div>
      </div>
      <div>
        <div className={s.label}>Cost per order</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '4px 8px' }}>
          <span className={`${s.second} ${s.tn}`}>{second}</span>
          <span className={`${s.note} ${s.tn}`}>{secondNote}</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className={s.gauge} aria-hidden="true">
          <div className={s.gaugeFill} style={{ width: `${fill.toFixed(1)}%`, background: FILL[tone] }} />
          <div className={s.gaugeMark} />
        </div>
        <div className={`${s.note} ${s.tn}`}>{gap}</div>
      </div>
      <div className={`${s.cardFoot} ${s.tn}`}>{foot}</div>
    </Link>
  )
}

// ── Shaping ────────────────────────────────────────────────────────────────

function consecutive(rows: { year: number; month: number }[], end: number): boolean {
  for (let k = end - 11; k < end; k++) {
    if (rows[k + 1].year * 12 + rows[k + 1].month !== rows[k].year * 12 + rows[k].month + 1) return false
  }
  return true
}

function buildDetail(m: MarketRow, consoleRows: ConsoleRow[], vendorRows: VendorRow[], topRows: TopRow[]): MarketDetail {
  const cur = m.currency_code
  const gp = m.gp_per_order
  const unit = gp != null && gp > 0
  const profitOf = (orders: number, sales: number, spend: number) => (unit ? orders * (gp as number) - spend : sales - spend)

  const cons = consoleRows.filter(r => r.market === m.country_code)
  const vend = vendorRows.filter(r => r.market === m.country_code)

  // Month by month: the last 12 months in the ads history.
  const months = cons.slice(-12).map(r => ({ label: monthLabel(r.year, r.month), value: profitOf(r.orders, r.sales, r.spend) }))

  // Rolling 12: a point exists only where all 12 months are consecutive.
  const roll: Record<string, { purchases?: number; sales?: number; spend?: number; profit?: number }> = {}
  for (let i = 11; i < cons.length; i++) {
    if (!consecutive(cons, i)) continue
    const w = cons.slice(i - 11, i + 1)
    const sp = w.reduce((t, r) => t + r.spend, 0)
    const sa = w.reduce((t, r) => t + r.sales, 0)
    const or = w.reduce((t, r) => t + r.orders, 0)
    const key = `${cons[i].year}-${String(cons[i].month).padStart(2, '0')}`
    roll[key] = { ...(roll[key] ?? {}), sales: sa, spend: sp, profit: profitOf(or, sa, sp) }
  }
  for (let i = 11; i < vend.length; i++) {
    if (!consecutive(vend, i)) continue
    const key = `${vend[i].year}-${String(vend[i].month).padStart(2, '0')}`
    roll[key] = { ...(roll[key] ?? {}), purchases: vend.slice(i - 11, i + 1).reduce((t, r) => t + r.net_revenue, 0) }
  }
  const keys = Object.keys(roll).sort().slice(-12)
  const rolling = {
    labels: keys.map(k => monthLabel(Number(k.slice(0, 4)), Number(k.slice(5, 7)))),
    purchases: keys.map(k => roll[k].purchases ?? null),
    sales: keys.map(k => roll[k].sales ?? null),
    spend: keys.map(k => roll[k].spend ?? null),
    profit: keys.map(k => roll[k].profit ?? null),
  }

  // What ads can't see: the latest month present in both layers.
  let gap: MarketDetail['gap'] = null
  for (let i = vend.length - 1; i >= 0 && !gap; i--) {
    const c = cons.find(r => r.year === vend[i].year && r.month === vend[i].month)
    if (c && vend[i].units > 0) gap = { label: monthLabel(vend[i].year, vend[i].month), units: vend[i].units, orders: c.orders }
  }

  const top = topRows.filter(r => r.country_code === m.country_code).slice(0, 8).map(r => {
    const j: Judgement = judge({ spend: r.spend, sales: r.sales, orders: r.orders, gpPerOrder: gp, targetAcos: m.target_acos })
    return {
      href: `/amazon/campaigns/${r.profile_id}/${r.campaign_id}`,
      name: r.name,
      type: adTypeName(r.type_label) + (r.state === 'PAUSED' ? ' · paused' : ''),
      spend: money(r.spend, cur),
      orders: count(r.orders),
      cpo: j.costPerOrder != null ? money(j.costPerOrder, cur, { decimals: 2 }) : '—',
      verdict: j.label,
      tone: j.tone,
    }
  })

  return {
    country: m.country_code,
    name: marketName(m.country_code),
    currency: cur,
    unit,
    judgeHead: unit ? `Against ${money(gp as number, cur, { decimals: 2 })}` : (m.target_acos != null ? `Against ${pct(m.target_acos, 0)} ACoS` : 'Verdict'),
    months,
    rolling,
    gap,
    top,
  }
}
