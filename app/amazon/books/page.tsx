export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { judge, money, count, pct, marketName } from '@/lib/amazon/yardstick'
import BooksGrid, { type BookCard, type BooksMarket } from './BooksGrid'
import s from '../ui.module.css'

type Row = {
  country_code: string; currency_code: string; gp_per_order: number | null; target_acos: number | null
  asin: string; title: string | null; cover_url: string | null
  spend: number; sales: number; orders: number; clicks: number; campaigns: number
}

export default async function BooksPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const sp = await searchParams
  const sql = neon(process.env.DATABASE_URL!)

  // Sponsored Products report per advertised ASIN; Brands and Display report per campaign only.
  const rows = (await sql`
    SELECT p.country_code, p.currency_code, p.gp_per_order::float AS gp_per_order, p.target_acos::float AS target_acos,
      d.asin, max(tc.title) AS title, max(tc.cover_url) AS cover_url,
      sum(d.cost)::float AS spend, sum(d.sales_14d)::float AS sales, sum(d.purchases_14d)::float AS orders,
      sum(d.clicks)::float AS clicks, count(DISTINCT d.campaign_id)::int AS campaigns
    FROM amazon_advertised_product_daily d
    JOIN amazon_profiles p ON p.profile_id::text = d.profile_id
    LEFT JOIN title_cache tc ON tc.asin = d.asin
    WHERE p.is_active AND d.asin IS NOT NULL AND d.date >= CURRENT_DATE - 30
    GROUP BY p.country_code, p.currency_code, p.gp_per_order, p.target_acos, d.asin
    HAVING sum(d.cost) > 0
  `) as unknown as Row[]

  const order = ['ES', 'US', 'MX', 'UK', 'CA']
  const countries = [...new Set(rows.map(r => r.country_code))]
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))

  const markets: BooksMarket[] = countries.map(country => {
    const mine = rows.filter(r => r.country_code === country)
    const cur = mine[0].currency_code
    const gp = mine[0].gp_per_order
    const target = mine[0].target_acos
    // One card per title; editions (ASINs) with the same title are added together.
    const byTitle = new Map<string, Row[]>()
    for (const r of mine) {
      const key = (r.title ?? r.asin).trim().toLowerCase()
      byTitle.set(key, [...(byTitle.get(key) ?? []), r])
    }
    const cards: BookCard[] = [...byTitle.values()].map(group => {
      const spend = group.reduce((t, r) => t + r.spend, 0)
      const sales = group.reduce((t, r) => t + r.sales, 0)
      const orders = group.reduce((t, r) => t + r.orders, 0)
      const j = judge({ spend, sales, orders, gpPerOrder: gp, targetAcos: target })
      const lead = [...group].sort((a, b) => b.spend - a.spend)[0]
      const campaigns = Math.max(...group.map(r => r.campaigns))
      return {
        key: lead.asin,
        title: lead.title ?? `ASIN ${lead.asin}`,
        cover: group.find(r => r.cover_url)?.cover_url ?? null,
        meta: `${count(campaigns)} campaign${campaigns === 1 ? '' : 's'}${group.length > 1 ? ` · ${count(group.length)} editions` : ''}`,
        spend: money(spend, cur),
        spendNum: spend,
        orders: count(orders),
        cpo: j.costPerOrder != null ? money(j.costPerOrder, cur, { decimals: 2 }) : '—',
        verdict: j.label,
        tone: j.tone,
        foot: [
          j.basis === 'unit' && j.profitAfterAds != null ? `Profit after ads ${money(j.profitAfterAds, cur, { sign: true, decimals: Math.abs(j.profitAfterAds) >= 100 ? 0 : 2 })}` : '',
          j.acos != null ? `ACoS ${pct(j.acos)}` : '',
        ].filter(Boolean).join(' · '),
      }
    }).sort((a, b) => b.spendNum - a.spendNum)
    return { country, name: marketName(country), cards }
  })

  const initial = typeof sp.market === 'string' && countries.includes(sp.market) ? sp.market : countries[0] ?? ''

  return (
    <main className={s.main}>
      <div>
        <div className={s.eyebrow}>Amazon ads</div>
        <h1 className={s.h1}>Books</h1>
        <div className={s.lede}>What each title earns from ads, across all its campaigns and editions · last 30 days</div>
      </div>
      {markets.length === 0
        ? <section className={s.card}>No advertised books with spend in the last 30 days.</section>
        : <BooksGrid markets={markets} initial={initial} />}
      <div className={s.foot}>Sponsored Products only: Amazon reports Brands and Display per campaign, not per book. Editions with the same title are added together.</div>
    </main>
  )
}
