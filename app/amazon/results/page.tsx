export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { neon } from '@neondatabase/serverless'
import { computeScorecard, type RawScorecardRow, type JudgedRow } from '@/app/lib/scorecard'
import { money, count, marketName } from '@/lib/amazon/yardstick'
import s from '../ui.module.css'

// One judgment per change: the 14-day window when it is graded, else 30, else 7.
const HORIZON_PRIORITY = ['t14', 't30', 't7']
const PERIODS = [['30', '30 days'], ['90', '90 days'], ['all', 'All time']] as const

const KIND: Record<string, string> = {
  NEGATE_TERM: 'Stop a search', NEGATE_TARGET: 'Stop a product target', PROMOTE_TERM: 'Add a keyword',
  PROMOTE_ASIN: 'Target a product', BUDGET_ADJUST: 'Change a budget', PAUSE_CAMPAIGN: 'Pause a campaign',
  REPLACE_PRODUCT_AD: 'Swap an edition', CREATE_STRUCTURE: 'New campaign', CREATIVE_KEYWORD: 'Targeting idea', CREATIVE_TARGET: 'Targeting idea',
}
const WHAT: Record<string, string> = {
  'Stop a search': 'Searches with clicks and no orders', 'Stop a product target': 'Product pages that cost money and sold nothing',
  'Lower a bid': 'Keywords costing more per order than the margin', 'Raise a bid': 'Paying keywords that could take more traffic',
  'Add a keyword': 'Search terms that already sell', 'Target a product': 'Product pages that already sell',
  'Change a budget': 'Paying campaigns that run out of budget', 'Pause a campaign': 'Campaigns with no orders for a long time',
  'Swap an edition': 'A better-selling edition in the same ad', 'New campaign': 'New structures for proven terms', 'Targeting idea': 'Hand-picked new targets',
}

function kindOf(r: JudgedRow): string {
  if (r.rec_type === 'BID_ADJUST') return r.judgment.direction === 'RAISE' ? 'Raise a bid' : 'Lower a bid'
  return KIND[r.rec_type] ?? 'Other'
}

export default async function ResultsPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const sp = await searchParams
  const period = PERIODS.some(([k]) => k === sp.period) ? (sp.period as string) : '90'
  const sql = neon(process.env.DATABASE_URL!)

  // Same inputs as the old Scorecard page; the grading itself is unchanged (app/lib/scorecard.ts).
  const [rawRows, acosRows, profileRows, pushedRows, nowRows] = (await Promise.all([
    sql`
      SELECT r.id::text, r.rec_type, r.target_text, r.campaign_id::text, r.evidence,
        p.country_code, p.currency_code, o.horizon, o.metrics, o.captured_at::text, r.pushed_at::text AS pushed_at
      FROM recommendations r
      JOIN rec_outcomes o ON o.rec_id = r.id
      JOIN amazon_profiles p ON p.profile_id = r.profile_id
      WHERE r.status = 'PUSHED'
      ORDER BY r.rec_type, o.horizon, p.country_code, r.id
    `,
    sql`
      SELECT p.country_code, (SUM(acd.cost) / NULLIF(SUM(acd.sales_14d), 0))::float AS rolling_acos
      FROM amazon_campaign_daily acd JOIN amazon_profiles p ON p.profile_id = acd.profile_id
      WHERE acd.date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY p.country_code
    `,
    sql`
      SELECT country_code, max(currency_code) AS currency_code, max(gp_per_order)::float AS gp_per_order, max(target_acos)::float AS target_acos
      FROM amazon_profiles WHERE is_active GROUP BY country_code
    `,
    sql`
      SELECT p.country_code, r.pushed_at::text AS pushed_at
      FROM recommendations r JOIN amazon_profiles p ON p.profile_id = r.profile_id
      WHERE r.status = 'PUSHED' AND r.pushed_at IS NOT NULL
    `,
    sql`SELECT now()::text AS now`,
  ])) as unknown as [RawScorecardRow[], { country_code: string; rolling_acos: number | null }[],
    { country_code: string; currency_code: string; gp_per_order: number | null; target_acos: number | null }[],
    { country_code: string; pushed_at: string }[], { now: string }[]]

  const rolling: Record<string, number> = {}
  for (const r of acosRows) if (r.rolling_acos != null) rolling[r.country_code] = Number(r.rolling_acos)
  const { judged } = computeScorecard(rawRows, rolling)

  // Pick one judgment per change.
  const best = new Map<string, JudgedRow>()
  for (const r of judged) {
    const id = String(r.id)
    const cur = best.get(id)
    const rank = (x: JudgedRow) => {
      const i = HORIZON_PRIORITY.indexOf(x.horizon)
      return (x.judgment.verdict === 'NO-DATA' ? 10 : 0) + (i < 0 ? 5 : i)
    }
    if (!cur || rank(r) < rank(cur)) best.set(id, r)
  }

  // The database clock, so rendering stays pure.
  const since = period === 'all' ? 0 : Date.parse(nowRows[0]?.now ?? '') - Number(period) * 86400000
  const inPeriod = (ts: string | null | undefined) => !!ts && (period === 'all' || Date.parse(ts) >= since)

  const order = ['ES', 'US', 'MX', 'UK', 'CA']
  const markets = [...new Set([...best.values()].map(r => r.country_code))]
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
  const market = typeof sp.market === 'string' && markets.includes(sp.market) ? sp.market : markets[0] ?? 'ES'
  const prof = profileRows.find(p => p.country_code === market)
  const cur = prof?.currency_code ?? 'EUR'

  const rows = [...best.values()].filter(r => r.country_code === market && inPeriod(r.pushed_at))
  const judgedRows = rows.filter(r => r.judgment.verdict !== 'NO-DATA')
  const sent = pushedRows.filter(r => r.country_code === market && inPeriod(r.pushed_at)).length
  const worked = judgedRows.filter(r => r.judgment.verdict === 'WIN').length
  const stopped = judgedRows.reduce((t, r) => t + (Number(r.judgment.euros_stopped) || 0), 0)
  const gpRows = judgedRows.filter(r => r.judgment.gp_delta != null && Number.isFinite(Number(r.judgment.gp_delta)))
  const effect = gpRows.reduce((t, r) => t + Number(r.judgment.gp_delta), 0)

  const kinds = [...new Set(rows.map(kindOf))].map(kind => {
    const k = rows.filter(r => kindOf(r) === kind)
    const j = k.filter(r => r.judgment.verdict !== 'NO-DATA')
    const c = (v: string) => j.filter(r => r.judgment.verdict === v).length
    const gp = j.filter(r => r.judgment.gp_delta != null).reduce((t, r) => t + Number(r.judgment.gp_delta), 0)
    const anyGp = j.some(r => r.judgment.gp_delta != null)
    return { kind, n: k.length, judged: j.length, win: c('WIN'), partial: c('PARTIAL') + c('REVIEW'), leak: c('LEAK'), gp: anyGp ? gp : null }
  }).sort((a, b) => b.judged - a.judged)

  const href = (p: string, m: string) => `/amazon/results?period=${p}&market=${m}`
  const pctOf = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—')

  return (
    <main className={s.main}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div className={s.eyebrow}>Amazon ads · {marketName(market)}</div>
          <h1 className={s.h1}>Is the engine helping?</h1>
          <div className={s.lede}>Every change we sent, graded after it had time to work · {PERIODS.find(([k]) => k === period)?.[1].toLowerCase()}</div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
          {markets.length > 1 ? (
            <div role="group" aria-label="Market" className={s.toggle}>
              {markets.map(m => <Link key={m} href={href(period, m)} className={m === market ? s.toggleOn : s.toggleBtn} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>{marketName(m)}</Link>)}
            </div>
          ) : null}
          <div role="group" aria-label="Period" className={s.toggle}>
            {PERIODS.map(([k, label]) => <Link key={k} href={href(k, market)} className={k === period ? s.toggleOn : s.toggleBtn} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>{label}</Link>)}
          </div>
        </div>
      </div>

      <div className={s.cards}>
        <div className={s.card}><div className={s.label}>Changes sent</div><div className={`${s.big} ${s.tn}`}>{count(sent)}</div><div className={s.note}>graded so far: {count(judgedRows.length)}</div></div>
        <div className={s.card}><div className={s.label}>Worked</div><div className={`${s.big} ${s.tn}`}>{pctOf(worked, judgedRows.length)}</div><div className={s.note}>{count(worked)} of {count(judgedRows.length)} graded</div></div>
        <div className={s.card}><div className={s.label}>Spend stopped</div><div className={`${s.big} ${s.tn}`}>{money(stopped, cur)}</div><div className={s.note}>on searches and targets with no orders</div></div>
        <div className={s.card}><div className={s.label}>Profit effect</div><div className={`${s.big} ${s.tn} ${effect < 0 ? s.neg : ''}`}>{gpRows.length ? money(effect, cur, { sign: true }) : '—'}</div><div className={s.note}>{gpRows.length ? `summed over ${count(gpRows.length)} graded changes, against the window before` : 'no profit grades yet'}</div></div>
      </div>

      <section className={s.card}>
        <h2 className={s.h2} style={{ marginBottom: 4 }}>By kind of change</h2>
        <div className={s.note} style={{ marginBottom: 14 }}>Worked: profit after ads went up, or the spend stopped without losing orders · fewer than 10 graded is too few to say</div>
        {kinds.length === 0 ? <div className={s.note}>Nothing graded in this period.</div> : null}
        {kinds.map(k => {
          const t = k.win + k.partial + k.leak
          const w = (n: number) => `${t > 0 ? ((n / t) * 100).toFixed(1) : 0}%`
          return (
            <div key={k.kind} style={{ display: 'flex', flexWrap: 'wrap', gap: '10px 24px', alignItems: 'center', padding: '14px 0', borderTop: '1px solid #E3F1F8' }}>
              <div style={{ flex: '1 1 260px', minWidth: 0 }}>
                <div style={{ fontWeight: 800, fontSize: 16 }}>{k.kind}</div>
                <div className={s.note}>{WHAT[k.kind] ?? ''}</div>
              </div>
              <div style={{ flex: '2 1 340px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', height: 14, borderRadius: 999, overflow: 'hidden', background: '#EEF3F6' }} aria-hidden="true">
                  <div style={{ width: w(k.win), background: '#0093D0' }} />
                  <div style={{ width: w(k.partial), background: '#F5B32B' }} />
                  <div style={{ width: w(k.leak), background: '#E8743B' }} />
                </div>
                <div className={`${s.note} ${s.tn}`} style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 16px' }}>
                  <span><b style={{ color: '#1F6B3A' }}>{k.win}</b> worked</span>
                  <span><b style={{ color: '#7A4F00' }}>{k.partial}</b> no clear change</span>
                  <span><b style={{ color: '#9A3412' }}>{k.leak}</b> made it worse</span>
                </div>
              </div>
              <div className={s.tn} style={{ flex: '0 0 170px', textAlign: 'right' }}>
                <div style={{ fontWeight: 800, fontSize: 18 }}>{k.judged >= 10 ? pctOf(k.win, k.judged) : 'Too few'}</div>
                <div className={s.note} style={{ fontSize: 12 }}>
                  {count(k.judged)} graded{k.n > k.judged ? ` · ${count(k.n - k.judged)} waiting` : ''}{k.gp != null ? ` · ${money(k.gp, cur, { sign: true })}` : ''}
                </div>
              </div>
            </div>
          )
        })}
      </section>

      <section className={s.card} style={{ paddingTop: 8, paddingBottom: 8 }}>
        <details>
          <summary style={{ cursor: 'pointer', padding: '16px 0', fontFamily: 'var(--ads-display), Fraunces, Georgia, serif', fontWeight: 600, fontSize: 21, minHeight: 44 }}>How the engine decides</summary>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16, padding: '4px 0 20px', fontSize: 14, color: '#33434D' }}>
            <div><div style={{ fontWeight: 800, color: '#1E2A32' }}>One yardstick</div>
              {profileRows.map(p => `${marketName(p.country_code)}: ${p.gp_per_order != null ? `margin ${money(p.gp_per_order, p.currency_code, { decimals: 2 })} per order` : p.target_acos != null ? `ACoS target ${Math.round(p.target_acos * 100)}%` : 'no target'}`).join(' · ')}.</div>
            <div><div style={{ fontWeight: 800, color: '#1E2A32' }}>Enough evidence first</div>Nothing is proposed below a minimum of clicks and orders. A bid is not changed again for 14 days after a change.</div>
            <div><div style={{ fontWeight: 800, color: '#1E2A32' }}>You approve</div>The engine drafts; nothing reaches Amazon until you approve and send it. Sponsored Products only; Brands and Display are changed by hand.</div>
            <div><div style={{ fontWeight: 800, color: '#1E2A32' }}>Tests are left alone</div>A campaign under test is not touched until its verdict date. <Link href="/amazon/engine">Full rulebook →</Link></div>
          </div>
        </details>
      </section>

      <div className={s.foot}>Grades come from the existing scorecard rules, unchanged. Each change is graded once, on its 14-day window where available. Amounts are in {cur} and never added across markets.</div>
    </main>
  )
}
