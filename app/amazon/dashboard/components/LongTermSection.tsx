'use client'

// Long-term 12-month rolling chart for console_history data.
// A rolling-12 point is plotted ONLY where all 12 consecutive months of data exist — no partial windows.
// GP basis: unit-basis (gpPerOrder × orders12 − spend12); revenue-basis (sales12 − spend12) when null.
// Y-axis (RULING 2): yMax = 1.1 × market's highest; yMin = min(0, 1.1 × market's lowest) — per-market,
// no shared cross-market domain, no niceMax rounding. Zero gridline emphasized when yMin < 0.
// Value labels (RULING 1): 'values' toggle (default OFF); compact k-notation per point, color-matched.
//   GP labels flip to above when below-placement enters bottom band (T+PH); sales/spend flip to below
//   when above-placement enters top band (T). Legend fixed in top band (y < T), outside data area.
// Face label: 'source: console exports - monthly - all ad types'

import { useState } from 'react'
import { profileGP } from '../../../lib/scorecard'

export interface LongTermPoint {
  label:   string   // 'YYYY-MM' — endpoint month of the 12-month window
  spend12: number
  sales12: number
  orders12: number
}

export interface LongTermMarket {
  country:    string
  currency:   string
  gpPerOrder: number | null
  points:     LongTermPoint[]
}

// ── SVG geometry — matches SalesSpendChart conventions ──────────────────────
const W = 900, H = 260
const L = 64, R = 14, T = 40, B = 32  // T=40: reserves top band (0–T) for legend; data area starts at T
const PW = W - L - R
const PH = H - T - B

const SYM: Record<string, string> = { EUR: '€', USD: '$', MXN: 'MX$', GBP: '£', CAD: 'CA$' }
const TAB_ORDER = ['ES', 'US', 'MX', 'UK', 'CA', 'DE', 'FR', 'IT']

function tx(i: number, n: number) { return n <= 1 ? L : L + (i / (n - 1)) * PW }
function ty(v: number, minV: number, maxV: number) {
  const range = maxV - minV
  if (range === 0) return T + PH
  return T + PH - ((v - minV) / range) * PH
}
function polyline(pts: { x: number; y: number }[]) {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}
// Compact value-label formatter: $138.6k / -$42.3k; native currency symbol.
function fmtK(v: number, sym: string): string {
  const neg = v < 0
  const abs = Math.abs(v)
  const s   = abs >= 1000 ? `${(abs / 1000).toFixed(1)}k` : abs.toFixed(1)
  return `${neg ? '-' : ''}${sym}${s}`
}

// ── Inner SVG chart — pure render, no state ─────────────────────────────────
function RollingChart({ market, showValues }: { market: LongTermMarket; showValues: boolean }) {
  const { country, currency, gpPerOrder, points } = market
  const sym = SYM[currency] ?? currency
  const n   = points.length

  if (n === 0) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cdl-muted)', fontSize: '0.85rem' }}>
        No rolling-12 data (need 12 consecutive months)
      </div>
    )
  }

  const gpVals  = points.map(p => profileGP(gpPerOrder, p.orders12, p.sales12, p.spend12))
  const gpLabel = gpPerOrder != null ? 'Rolling-12 GP' : 'Rolling-12 GP (rev)'

  // Y-axis domain (RULING 2): per-market, no shared cross-market ceiling, no niceMax rounding.
  // yMax = 1.1 × this market's highest; yMin = min(0, 1.1 × this market's lowest).
  const rawMin = Math.min(...points.map(p => p.spend12), ...points.map(p => p.sales12), ...gpVals)
  const rawMax = Math.max(...points.map(p => p.spend12), ...points.map(p => p.sales12), ...gpVals)
  const minV   = Math.min(0, rawMin * 1.1)
  const maxV   = rawMax > 0 ? rawMax * 1.1 : 100
  // Zero gridline pre-computed; rendered heavier/darker only when domain spans negative values.
  const zeroLineY = minV < 0 ? ty(0, minV, maxV) : null

  const spendPts = points.map((p, i) => ({ x: tx(i, n), y: ty(p.spend12, minV, maxV) }))
  const salesPts = points.map((p, i) => ({ x: tx(i, n), y: ty(p.sales12, minV, maxV) }))
  const gpPts    = gpVals.map((v, i)  => ({ x: tx(i, n), y: ty(v,         minV, maxV) }))

  // GP shaded fill: forward along sales line, backward along spend line
  const gpFillPath = [
    ...salesPts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    ...[...spendPts].reverse().map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`),
    'Z',
  ].join(' ')

  // X-axis ticks: every other label when many points to avoid crowding
  const step   = n > 15 ? 2 : 1
  const xTicks = points.reduce<{ x: number; label: string }[]>((acc, p, i) => {
    if (i % step === 0) acc.push({ x: tx(i, n), label: p.label })
    return acc
  }, [])

  // Y-axis ticks: 5 evenly-spaced steps across [minV, maxV]
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({
    y:     T + PH - f * PH,
    label: `${sym}${Math.round(minV + f * (maxV - minV)).toLocaleString('en-US')}`,
  }))

  const clipId = `cdl-lt-${country}`

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <clipPath id={clipId}>
          <rect x={L} y={T} width={PW} height={PH} />
        </clipPath>
      </defs>

      {/* Y gridlines + labels */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={L} y1={t.y} x2={L + PW} y2={t.y} stroke="#e4eef3" strokeWidth={1} />
          <text x={L - 5} y={t.y + 4} textAnchor="end" fontSize={10} fill="#8a97a5">{t.label}</text>
        </g>
      ))}
      {/* Zero gridline — heavier and darker when domain spans negative values */}
      {zeroLineY !== null && (
        <line x1={L} y1={zeroLineY} x2={L + PW} y2={zeroLineY} stroke="#64748b" strokeWidth={1.5} />
      )}

      {/* X ticks + labels */}
      {xTicks.map((t, i) => (
        <g key={i}>
          <line x1={t.x} y1={T + PH} x2={t.x} y2={T + PH + 4} stroke="#c8dfe9" strokeWidth={1} />
          <text x={t.x} y={T + PH + 15} textAnchor="middle" fontSize={9} fill="#8a97a5">{t.label}</text>
        </g>
      ))}

      {/* Axis borders */}
      <line x1={L} y1={T}      x2={L}      y2={T + PH} stroke="#c8dfe9" strokeWidth={1} />
      <line x1={L} y1={T + PH} x2={L + PW} y2={T + PH} stroke="#c8dfe9" strokeWidth={1} />

      {/* GP shaded fill */}
      <path d={gpFillPath} fill="#16a34a" fillOpacity={0.15} stroke="none" clipPath={`url(#${clipId})`} />

      {/* Three series lines */}
      <path d={polyline(spendPts)} fill="none" stroke="#e8825c" strokeWidth={2}   strokeOpacity={0.85} clipPath={`url(#${clipId})`} />
      <path d={polyline(salesPts)} fill="none" stroke="#0093d0" strokeWidth={2.5} clipPath={`url(#${clipId})`} />
      <path d={polyline(gpPts)}    fill="none" stroke="#15803d" strokeWidth={2.5} clipPath={`url(#${clipId})`} />

      {/* Value labels (RULING 1) — compact k-notation; above for sales+spend, below for GP */}
      {showValues && (
        <>
          {/* Sales labels: above point; flip to below if above-placement enters top band (y < T) */}
          {salesPts.map((p, i) => (
            <text key={`sv-${i}`} x={p.x} y={p.y - 12 < T ? p.y + 14 : p.y - 12} textAnchor="middle" fontSize={9} fill="#0093d0" style={{ pointerEvents: 'none' }}>
              {fmtK(points[i].sales12, sym)}
            </text>
          ))}
          {/* Spend labels: above point; same top-band flip rule */}
          {spendPts.map((p, i) => (
            <text key={`spv-${i}`} x={p.x} y={p.y - 12 < T ? p.y + 14 : p.y - 12} textAnchor="middle" fontSize={9} fill="#e8825c" style={{ pointerEvents: 'none' }}>
              {fmtK(points[i].spend12, sym)}
            </text>
          ))}
          {/* GP labels: below point; flip to above if below-placement enters bottom band (y > T+PH). */}
          {/* Root cause of €5.0k1: fixed y+14 placed label into x-axis tick zone; trailing '1' of */}
          {/* '2026-01' bled through. Fix: flip to above when p.y+14 > T+PH (= H-B = 228). */}
          {gpPts.map((p, i) => (
            <text key={`gpv-${i}`} x={p.x} y={p.y + 14 > T + PH ? p.y - 12 : p.y + 14} textAnchor="middle" fontSize={9} fill="#15803d" style={{ pointerEvents: 'none' }}>
              {fmtK(gpVals[i], sym)}
            </text>
          ))}
        </>
      )}

      {/* Inline legend — fixed in top band (y=16 < T=40), outside data area; series/labels cannot reach it */}
      <g transform={`translate(${L + PW - 336}, 16)`}>
        <line x1={0}   y1={5} x2={16}  y2={5} stroke="#0093d0" strokeWidth={2.5} />
        <text x={20}  y={9} fontSize={10} fill="#1a2b3c">Rolling-12 Sales</text>
        <line x1={130} y1={5} x2={146} y2={5} stroke="#e8825c" strokeWidth={2} strokeOpacity={0.85} />
        <text x={150} y={9} fontSize={10} fill="#1a2b3c">Rolling-12 Spend</text>
        <line x1={260} y1={5} x2={276} y2={5} stroke="#15803d" strokeWidth={2.5} />
        <text x={280} y={9} fontSize={10} fill="#1a2b3c">{gpLabel}</text>
      </g>
    </svg>
  )
}

// ── Public wrapper — manages tab state ──────────────────────────────────────
export default function LongTermSection({ markets }: { markets: LongTermMarket[] }) {
  const active = TAB_ORDER
    .map(cc => markets.find(m => m.country === cc))
    .filter((m): m is LongTermMarket => !!m && m.points.length > 0)

  const [tab, setTab]             = useState(active[0]?.country ?? 'ES')
  const [showValues, setShowValues] = useState(false)
  const current = active.find(m => m.country === tab) ?? active[0]

  if (!current) return null

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      {/* Tab bar + values toggle — styled like ChartSection's daily toggle */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #c8dfe9', marginBottom: '0.75rem' }}>
        {active.map(m => {
          const isActive = m.country === tab
          return (
            <button
              key={m.country}
              onClick={() => setTab(m.country)}
              style={{
                padding: '0.3rem 0.9rem',
                fontSize: '0.78rem',
                fontWeight: isActive ? 700 : 400,
                color: isActive ? 'var(--cdl-blue)' : 'var(--cdl-ink)',
                background: 'none',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--cdl-blue)' : '2px solid transparent',
                cursor: 'pointer',
                outline: 'none',
                marginBottom: -1,
              }}
            >
              {m.country}
            </button>
          )
        })}
        <label style={{
          marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
          fontSize: '0.68rem', color: 'var(--cdl-muted)', cursor: 'pointer',
          paddingRight: '0.5rem', paddingBottom: '0.1rem',
        }}>
          <input
            type="checkbox"
            checked={showValues}
            onChange={e => setShowValues(e.target.checked)}
            style={{ cursor: 'pointer', accentColor: 'var(--cdl-blue)' }}
          />
          values
        </label>
      </div>

      {/* Chart card */}
      <div style={{
        border: '1px solid #c8dfe9', borderRadius: 8,
        padding: '0.75rem 0.75rem 0.4rem', overflow: 'hidden',
      }}>
        <div style={{
          fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.07em', color: 'var(--cdl-muted)', marginBottom: '0.4rem',
        }}>
          Rolling-12 · {current.currency} · source: console exports - monthly - all ad types
        </div>
        <RollingChart market={current} showValues={showValues} />
      </div>
    </div>
  )
}
