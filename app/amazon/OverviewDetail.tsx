'use client'

import { useState } from 'react'
import Link from 'next/link'
import { moneyK, count, pct, type Tone } from '@/lib/amazon/yardstick'
import s from './ui.module.css'

export type MarketDetail = {
  country: string
  name: string
  currency: string
  unit: boolean
  judgeHead: string
  months: { label: string; value: number }[]
  rolling: {
    labels: string[]
    purchases: (number | null)[]
    sales: (number | null)[]
    spend: (number | null)[]
    profit: (number | null)[]
  }
  gap: { label: string; units: number; orders: number } | null
  top: { href: string; name: string; type: string; spend: string; orders: string; cpo: string; acos: string; verdict: string; tone: Tone }[]
}

const TONE: Record<Tone, string> = { pay: s.pay, even: s.even, lose: s.lose, off: s.off }
const W = 1200
const H = 260

// Round axis steps: 1, 2, 2.5 or 5 × 10^n, about five lines.
function niceTicks(lo: number, hi: number): number[] {
  const span = Math.max(1, hi - lo)
  const raw = span / 5
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const step = [1, 2, 2.5, 5, 10].map(f => f * mag).find(st => st >= raw) ?? 10 * mag
  const start = Math.floor(lo / step) * step
  const out: number[] = []
  for (let v = start; v <= hi + step * 0.001; v += step) out.push(Number(v.toFixed(6)))
  if (out[out.length - 1] < hi) out.push(out[out.length - 1] + step)
  return out
}

function path(values: (number | null)[], y: (v: number) => number): string {
  const n = values.length
  let d = ''
  let pen = false
  values.forEach((v, i) => {
    if (v == null) { pen = false; return }
    const x = ((i + 0.5) / n) * W
    d += `${pen ? 'L' : 'M'}${x.toFixed(1)} ${y(v).toFixed(1)} `
    pen = true
  })
  return d.trim()
}

export default function OverviewDetail({ markets }: { markets: MarketDetail[] }) {
  const [country, setCountry] = useState(markets[0]?.country ?? '')
  const m = markets.find(x => x.country === country) ?? markets[0]
  if (!m) return null
  const cur = m.currency

  // ── Rolling 12 ──
  const r = m.rolling
  const SERIES = [
    { name: 'Amazon’s purchases from us', values: r.purchases, stroke: '#4F6B7A', dash: '8 6', key: { width: 18, height: 0, borderTop: '3px dashed #4F6B7A' } },
    { name: 'Ad sales', values: r.sales, stroke: '#0093D0', dash: undefined, key: { width: 18, height: 3, background: '#0093D0', borderRadius: 2 } },
    { name: 'Ad spend', values: r.spend, stroke: '#F5B32B', dash: undefined, key: { width: 18, height: 3, background: '#F5B32B', borderRadius: 2 } },
    { name: m.unit ? 'Profit after ads' : 'Ad sales minus spend', values: r.profit, stroke: '#E8743B', dash: undefined, key: { width: 18, height: 3, background: '#E8743B', borderRadius: 2 } },
  ].filter(x => x.values.some(v => v != null))
  const all = SERIES.flatMap(x => x.values.filter((v): v is number => v != null))
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all))
  const lo = ticks[0]
  const hi = ticks[ticks.length - 1]
  const y = (v: number) => H - ((v - lo) / (hi - lo || 1)) * H
  const last = (vals: (number | null)[]) => [...vals].reverse().find(v => v != null) ?? null
  const rollAria = `Rolling 12-month totals for ${m.name}: ` +
    SERIES.map(x => `${x.name} ${last(x.values) != null ? moneyK(last(x.values) as number, cur) : 'none'}`).join(', ')

  // ── Month by month ──
  const maxAbs = Math.max(1, ...m.months.map(x => Math.abs(x.value)))
  const barH = (v: number) => Math.max(2, (Math.abs(v) / maxAbs) * 104)

  return (
    <>
      <div className={s.cardHead} style={{ marginBottom: 0 }}>
        <h2 className={s.h2}>{m.name} in detail</h2>
        {markets.length > 1 ? (
          <div role="group" aria-label="Market" className={s.toggle}>
            {markets.map(x => (
              <button key={x.country} type="button" aria-pressed={x.country === m.country}
                      className={x.country === m.country ? s.toggleOn : s.toggleBtn}
                      onClick={() => setCountry(x.country)}>{x.name}</button>
            ))}
          </div>
        ) : null}
      </div>

      {r.labels.length > 0 ? (
        <section className={s.card}>
          <h2 className={s.h2} style={{ marginBottom: 6 }}>The year: rolling 12 months</h2>
          <div className={s.note} style={{ marginBottom: 14 }}>Each point is the total of the 12 months ending that month, so the seasons cancel out · {cur}</div>
          <div className={s.legend}>
            {SERIES.map(x => (
              <span key={x.name} className={s.legendItem}>
                <span style={x.key} />{x.name}{' '}
                <b className={s.tn} style={{ color: '#1E2A32' }}>{last(x.values) != null ? moneyK(last(x.values) as number, cur, { sign: x.name.startsWith('Profit') }) : '—'}</b>
              </span>
            ))}
          </div>
          <div className={s.plot}>
            {ticks.map(t => (
              <div key={t}>
                <div className={t === 0 ? s.gridZero : s.gridLine} style={{ top: y(t) }} />
                <div className={`${s.gridLabel} ${s.tn}`} style={{ top: y(t) - 9 }}>{moneyK(t, cur)}</div>
              </div>
            ))}
            <svg className={s.plotSvg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={rollAria}>
              {SERIES.map(x => (
                <path key={x.name} d={path(x.values, y)} fill="none" stroke={x.stroke} strokeWidth={3}
                      strokeDasharray={x.dash} vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
              ))}
            </svg>
          </div>
          <div className={s.xAxis} style={{ gridTemplateColumns: `repeat(${r.labels.length}, minmax(0, 1fr))` }}>
            {r.labels.map(l => <div key={l} className={s.xLabel}>{l}</div>)}
          </div>
        </section>
      ) : null}

      <div className={s.row}>
        {m.months.length > 0 ? (
          <section className={`${s.card} ${s.grow}`}>
            <h2 className={s.h2} style={{ marginBottom: 6 }}>{m.unit ? 'Profit after ads, month by month' : 'Ad sales minus spend, month by month'}</h2>
            <div className={s.note} style={{ marginBottom: 16 }}>
              {m.unit ? 'Orders × margin per order − ad spend' : 'No margin set for this market yet, so this is ad sales minus ad spend'} · {cur} · complete months only
            </div>
            <div className={s.bars} style={{ gridTemplateColumns: `repeat(${m.months.length}, minmax(0, 1fr))` }}>
              {m.months.map(x => (
                <div key={x.label} className={s.barCol} title={`${x.label}: ${moneyK(x.value, cur, { sign: true })}`}>
                  <div className={s.barUp}>
                    <div className={`${s.barVal} ${s.tn}`} style={{ color: '#1F6B3A' }}>{x.value > 0 ? moneyK(x.value, cur, { sign: true }) : ''}</div>
                    <div style={{ height: x.value > 0 ? barH(x.value) : 0, background: '#0093D0', borderRadius: '4px 4px 0 0' }} />
                  </div>
                  <div className={s.barDown}>
                    <div style={{ height: x.value < 0 ? barH(x.value) : 0, background: '#E8743B', borderRadius: '0 0 4px 4px' }} />
                    <div className={`${s.barVal} ${s.tn}`} style={{ color: '#9A3412' }}>{x.value < 0 ? moneyK(x.value, cur) : ''}</div>
                  </div>
                  <div className={s.xLabel} style={{ marginTop: 6 }}>{x.label}</div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {m.gap ? (
          <section className={`${s.card} ${s.side}`} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <h2 className={s.h2}>What ads can’t see</h2>
            <div className={s.note} style={{ fontSize: 14 }}>{m.name} · {m.gap.label} · Amazon’s purchases from us against orders Amazon credits to ads</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700 }}><span>Units Amazon bought</span><span className={s.tn}>{count(m.gap.units)}</span></div>
                <div style={{ height: 12, background: '#4F6B7A', borderRadius: 999, marginTop: 4 }} />
              </div>
              <div>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, fontWeight: 700 }}><span>Orders credited to ads</span><span className={s.tn}>{count(m.gap.orders)}</span></div>
                <div style={{ height: 12, background: '#E9F5FB', borderRadius: 999, marginTop: 4 }}>
                  <div style={{ height: 12, width: `${Math.min(100, (m.gap.orders / m.gap.units) * 100).toFixed(1)}%`, background: '#0093D0', borderRadius: 999 }} />
                </div>
              </div>
            </div>
            <div className={`${s.big} ${s.tn}`}>{pct(m.gap.orders / m.gap.units, 0)}</div>
            <div className={s.note} style={{ marginTop: -10 }}>of {m.gap.label}’s units carry an ad credit</div>
            <div className={s.foot} style={{ borderTop: '1px solid #E3F1F8', paddingTop: 12 }}>
              Amazon’s purchases lag shelf sales, so read this over a quarter, not a month. Ad credit also includes shoppers who would have bought anyway.
            </div>
          </section>
        ) : null}
      </div>

      {m.top.length > 0 ? (
        <section className={s.card}>
          <div className={s.cardHead} style={{ marginBottom: 8 }}>
            <h2 className={s.h2}>Where {m.name}’s money goes</h2>
            <Link href="/amazon/campaigns" style={{ fontWeight: 700, fontSize: 14 }}>All campaigns →</Link>
          </div>
          <div className={s.tableBox}>
            <div style={{ minWidth: 820 }}>
              <div className={s.thead} style={{ gridTemplateColumns: 'minmax(0,1fr) 130px 96px 72px 104px 76px 140px' }}>
                <span>Campaign</span><span>Type</span><span className={s.right}>Spend</span><span className={s.right}>Orders</span><span className={s.right}>Per order</span><span className={s.right}>ACoS</span><span className={s.right}>{m.judgeHead}</span>
              </div>
              {m.top.map(c => (
                <div key={c.href} className={s.trow} style={{ gridTemplateColumns: 'minmax(0,1fr) 130px 96px 72px 104px 76px 140px' }}>
                  <Link href={c.href} className={`${s.nameLink} ${s.ellipsis}`} title={c.name}>{c.name}</Link>
                  <span className={s.note} style={{ fontSize: 14 }}>{c.type}</span>
                  <span className={`${s.right} ${s.tn}`}>{c.spend}</span>
                  <span className={`${s.right} ${s.tn}`}>{c.orders}</span>
                  <span className={`${s.right} ${s.tn} ${s.strong}`}>{c.cpo}</span>
                  <span className={`${s.right} ${s.tn}`}>{c.acos}</span>
                  <span className={s.right}><span className={`${s.chip} ${TONE[c.tone]}`}>{c.verdict}</span></span>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}
    </>
  )
}
