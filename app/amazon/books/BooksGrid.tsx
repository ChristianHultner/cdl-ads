'use client'

import { useState } from 'react'
import Link from 'next/link'
import type { Tone } from '@/lib/amazon/yardstick'
import s from '../ui.module.css'

export type BookCard = {
  key: string; title: string; cover: string | null; meta: string
  spend: string; spendNum: number; orders: string; cpo: string; verdict: string; tone: Tone; foot: string
}
export type BooksMarket = { country: string; name: string; cards: BookCard[] }

const TONE: Record<Tone, string> = { pay: s.pay, even: s.even, lose: s.lose, off: s.off }
const VIEWS = [['all', 'All advertised'], ['pay', 'Paying'], ['lose', 'Losing']] as const
const SWATCH = ['#0093D0', '#2F7D6B', '#B4536A', '#C0712E', '#6A5AA8', '#4F6B7A', '#8A6A2E']

export default function BooksGrid({ markets, initial }: { markets: BooksMarket[]; initial: string }) {
  const [country, setCountry] = useState(initial)
  const [view, setView] = useState<(typeof VIEWS)[number][0]>('all')
  const m = markets.find(x => x.country === country) ?? markets[0]
  if (!m) return null
  const cards = m.cards.filter(c => view === 'all' || c.tone === view)

  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 24px', alignItems: 'center' }}>
        {markets.length > 1 ? (
          <div role="group" aria-label="Market" className={s.toggle}>
            {markets.map(x => (
              <button key={x.country} type="button" aria-pressed={x.country === m.country}
                      className={x.country === m.country ? s.toggleOn : s.toggleBtn} onClick={() => setCountry(x.country)}>{x.name}</button>
            ))}
          </div>
        ) : null}
        <div role="group" aria-label="Show" className={s.toggle}>
          {VIEWS.map(([k, label]) => (
            <button key={k} type="button" aria-pressed={view === k} className={view === k ? s.toggleOn : s.toggleBtn} onClick={() => setView(k)}>
              {label} {k === 'all' ? m.cards.length : m.cards.filter(c => c.tone === k).length}
            </button>
          ))}
        </div>
      </div>

      <div className={s.bookGrid}>
        {cards.map((b, i) => (
          <article key={b.key} className={s.bookCard}>
            {b.cover ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.cover} alt="" className={s.bookCover} loading="lazy" />
            ) : (
              <div className={s.bookCover} style={{ background: SWATCH[i % SWATCH.length] }} aria-hidden="true">
                <span>{b.title}</span>
              </div>
            )}
            <div style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'flex-start' }}>
                <Link href={`/amazon/campaigns?market=${m.country}`} className={s.nameLink} style={{ fontSize: 16, lineHeight: 1.25 }}>{b.title}</Link>
                <span className={`${s.chip} ${TONE[b.tone]}`} style={{ flex: 'none' }}>{b.verdict}</span>
              </div>
              <div className={s.note}>{b.meta}</div>
              <div className={s.tn} style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 6, marginTop: 4 }}>
                <div><div className={s.statK}>Spend</div><div className={s.statV}>{b.spend}</div></div>
                <div><div className={s.statK}>Orders</div><div className={s.statV}>{b.orders}</div></div>
                <div><div className={s.statK}>Per order</div><div className={s.statV}>{b.cpo}</div></div>
              </div>
              {b.foot ? <div className={`${s.note} ${s.tn}`} style={{ borderTop: '1px solid #E3F1F8', paddingTop: 8 }}>{b.foot}</div> : null}
            </div>
          </article>
        ))}
        {cards.length === 0 ? <section className={s.card}>No books in this view.</section> : null}
      </div>
    </>
  )
}
