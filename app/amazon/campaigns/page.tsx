export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { CAMPAIGN_METRICS_CTE, CAMPAIGN_LABEL_SQL } from '@/lib/amazon/campaign-display'
import { judge, money, pct, count, marketName, adTypeName } from '@/lib/amazon/yardstick'
import CampaignsList, { type ListMarket, type ListRow } from './CampaignsList'
import s from '../ui.module.css'

type MarketRow = {
  country_code: string; currency_code: string; gp_per_order: number | null; target_acos: number | null
  spend: number; sales: number; orders: number; total: number
}
type CampaignRow = {
  profile_id: string; country_code: string; campaign_id: string; name: string; state: string; type_label: string
  spend: number; sales: number; orders: number; budget_amount: number | null; budget_type: string | null
}
type RecCount = { profile_id: string; campaign_id: string; n: number }

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const sp = await searchParams
  const sql = neon(process.env.DATABASE_URL!)

  const [marketRows, campaignRows, recRows] = (await Promise.all([
    sql.query(CAMPAIGN_METRICS_CTE + `
      SELECT ap.country_code, ap.currency_code,
        max(ap.gp_per_order)::float AS gp_per_order, max(ap.target_acos)::float AS target_acos,
        coalesce(sum(m.spend),0)::float AS spend, coalesce(sum(m.sales),0)::float AS sales, coalesce(sum(m.orders),0)::float AS orders,
        (SELECT count(*)::int FROM amazon_campaigns c JOIN amazon_profiles p2 ON p2.profile_id = c.profile_id
          WHERE p2.country_code = ap.country_code AND p2.is_active AND c.state IN ('ENABLED','PAUSED')) AS total
      FROM amazon_profiles ap LEFT JOIN campaign_metrics m ON m.profile_id = ap.profile_id
      WHERE ap.is_active
      GROUP BY ap.country_code, ap.currency_code
      ORDER BY coalesce(array_position(ARRAY['ES','US','MX','UK','CA'], ap.country_code), 99), ap.country_code
    `),
    sql.query(CAMPAIGN_METRICS_CTE + `
      SELECT c.profile_id::text, ap.country_code, c.campaign_id::text, c.name, c.state, ${CAMPAIGN_LABEL_SQL} AS type_label,
        coalesce(m.spend,0)::float AS spend, coalesce(m.sales,0)::float AS sales, coalesce(m.orders,0)::float AS orders,
        c.budget_amount::float AS budget_amount, c.budget_type
      FROM amazon_campaigns c
      JOIN amazon_profiles ap ON ap.profile_id = c.profile_id
      LEFT JOIN campaign_metrics m ON m.profile_id = c.profile_id AND m.campaign_id = c.campaign_id AND m.campaign_type = c.campaign_type
      WHERE ap.is_active AND c.state IN ('ENABLED','PAUSED','ARCHIVED')
      ORDER BY coalesce(m.spend,0) DESC, c.name
    `),
    // Waiting decisions per campaign, with the same attribution as the Decisions page.
    sql`
      SELECT r.profile_id::text,
        COALESCE(r.campaign_id::text, r.evidence->>'campaign_id', r.evidence->'resolved_destination'->>'campaign_id',
                 ag.campaign_id::text, CASE WHEN r.rec_type IN ('PAUSE_CAMPAIGN','BUDGET_ADJUST') THEN r.target_text END) AS campaign_id,
        count(*)::int AS n
      FROM recommendations r
      LEFT JOIN amazon_ad_groups ag
        ON ag.ad_group_id::text = (r.evidence->>'destination_ad_group_id') AND ag.profile_id = r.profile_id
      WHERE r.status = 'DRAFT'
      GROUP BY 1, 2
    `,
  ])) as unknown as [MarketRow[], CampaignRow[], RecCount[]]

  const recMap = new Map(recRows.filter(r => r.campaign_id).map(r => [`${r.profile_id}:${r.campaign_id}`, r.n]))

  const markets: ListMarket[] = marketRows
    .filter(m => m.total > 0 || m.spend > 0)
    .map((m): ListMarket => {
      const cur = m.currency_code
      const j = judge({ spend: m.spend, sales: m.sales, orders: m.orders, gpPerOrder: m.gp_per_order, targetAcos: m.target_acos })
      const unit = j.basis === 'unit'
      const rows: ListRow[] = campaignRows.filter(c => c.country_code === m.country_code).map((c): ListRow => {
        const cj = judge({ spend: c.spend, sales: c.sales, orders: c.orders, gpPerOrder: m.gp_per_order, targetAcos: m.target_acos })
        const status = c.state === 'ENABLED' ? 'Active' : c.state === 'PAUSED' ? 'Paused' : 'Archived'
        const budget = c.budget_amount == null ? '—'
          : `${money(c.budget_amount, cur)}${(c.budget_type ?? '').toUpperCase() === 'LIFETIME' ? ' total' : ' a day'}`
        return {
          key: `${c.profile_id}:${c.campaign_id}`,
          href: `/amazon/campaigns/${c.profile_id}/${c.campaign_id}`,
          name: c.name,
          type: adTypeName(c.type_label),
          status,
          budget,
          spend: money(c.spend, cur),
          spendNum: c.spend,
          orders: count(c.orders),
          cpo: cj.costPerOrder != null ? money(cj.costPerOrder, cur, { decimals: 2 }) : '—',
          verdict: c.state !== 'ENABLED' && c.spend <= 0 ? status : cj.label,
          tone: c.state !== 'ENABLED' && c.spend <= 0 ? 'off' : cj.tone,
          todo: recMap.get(`${c.profile_id}:${c.campaign_id}`) ?? 0,
        }
      })
      const summary = unit
        ? [
            { k: 'Spend', v: money(m.spend, cur) },
            { k: 'Orders', v: count(m.orders) },
            { k: 'Per order', v: j.costPerOrder != null ? money(j.costPerOrder, cur, { decimals: 2 }) : '—' },
            { k: 'Profit after ads', v: m.spend > 0 && j.profitAfterAds != null ? money(j.profitAfterAds, cur, { sign: true }) : '—' },
          ]
        : [
            { k: 'Spend', v: money(m.spend, cur) },
            { k: 'Orders', v: count(m.orders) },
            { k: 'Ad sales', v: money(m.sales, cur) },
            { k: 'ACoS', v: j.acos != null ? pct(j.acos) : '—' },
          ]
      const judgeHead = unit
        ? `Against ${money(m.gp_per_order as number, cur, { decimals: 2 })}`
        : m.target_acos != null ? `Against ${pct(m.target_acos, 0)} ACoS` : 'Verdict'
      const foot = unit
        ? `${marketName(m.country_code)} is judged on cost per order against a ${money(m.gp_per_order as number, cur, { decimals: 2 })} margin per order; break-even means within 5%`
        : `${marketName(m.country_code)} has no margin per order set, so it is judged on ad spend as a share of ad sales (ACoS)`
      return {
        country: m.country_code,
        name: marketName(m.country_code),
        active: rows.filter(r => r.status === 'Active').length,
        summary,
        verdict: m.spend > 0 ? j.label : 'No spend',
        tone: m.spend > 0 ? j.tone : 'off',
        judgeHead,
        foot,
        rows,
      }
    })

  const initial = typeof sp.market === 'string' && markets.some(m => m.country === sp.market) ? sp.market : markets[0]?.country ?? ''

  return (
    <main className={s.main}>
      <div>
        <div className={s.eyebrow}>Amazon ads</div>
        <h1 className={s.h1}>Campaigns</h1>
        <div className={s.lede}>Every ad type in one list · last 30 days · sorted by spend</div>
      </div>
      {markets.length === 0 ? <section className={s.card}>No active market has campaigns yet.</section> : <CampaignsList markets={markets} initial={initial} />}
    </main>
  )
}
