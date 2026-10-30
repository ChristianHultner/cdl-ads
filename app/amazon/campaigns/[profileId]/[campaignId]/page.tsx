export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { notFound } from 'next/navigation'
import { neon } from '@neondatabase/serverless'
import { CAMPAIGN_METRICS_CTE, CAMPAIGN_LABEL_SQL } from '@/lib/amazon/campaign-display'
import { judge, money, pct, count, marketName, adTypeName, dayLabel, type Tone } from '@/lib/amazon/yardstick'
import { describe, type DecisionEvidence } from '@/lib/amazon/decisions'
import CampaignDetail, { type DetailTab, type Week } from './CampaignDetail'
import s from '../../../ui.module.css'

type Head = {
  name: string; state: string; campaign_type: string; type_label: string; budget_amount: number | null; budget_type: string | null
  country_code: string; currency_code: string; gp_per_order: number | null; target_acos: number | null
  spend: number; sales: number; orders: number; targeting: string | null
}
type WeekRow = { wk: string; spend: number; sales: number; orders: number }
type KwRow = { id: string; text: string; match_type: string; state: string; bid: number | null; clicks: number; spend: number; orders: number; sales: number; has_perf: boolean }
type TgRow = { id: string; expression_type: string | null; sub: string | null; val: string | null; resolved_asin: string | null; state: string; bid: number | null; clicks: number; spend: number; orders: number; sales: number; has_perf: boolean }
type StRow = { search_term: string; clicks: number; spend: number; orders: number; sales: number; is_kw: boolean }
type BookRow = { ad_id: string; asin: string | null; state: string; title: string | null; clicks: number; spend: number; orders: number; sales: number }
type PushedRow = { id: number; rec_type: string; target_text: string; proposal: string; pushed_at: string; evidence: DecisionEvidence | null }

const TARGET_NAME: Record<string, string> = {
  QUERY_HIGH_REL_MATCHES: 'Close match', QUERY_BROAD_REL_MATCHES: 'Loose match',
  ASIN_SUBSTITUTE_RELATED: 'Substitutes', ASIN_ACCESSORY_RELATED: 'Complements',
}

export default async function CampaignPage({ params }: { params: Promise<{ profileId: string; campaignId: string }> }) {
  const { profileId, campaignId } = await params
  if (!/^\d+$/.test(profileId)) notFound()
  const sql = neon(process.env.DATABASE_URL!)

  const [head] = (await sql.query(CAMPAIGN_METRICS_CTE + `
    SELECT c.name, c.state, c.campaign_type, ${CAMPAIGN_LABEL_SQL} AS type_label,
      c.budget_amount::float AS budget_amount, c.budget_type,
      p.country_code, p.currency_code, p.gp_per_order::float AS gp_per_order, p.target_acos::float AS target_acos,
      coalesce(m.spend,0)::float AS spend, coalesce(m.sales,0)::float AS sales, coalesce(m.orders,0)::float AS orders,
      c.raw->>'targetingType' AS targeting
    FROM amazon_campaigns c JOIN amazon_profiles p ON p.profile_id = c.profile_id
    LEFT JOIN campaign_metrics m ON m.profile_id = c.profile_id AND m.campaign_id = c.campaign_id AND m.campaign_type = c.campaign_type
    WHERE c.profile_id = $1::bigint AND c.campaign_id = $2
    LIMIT 1
  `, [profileId, campaignId])) as unknown as Head[]
  if (!head) notFound()

  const sp = head.campaign_type === 'sponsoredProducts'
  const cur = head.currency_code
  const gp = head.gp_per_order
  const unit = gp != null && gp > 0

  const attributed = (status: string, extra: string) => sql.query(`
    SELECT r.id, r.rec_type, r.target_text, r.proposal, r.pushed_at::text, r.evidence
    FROM recommendations r
    LEFT JOIN amazon_ad_groups ag ON ag.ad_group_id::text = (r.evidence->>'destination_ad_group_id') AND ag.profile_id = r.profile_id
    WHERE r.profile_id = $1::bigint AND r.status = $3 ${extra}
      AND COALESCE(r.campaign_id::text, r.evidence->>'campaign_id', r.evidence->'resolved_destination'->>'campaign_id',
                   ag.campaign_id::text, CASE WHEN r.rec_type IN ('PAUSE_CAMPAIGN','BUDGET_ADJUST') THEN r.target_text END) = $2
    ORDER BY r.pushed_at DESC NULLS LAST, r.id DESC
    LIMIT 40
  `, [profileId, campaignId, status])

  const [weekRows, pushedRows, draftRows, kwRows, tgRows, stRows, bookRows] = (await Promise.all([
    sp
      ? sql`
          SELECT date_trunc('week', date)::date::text AS wk, sum(cost)::float AS spend, sum(sales_14d)::float AS sales, sum(purchases_14d)::float AS orders
          FROM amazon_campaign_daily
          WHERE profile_id = ${profileId}::bigint AND campaign_id = ${campaignId}
            AND date >= date_trunc('week', CURRENT_DATE) - interval '11 weeks'
          GROUP BY 1 ORDER BY 1`
      : sql`
          SELECT date_trunc('week', date)::date::text AS wk, sum(cost)::float AS spend, sum(sales)::float AS sales, sum(purchases)::float AS orders
          FROM amazon_campaign_daily_other
          WHERE profile_id = ${profileId}::bigint AND campaign_id = ${campaignId}
            AND date >= date_trunc('week', CURRENT_DATE) - interval '11 weeks'
          GROUP BY 1 ORDER BY 1`,
    attributed('PUSHED', `AND r.pushed_at >= now() - interval '180 days'`),
    attributed('DRAFT', ''),
    sp ? sql`
      SELECT k.keyword_id AS id, k.keyword_text AS text, k.match_type, k.state, k.bid::float AS bid,
        coalesce(st.clicks,0)::float AS clicks, coalesce(st.spend,0)::float AS spend, coalesce(st.orders,0)::float AS orders,
        coalesce(st.sales,0)::float AS sales, (st.keyword_id IS NOT NULL) AS has_perf
      FROM amazon_keywords k
      LEFT JOIN (
        SELECT keyword_id, sum(clicks) AS clicks, sum(cost) AS spend, sum(purchases_14d) AS orders, sum(sales_14d) AS sales
        FROM amazon_search_term_daily
        WHERE profile_id = ${profileId}::bigint AND campaign_id = ${campaignId} AND date >= CURRENT_DATE - 30
        GROUP BY keyword_id) st ON st.keyword_id = k.keyword_id
      WHERE k.profile_id = ${profileId}::bigint AND k.campaign_id = ${campaignId} AND upper(k.state) <> 'ARCHIVED'
      ORDER BY coalesce(st.spend,0) DESC, k.keyword_text
      LIMIT 200` : Promise.resolve([]),
    sp ? sql`
      SELECT t.target_id AS id, t.expression_type, t.expression->0->>'type' AS sub, t.expression->0->>'value' AS val,
        t.resolved_asin, t.state, t.bid::float AS bid,
        coalesce(st.clicks,0)::float AS clicks, coalesce(st.spend,0)::float AS spend, coalesce(st.orders,0)::float AS orders,
        coalesce(st.sales,0)::float AS sales, (st.keyword_id IS NOT NULL) AS has_perf
      FROM amazon_targets t
      LEFT JOIN (
        SELECT keyword_id, sum(clicks) AS clicks, sum(cost) AS spend, sum(purchases_14d) AS orders, sum(sales_14d) AS sales
        FROM amazon_search_term_daily
        WHERE profile_id = ${profileId}::bigint AND campaign_id = ${campaignId} AND date >= CURRENT_DATE - 30
        GROUP BY keyword_id) st ON st.keyword_id = t.target_id
      WHERE t.profile_id = ${profileId}::bigint AND t.campaign_id = ${campaignId} AND upper(t.state) <> 'ARCHIVED'
      ORDER BY coalesce(st.spend,0) DESC
      LIMIT 200` : Promise.resolve([]),
    sp ? sql`
      SELECT st.search_term, sum(st.clicks)::float AS clicks, sum(st.cost)::float AS spend, sum(st.purchases_14d)::float AS orders,
        sum(st.sales_14d)::float AS sales,
        EXISTS (SELECT 1 FROM amazon_keywords k WHERE k.profile_id = ${profileId}::bigint AND k.campaign_id = ${campaignId}
                 AND lower(k.keyword_text) = lower(st.search_term)) AS is_kw
      FROM amazon_search_term_daily st
      WHERE st.profile_id = ${profileId}::bigint AND st.campaign_id = ${campaignId} AND st.date >= CURRENT_DATE - 30
      GROUP BY st.search_term
      ORDER BY sum(st.cost) DESC
      LIMIT 30` : Promise.resolve([]),
    sp ? sql`
      SELECT pa.ad_id, pa.asin, pa.state, tc.title,
        coalesce(d.clicks,0)::float AS clicks, coalesce(d.spend,0)::float AS spend, coalesce(d.orders,0)::float AS orders,
        coalesce(d.sales,0)::float AS sales
      FROM amazon_product_ads pa
      LEFT JOIN title_cache tc ON tc.asin = pa.asin
      LEFT JOIN (
        SELECT ad_id, sum(clicks) AS clicks, sum(cost) AS spend, sum(purchases_14d) AS orders, sum(sales_14d) AS sales
        FROM amazon_advertised_product_daily
        WHERE profile_id = ${profileId}::text AND campaign_id = ${campaignId}::text AND date >= CURRENT_DATE - 30
        GROUP BY ad_id) d ON d.ad_id = pa.ad_id
      WHERE pa.profile_id = ${profileId}::bigint AND pa.campaign_id = ${campaignId} AND upper(pa.state) <> 'ARCHIVED'
      ORDER BY coalesce(d.spend,0) DESC
      LIMIT 100` : Promise.resolve([]),
  ])) as unknown as [WeekRow[], PushedRow[], PushedRow[], KwRow[], TgRow[], StRow[], BookRow[]]

  const j = judge({ spend: head.spend, sales: head.sales, orders: head.orders, gpPerOrder: gp, targetAcos: head.target_acos })
  const verdictOf = (spend: number, orders: number, sales = 0): { label: string; tone: Tone } => {
    const x = judge({ spend, sales, orders, gpPerOrder: gp, targetAcos: head.target_acos })
    return { label: x.label, tone: x.tone }
  }
  const per = (spend: number, orders: number) => (orders > 0 ? money(spend / orders, cur, { decimals: 2 }) : '—')
  const m2 = (v: number | null) => (v == null ? '—' : money(v, cur, { decimals: 2 }))

  // ── Header ──
  const status = head.state === 'ENABLED' ? 'Active' : head.state === 'PAUSED' ? 'Paused' : head.state === 'ARCHIVED' ? 'Archived' : head.state
  const budget = head.budget_amount == null ? null
    : `${money(head.budget_amount, cur)}${(head.budget_type ?? '').toUpperCase() === 'LIFETIME' ? ' in total' : ' a day'}`
  const kind = [marketName(head.country_code), adTypeName(head.type_label) === 'Products' ? 'Sponsored Products' : adTypeName(head.type_label),
    head.targeting ? (head.targeting.toUpperCase() === 'AUTO' ? 'automatic targeting' : 'manual targeting') : null].filter(Boolean).join(' · ')

  const kpis = [
    { k: 'Spend · 30 days', v: money(head.spend, cur), note: '' },
    { k: 'Orders', v: count(head.orders), note: '' },
    unit
      ? { k: 'Per order', v: per(head.spend, head.orders), note: j.costPerOrder != null ? `${money(Math.abs(j.costPerOrder - (gp as number)), cur, { decimals: 2 })} ${j.costPerOrder <= (gp as number) ? 'under' : 'over'} the margin` : `margin ${m2(gp)}` }
      : { k: 'ACoS', v: j.acos != null ? pct(j.acos) : '—', note: head.target_acos != null ? `target ${pct(head.target_acos, 0)}` : 'no target set' },
    unit
      ? { k: 'Profit after ads', v: head.spend > 0 && j.profitAfterAds != null ? money(j.profitAfterAds, cur, { sign: true }) : '—', note: '' }
      : { k: 'Per order', v: per(head.spend, head.orders), note: 'no margin set yet' },
    { k: 'Ad sales', v: money(head.sales, cur), note: j.acos != null && unit ? `ACoS ${pct(j.acos)}` : '' },
  ]

  // ── Weekly chart ──
  const pushWeeks = new Set(pushedRows.map(p => weekStart(p.pushed_at)))
  const weeks: Week[] = weekRows.map(w => {
    const value = unit ? (w.orders > 0 ? w.spend / w.orders : null) : (w.sales > 0 ? w.spend / w.sales : null)
    const fmt = unit ? (value == null ? (w.spend > 0 ? 'no orders' : 'no spend') : money(value, cur, { decimals: 2 })) : (value == null ? 'no sales' : pct(value))
    return { label: dayLabel(w.wk), value, spend: w.spend, change: pushWeeks.has(w.wk), tip: `Week of ${dayLabel(w.wk)}: ${fmt} · ${money(w.spend, cur)} spend · ${count(w.orders)} orders` }
  })
  const line = unit ? (gp as number) : head.target_acos
  const lineLabel = unit ? `Margin ${m2(gp)}` : head.target_acos != null ? `Target ${pct(head.target_acos, 0)}` : ''

  // ── Tabs ──
  const tabs: DetailTab[] = []
  if (sp) {
    const kw = kwRows.map(k => {
      const v = k.has_perf ? verdictOf(k.spend, k.orders, k.sales) : { label: 'No data yet', tone: 'off' as Tone }
      return { key: `k${k.id}`, a: k.text, b: `${titleCase(k.match_type)} · ${m2(k.bid)}${upper(k.state) === 'PAUSED' ? ' · paused' : ''}`,
        clicks: k.has_perf ? count(k.clicks) : '—', spend: k.has_perf ? money(k.spend, cur, { decimals: 2 }) : '—', orders: k.has_perf ? count(k.orders) : '—',
        cpo: k.has_perf ? per(k.spend, k.orders) : '—', note: v.label, tone: v.tone }
    })
    const tg = tgRows.map(t => {
      const v = t.has_perf ? verdictOf(t.spend, t.orders, t.sales) : { label: 'No data yet', tone: 'off' as Tone }
      const name = t.resolved_asin ? `Product ${t.resolved_asin}`
        : t.sub && TARGET_NAME[t.sub] ? TARGET_NAME[t.sub]
        : t.sub === 'ASIN_CATEGORY_SAME_AS' ? `Category ${t.val ?? ''}`.trim()
        : t.sub === 'ASIN_SAME_AS' ? `Product ${t.val ?? ''}`.trim()
        : titleCase(t.expression_type ?? 'Target')
      return { key: `t${t.id}`, a: name, b: `Target · ${m2(t.bid)}${upper(t.state) === 'PAUSED' ? ' · paused' : ''}`,
        clicks: t.has_perf ? count(t.clicks) : '—', spend: t.has_perf ? money(t.spend, cur, { decimals: 2 }) : '—', orders: t.has_perf ? count(t.orders) : '—',
        cpo: t.has_perf ? per(t.spend, t.orders) : '—', note: v.label, tone: v.tone }
    })
    tabs.push({ key: 'kw', label: 'Keywords and targets', note: `What we bid on, with the last 30 days of each. Judged against ${unit ? `the ${m2(gp)} margin` : 'the ACoS target'}.`,
      heads: ['Keyword or target', 'Match · bid', 'Judged'], rows: [...kw, ...tg] })
    tabs.push({ key: 'st', label: 'Search terms', note: 'What shoppers actually typed before clicking, last 30 days. Winners become keywords; losers get stopped in Decisions.',
      heads: ['Search term', '', 'Judged'], rows: stRows.map(t => {
        const v = t.is_kw ? { label: 'Already a keyword', tone: 'off' as Tone } : verdictOf(t.spend, t.orders, t.sales)
        return { key: `s${t.search_term}`, a: t.search_term, b: '', clicks: count(t.clicks), spend: money(t.spend, cur, { decimals: 2 }), orders: count(t.orders), cpo: per(t.spend, t.orders), note: v.label, tone: v.tone }
      }) })
    tabs.push({ key: 'bk', label: 'Books advertised', note: 'The editions this campaign shows, with what each sold through the ads in the last 30 days.',
      heads: ['Edition', 'ASIN', 'Judged'], rows: bookRows.map(b => {
        const v = verdictOf(b.spend, b.orders, b.sales)
        return { key: `b${b.ad_id}`, a: b.title ?? b.asin ?? b.ad_id, b: `${b.asin ?? ''}${upper(b.state) === 'PAUSED' ? ' · paused' : ''}`,
          clicks: count(b.clicks), spend: money(b.spend, cur, { decimals: 2 }), orders: count(b.orders), cpo: per(b.spend, b.orders), note: v.label, tone: v.tone }
      }) })
  }
  tabs.push({ key: 'ch', label: 'Changes sent', note: 'Every change we sent to Amazon for this campaign in the last 180 days. Results per change follow on the Results page.',
    heads: ['Change', 'Sent', ''], rows: pushedRows.map(p => {
      const v = describe({ recType: p.rec_type, targetText: p.target_text ?? '', proposal: p.proposal ?? '', campaignName: null, evidence: p.evidence ?? {},
        money: (x: number) => money(x, cur, { decimals: 2 }), count })
      return { key: `p${p.id}`, a: v.title, b: p.pushed_at ? dayLabel(p.pushed_at) : '', clicks: '', spend: '', orders: '', cpo: '', note: v.kind, tone: 'off' as Tone }
    }) })

  return (
    <main className={s.main} style={{ paddingTop: 28, gap: 22 }}>
      <Link href={`/amazon/campaigns?market=${head.country_code}`} style={{ fontWeight: 700, fontSize: 14, textDecoration: 'none' }}>← {marketName(head.country_code)} campaigns</Link>

      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 }}>
        <div style={{ minWidth: 0 }}>
          <div className={s.eyebrow}>{kind}</div>
          <h1 className={s.h1} style={{ fontSize: 40, overflowWrap: 'anywhere' }}>{head.name}</h1>
          <div className={s.lede} style={{ fontSize: 15 }}>
            {status}{budget ? ` · ${budget}` : ''} · <span className={`${s.chip} ${toneClass(head.state !== 'ENABLED' && head.spend <= 0 ? 'off' : j.tone)}`}>{head.state !== 'ENABLED' && head.spend <= 0 ? status : j.label}</span>
          </div>
        </div>
        {draftRows.length > 0 ? (
          <Link href={`/amazon/decisions?market=${head.country_code}`} className={s.btnGold}>{count(draftRows.length)} change{draftRows.length === 1 ? '' : 's'} to decide</Link>
        ) : null}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 14 }}>
        {kpis.map(k => (
          <div key={k.k} className={s.card} style={{ padding: '16px 18px' }}>
            <div className={s.label}>{k.k}</div>
            <div className={s.tn} style={{ fontSize: 26, fontWeight: 800 }}>{k.v}</div>
            {k.note ? <div className={s.note} style={{ fontSize: 12 }}>{k.note}</div> : null}
          </div>
        ))}
      </div>

      <CampaignDetail weeks={weeks} line={line} lineLabel={lineLabel} unit={unit} tabs={tabs}
                      chartTitle={unit ? 'Cost per order, week by week' : 'ACoS, week by week'} />

      {!sp ? <div className={s.foot}>Brands and Display campaigns are changed by hand in Amazon; the engine only proposes changes for Sponsored Products.</div> : null}
    </main>
  )
}

function toneClass(t: Tone): string {
  return t === 'pay' ? s.pay : t === 'even' ? s.even : t === 'lose' ? s.lose : s.off
}

function upper(v: string | null | undefined): string {
  return (v ?? '').toUpperCase()
}

function titleCase(v: string): string {
  const x = v.replace(/_/g, ' ').toLowerCase()
  return x.charAt(0).toUpperCase() + x.slice(1)
}

// Monday of the week, as YYYY-MM-DD, matching Postgres date_trunc('week', …).
function weekStart(ts: string): string {
  const d = new Date(ts.slice(0, 10) + 'T00:00:00Z')
  const dow = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - dow)
  return d.toISOString().slice(0, 10)
}
