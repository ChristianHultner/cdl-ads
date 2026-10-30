'use client'

import { useState } from 'react'
import Link from 'next/link'
import { count, type Tone } from '@/lib/amazon/yardstick'
import s from '../ui.module.css'

export type ListRow = {
  key: string; href: string; name: string; type: string; status: string; budget: string
  spend: string; spendNum: number; orders: string; cpo: string; acos: string; verdict: string; tone: Tone; todo: number
}
export type ListMarket = {
  country: string; name: string; active: number
  summary: { k: string; v: string }[]; verdict: string; tone: Tone
  judgeHead: string; foot: string; rows: ListRow[]
}

const TONE: Record<Tone, string> = { pay: s.pay, even: s.even, lose: s.lose, off: s.off }
const STATUSES = ['Active', 'Paused', 'Archived', 'All'] as const
const TYPES = ['All', 'Products', 'Brands', 'Brand video', 'Display'] as const
const COLS = 'minmax(0,1fr) 112px 76px 104px 96px 64px 96px 72px 136px 70px'

export default function CampaignsList({ markets, initial }: { markets: ListMarket[]; initial: string }) {
  const [country, setCountry] = useState(initial)
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('Active')
  const [type, setType] = useState<(typeof TYPES)[number]>('All')
  const m = markets.find(x => x.country === country) ?? markets[0]
  if (!m) return null

  const rows = m.rows.filter(r => (status === 'All' || r.status === status) && (type === 'All' || r.type === type))
  const typesHere = TYPES.filter(t => t === 'All' || m.rows.some(r => r.type === t))

  return (
    <>
      <div role="tablist" aria-label="Market" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {markets.map(x => (
          <button key={x.country} type="button" role="tab" aria-selected={x.country === m.country}
                  className={x.country === m.country ? s.marketTabOn : s.marketTab}
                  onClick={() => setCountry(x.country)}>
            {x.name} <span style={{ fontWeight: 600, opacity: 0.8 }}>{count(x.active)}</span>
          </button>
        ))}
      </div>

      <section className={s.card} style={{ padding: '20px 24px', display: 'flex', flexWrap: 'wrap', gap: '12px 40px', alignItems: 'center' }}>
        {m.summary.map(x => (
          <div key={x.k}><div className={s.label}>{x.k}</div><div className={s.tn} style={{ fontSize: 24, fontWeight: 800 }}>{x.v}</div></div>
        ))}
        <span className={`${s.chip} ${TONE[m.tone]}`} style={{ marginLeft: 'auto' }}>{m.verdict}</span>
      </section>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 24px', alignItems: 'center' }}>
        <div role="group" aria-label="Status" className={s.toggle}>
          {STATUSES.map(x => (
            <button key={x} type="button" aria-pressed={status === x} className={status === x ? s.toggleOn : s.toggleBtn} onClick={() => setStatus(x)}>{x}</button>
          ))}
        </div>
        {typesHere.length > 2 ? (
          <div role="group" aria-label="Ad type" className={s.toggle}>
            {typesHere.map(x => (
              <button key={x} type="button" aria-pressed={type === x} className={type === x ? s.toggleOn : s.toggleBtn} onClick={() => setType(x)}>{x === 'All' ? 'All types' : x}</button>
            ))}
          </div>
        ) : null}
      </div>

      <section className={s.card} style={{ padding: '8px 24px 16px' }}>
        <div className={s.tableBox}>
          <div style={{ minWidth: 1080 }}>
            <div className={s.thead} style={{ gridTemplateColumns: COLS, padding: '12px 0' }}>
              <span>Campaign</span><span>Type</span><span>Status</span><span className={s.right}>Budget</span>
              <span className={s.right}>Spend</span><span className={s.right}>Orders</span><span className={s.right}>Per order</span><span className={s.right}>ACoS</span>
              <span className={s.right}>{m.judgeHead}</span><span className={s.right}>To decide</span>
            </div>
            {rows.map(r => (
              <div key={r.key} className={s.trow} style={{ gridTemplateColumns: COLS }}>
                <Link href={r.href} className={`${s.nameLink} ${s.ellipsis}`} title={r.name}>{r.name}</Link>
                <span className={s.note} style={{ fontSize: 14 }}>{r.type}</span>
                <span className={s.note} style={{ fontSize: 14 }}>{r.status}</span>
                <span className={`${s.right} ${s.tn}`}>{r.budget}</span>
                <span className={`${s.right} ${s.tn}`}>{r.spend}</span>
                <span className={`${s.right} ${s.tn}`}>{r.orders}</span>
                <span className={`${s.right} ${s.tn} ${s.strong}`}>{r.cpo}</span>
                <span className={`${s.right} ${s.tn}`}>{r.acos}</span>
                <span className={s.right}><span className={`${s.chip} ${TONE[r.tone]}`}>{r.verdict}</span></span>
                <span className={`${s.right} ${s.tn} ${s.strong}`} style={{ color: '#7A4F00' }}>
                  {r.todo > 0 ? <Link href={`/amazon/decisions?market=${m.country}`} style={{ color: '#7A4F00' }}>{count(r.todo)}</Link> : ''}
                </span>
              </div>
            ))}
            {rows.length === 0 ? <div className={s.trow} style={{ display: 'block', color: '#4A5A64' }}>No campaigns match these filters.</div> : null}
          </div>
        </div>
      </section>

      <div className={s.foot}>{m.foot}</div>
    </>
  )
}
