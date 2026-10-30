'use client'

import { useState } from 'react'
import type { Tone } from '@/lib/amazon/yardstick'
import s from '../../../ui.module.css'

export type Week = { label: string; value: number | null; spend: number; change: boolean; tip: string }
export type DetailRow = { key: string; a: string; b: string; clicks: string; spend: string; orders: string; cpo: string; note: string; tone: Tone }
export type DetailTab = { key: string; label: string; note: string; heads: [string, string, string]; rows: DetailRow[] }

const TONE: Record<Tone, string> = { pay: s.pay, even: s.even, lose: s.lose, off: s.off }
const COLS = 'minmax(0,1fr) 170px 80px 100px 70px 100px 150px'
const H = 180

export default function CampaignDetail({ weeks, line, lineLabel, unit, tabs, chartTitle }: {
  weeks: Week[]; line: number | null; lineLabel: string; unit: boolean; tabs: DetailTab[]; chartTitle: string
}) {
  const [tabKey, setTabKey] = useState(tabs[0]?.key ?? '')
  const tab = tabs.find(t => t.key === tabKey) ?? tabs[0]

  const values = weeks.map(w => w.value).filter((v): v is number => v != null)
  const top = Math.max(line != null ? line * 1.5 : 0, ...values, 0.0001)
  const h = (v: number) => Math.min(H, (v / top) * H)
  const lineY = line != null ? h(line) : null
  const showCpo = tab && tab.key !== 'ch'

  return (
    <>
      {weeks.length > 0 ? (
        <section className={s.card}>
          <div className={s.cardHead} style={{ marginBottom: 14 }}>
            <h2 className={s.h2} style={{ fontSize: 22 }}>{chartTitle}</h2>
            <div className={s.legend} style={{ marginBottom: 0 }}>
              <span className={s.legendItem}><span style={{ width: 12, height: 12, borderRadius: 3, background: '#0093D0' }} />Within {unit ? 'margin' : 'target'}</span>
              <span className={s.legendItem}><span style={{ width: 12, height: 12, borderRadius: 3, background: '#E8743B' }} />Over</span>
              {lineLabel ? <span className={s.legendItem}><span style={{ width: 14, height: 0, borderTop: '2px dashed #1E2A32' }} />{lineLabel}</span> : null}
              <span className={s.legendItem}><span style={{ width: 10, height: 10, borderRadius: 999, background: '#F5B32B', border: '2px solid #1E2A32', boxSizing: 'border-box' }} />A change we sent</span>
            </div>
          </div>
          <div style={{ position: 'relative', height: H, display: 'grid', gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))`, gap: 10, alignItems: 'end', borderBottom: '1px solid #A3B5C0' }}>
            {lineY != null ? <div style={{ position: 'absolute', left: 0, right: 0, bottom: lineY, borderTop: '2px dashed #1E2A32' }} /> : null}
            {weeks.map(w => {
              const over = w.value == null ? w.spend > 0 : line != null && w.value > line
              const height = w.value == null ? (w.spend > 0 ? H : 2) : Math.max(2, h(w.value))
              return (
                <div key={w.label} title={w.tip} style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
                  {w.change ? <span style={{ width: 12, height: 12, borderRadius: 999, background: '#F5B32B', border: '2px solid #1E2A32', boxSizing: 'border-box', flex: 'none' }} /> : null}
                  <div style={{ width: '100%', height, borderRadius: '4px 4px 0 0', background: w.value == null && w.spend <= 0 ? '#E3F1F8' : over ? '#E8743B' : '#0093D0', opacity: w.value == null && w.spend > 0 ? 0.55 : 1 }} />
                </div>
              )
            })}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))`, gap: 10, marginTop: 6 }}>
            {weeks.map(w => <div key={w.label} className={s.xLabel} style={{ fontWeight: 600 }}>{w.label}</div>)}
          </div>
          <div className={s.foot} style={{ marginTop: 10 }}>Weeks start on Monday; the last bar is the week so far. A faded full-height bar means spend with no orders.</div>
        </section>
      ) : null}

      {tab ? (
        <>
          <div role="tablist" aria-label="Detail" className={s.tabs}>
            {tabs.map(t => (
              <button key={t.key} type="button" role="tab" aria-selected={t.key === tab.key}
                      className={t.key === tab.key ? s.tabBtnOn : s.tabBtn} onClick={() => setTabKey(t.key)}>
                {t.label} <span className={s.tn} style={{ fontWeight: 600, opacity: 0.8 }}>{t.rows.length}</span>
              </button>
            ))}
          </div>
          <section className={s.card} style={{ padding: '8px 24px 16px' }}>
            <div className={s.note} style={{ padding: '14px 0 4px' }}>{tab.note}</div>
            <div className={s.tableBox}>
              <div style={{ minWidth: 880 }}>
                <div className={s.thead} style={{ gridTemplateColumns: COLS, padding: '12px 0' }}>
                  <span>{tab.heads[0]}</span><span>{tab.heads[1]}</span>
                  <span className={s.right}>{showCpo ? 'Clicks' : ''}</span><span className={s.right}>{showCpo ? 'Spend' : ''}</span>
                  <span className={s.right}>{showCpo ? 'Orders' : ''}</span><span className={s.right}>{showCpo ? 'Per order' : ''}</span>
                  <span className={s.right}>{tab.heads[2]}</span>
                </div>
                {tab.rows.map(r => (
                  <div key={r.key} className={s.trow} style={{ gridTemplateColumns: COLS }}>
                    <span className={`${s.strong} ${s.ellipsis}`} title={r.a}>{r.a}</span>
                    <span className={s.note} style={{ fontSize: 14 }}>{r.b}</span>
                    <span className={`${s.right} ${s.tn}`}>{r.clicks}</span>
                    <span className={`${s.right} ${s.tn}`}>{r.spend}</span>
                    <span className={`${s.right} ${s.tn}`}>{r.orders}</span>
                    <span className={`${s.right} ${s.tn} ${s.strong}`}>{r.cpo}</span>
                    <span className={s.right}><span className={`${s.chip} ${TONE[r.tone]}`}>{r.note}</span></span>
                  </div>
                ))}
                {tab.rows.length === 0 ? <div className={s.trow} style={{ display: 'block', color: '#4A5A64' }}>Nothing here yet.</div> : null}
              </div>
            </div>
          </section>
        </>
      ) : null}
    </>
  )
}
