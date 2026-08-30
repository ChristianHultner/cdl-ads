'use client'

// Long-term 12-month rolling chart for console_history with a standalone vendor_history overlay.
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
import styles from './DashboardZoneOne.module.css'

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

export interface VendorLongTermPoint {
  label:     string
  revenue12: number
  units12:   number
}

export interface VendorLongTermMarket {
  country:  string
  currency: string
  points:   VendorLongTermPoint[]
}

// ── SVG geometry — matches SalesSpendChart conventions ──────────────────────
const W = 900, H = 260
const L = 64, R = 14, T = 40, B = 32  // T=40: reserves top band (0–T) for legend; data area starts at T
const PW = W - L - R
const PH = H - T - B

const SYM: Record<string, string> = { EUR: '€', USD: '$', MXN: 'MX$', GBP: '£', CAD: 'CA$' }
const TAB_ORDER = ['ES', 'US', 'MX', 'UK', 'CA', 'DE', 'FR', 'IT']
const COUNTRY_NAMES: Record<string, string> = {
  CA: 'Canada', DE: 'Germany', ES: 'Spain', FR: 'France',
  IT: 'Italy', MX: 'Mexico', UK: 'United Kingdom', US: 'United States',
}

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
function RollingChart({
  market,
  vendor,
  showValues,
}: {
  market: LongTermMarket
  vendor?: VendorLongTermMarket
  showValues: boolean
}) {
  const { country, currency, gpPerOrder, points } = market
  const sym = SYM[currency] ?? currency
  const n   = points.length

  if (n === 0) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)', fontSize: '0.85rem' }}>
        No rolling-12 data (need 12 consecutive months)
      </div>
    )
  }

  const gpVals  = points.map(p => profileGP(gpPerOrder, p.orders12, p.sales12, p.spend12))
  const gpLabel = gpPerOrder != null ? 'Rolling-12 GP' : 'Rolling-12 GP (rev)'
  const pointIndex = new Map(points.map((point, index) => [point.label, index]))
  const vendorRevenue = vendor?.currency === currency
    ? vendor.points.flatMap(point => {
        const index = pointIndex.get(point.label)
        return index === undefined ? [] : [{ index, value: point.revenue12 }]
      })
    : []

  // Y-axis domain (RULING 2): per-market, no shared cross-market ceiling, no niceMax rounding.
  // yMax = 1.1 × this market's highest; yMin = min(0, 1.1 × this market's lowest).
  const rawMin = Math.min(
    ...points.map(p => p.spend12),
    ...points.map(p => p.sales12),
    ...gpVals,
    ...vendorRevenue.map(point => point.value),
  )
  const rawMax = Math.max(
    ...points.map(p => p.spend12),
    ...points.map(p => p.sales12),
    ...gpVals,
    ...vendorRevenue.map(point => point.value),
  )
  const minV   = Math.min(0, rawMin * 1.1)
  const maxV   = rawMax > 0 ? rawMax * 1.1 : 100
  // Zero gridline pre-computed; rendered heavier/darker only when domain spans negative values.
  const zeroLineY = minV < 0 ? ty(0, minV, maxV) : null

  const spendPts = points.map((p, i) => ({ x: tx(i, n), y: ty(p.spend12, minV, maxV) }))
  const salesPts = points.map((p, i) => ({ x: tx(i, n), y: ty(p.sales12, minV, maxV) }))
  const gpPts    = gpVals.map((v, i)  => ({ x: tx(i, n), y: ty(v,         minV, maxV) }))
  const vendorRevenuePts = vendorRevenue.map(point => ({
    x: tx(point.index, n),
    y: ty(point.value, minV, maxV),
  }))

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
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible', fontFamily: 'var(--font-ibm-plex-mono), monospace' }}>
      <defs>
        <clipPath id={clipId}>
          <rect x={L} y={T} width={PW} height={PH} />
        </clipPath>
      </defs>

      {/* Y gridlines + labels */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={L} y1={t.y} x2={L + PW} y2={t.y} stroke="var(--line)" strokeWidth={1} />
          <text x={L - 5} y={t.y + 4} textAnchor="end" fontSize={10} fill="var(--muted)">{t.label}</text>
        </g>
      ))}
      {/* Zero gridline — heavier and darker when domain spans negative values */}
      {zeroLineY !== null && (
        <line x1={L} y1={zeroLineY} x2={L + PW} y2={zeroLineY} stroke="var(--ink)" strokeWidth={1.5} />
      )}

      {/* X ticks + labels */}
      {xTicks.map((t, i) => (
        <g key={i}>
          <line x1={t.x} y1={T + PH} x2={t.x} y2={T + PH + 4} stroke="var(--line)" strokeWidth={1} />
          <text x={t.x} y={T + PH + 15} textAnchor="middle" fontSize={9} fill="var(--muted)">{t.label}</text>
        </g>
      ))}

      {/* Axis borders */}
      <line x1={L} y1={T}      x2={L}      y2={T + PH} stroke="var(--line)" strokeWidth={1} />
      <line x1={L} y1={T + PH} x2={L + PW} y2={T + PH} stroke="var(--line)" strokeWidth={1} />

      {/* GP shaded fill */}
      <path d={gpFillPath} fill="var(--pos)" fillOpacity={0.12} stroke="none" clipPath={`url(#${clipId})`} />

      {/* Console series + standalone vendor revenue overlay */}
      <path d={polyline(spendPts)} fill="none" stroke="var(--neg)" strokeWidth={2} strokeOpacity={0.85} clipPath={`url(#${clipId})`} />
      <path d={polyline(salesPts)} fill="none" stroke="var(--blue)" strokeWidth={2.5} clipPath={`url(#${clipId})`} />
      <path d={polyline(gpPts)}    fill="none" stroke="var(--pos)" strokeWidth={2.5} clipPath={`url(#${clipId})`} />
      {vendorRevenuePts.length > 0 && (
        <>
          <path
            d={polyline(vendorRevenuePts)}
            fill="none"
            stroke="#8a5bb8"
            strokeWidth={2.5}
            strokeDasharray="7 5"
            clipPath={`url(#${clipId})`}
          />
          {vendorRevenuePts.map((point, index) => (
            <circle key={`vr-${index}`} cx={point.x} cy={point.y} r={2.5} fill="#8a5bb8" />
          ))}
        </>
      )}

      {/* Value labels (RULING 1) — compact k-notation; above for sales+spend, below for GP */}
      {showValues && (
        <>
          {/* Sales labels: above point; flip to below if above-placement enters top band (y < T) */}
          {salesPts.map((p, i) => (
            <text key={`sv-${i}`} x={p.x} y={p.y - 12 < T ? p.y + 14 : p.y - 12} textAnchor="middle" fontSize={9} fill="var(--blue)" style={{ pointerEvents: 'none' }}>
              {fmtK(points[i].sales12, sym)}
            </text>
          ))}
          {/* Spend labels: above point; same top-band flip rule */}
          {spendPts.map((p, i) => (
            <text key={`spv-${i}`} x={p.x} y={p.y - 12 < T ? p.y + 14 : p.y - 12} textAnchor="middle" fontSize={9} fill="var(--neg)" style={{ pointerEvents: 'none' }}>
              {fmtK(points[i].spend12, sym)}
            </text>
          ))}
          {/* GP labels: below point; flip to above if below-placement enters bottom band (y > T+PH). */}
          {/* Root cause of €5.0k1: fixed y+14 placed label into x-axis tick zone; trailing '1' of */}
          {/* '2026-01' bled through. Fix: flip to above when p.y+14 > T+PH (= H-B = 228). */}
          {gpPts.map((p, i) => (
            <text key={`gpv-${i}`} x={p.x} y={p.y + 14 > T + PH ? p.y - 12 : p.y + 14} textAnchor="middle" fontSize={9} fill="var(--pos)" style={{ pointerEvents: 'none' }}>
              {fmtK(gpVals[i], sym)}
            </text>
          ))}
          {vendorRevenuePts.map((point, index) => (
            <text key={`vrv-${index}`} x={point.x} y={point.y - 12 < T ? point.y + 14 : point.y - 12} textAnchor="middle" fontSize={9} fill="#8a5bb8" style={{ pointerEvents: 'none' }}>
              {fmtK(vendorRevenue[index].value, sym)}
            </text>
          ))}
        </>
      )}

      {/* Inline legend — fixed in top band (y=16 < T=40), outside data area; series/labels cannot reach it */}
      <g transform={`translate(${L}, 16)`}>
        <line x1={0}   y1={5} x2={16}  y2={5} stroke="var(--blue)" strokeWidth={2.5} />
        <text x={20}  y={9} fontSize={10} fill="var(--ink)">Rolling-12 Sales</text>
        <line x1={130} y1={5} x2={146} y2={5} stroke="var(--neg)" strokeWidth={2} strokeOpacity={0.85} />
        <text x={150} y={9} fontSize={10} fill="var(--ink)">Rolling-12 Spend</text>
        <line x1={260} y1={5} x2={276} y2={5} stroke="var(--pos)" strokeWidth={2.5} />
        <text x={280} y={9} fontSize={10} fill="var(--ink)">{gpLabel}</text>
        {vendorRevenuePts.length > 0 && (
          <>
            <line x1={390} y1={5} x2={406} y2={5} stroke="#8a5bb8" strokeWidth={2.5} strokeDasharray="7 5" />
            <text x={410} y={9} fontSize={10} fill="var(--ink)">Rolling-12 Vendor Revenue (sell-in)</text>
          </>
        )}
      </g>
    </svg>
  )
}

const UH = 170, UT = 30, UB = 30
const UPH = UH - UT - UB

function UnitsPanel({
  market,
  vendor,
  showValues,
}: {
  market: LongTermMarket
  vendor: VendorLongTermMarket
  showValues: boolean
}) {
  const consoleIndex = new Map(market.points.map((point, index) => [point.label, { point, index }]))
  const points = vendor.points.flatMap(point => {
    const consolePoint = consoleIndex.get(point.label)
    return consolePoint
      ? [{
          label: point.label,
          index: consolePoint.index,
          vendorUnits: point.units12,
          attributedUnits: consolePoint.point.orders12,
        }]
      : []
  })

  if (points.length === 0) return null

  const maxV = Math.max(
    ...points.map(point => point.vendorUnits),
    ...points.map(point => point.attributedUnits),
  ) * 1.1 || 100
  const uy = (value: number) => UT + UPH - (value / maxV) * UPH
  const vendorPts = points.map(point => ({ x: tx(point.index, market.points.length), y: uy(point.vendorUnits) }))
  const attributedPts = points.map(point => ({ x: tx(point.index, market.points.length), y: uy(point.attributedUnits) }))
  const haloPath = [
    ...vendorPts.map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(1)},${point.y.toFixed(1)}`),
    ...[...attributedPts].reverse().map(point => `L${point.x.toFixed(1)},${point.y.toFixed(1)}`),
    'Z',
  ].join(' ')
  const yTicks = [0, 0.5, 1].map(fraction => ({
    y: UT + UPH - fraction * UPH,
    label: Math.round(fraction * maxV).toLocaleString('en-US'),
  }))
  const clipId = `cdl-lt-units-${market.country}`

  return (
    <svg viewBox={`0 0 ${W} ${UH}`} width="100%" style={{ display: 'block', overflow: 'visible', fontFamily: 'var(--font-ibm-plex-mono), monospace' }}>
      <defs>
        <clipPath id={clipId}>
          <rect x={L} y={UT} width={PW} height={UPH} />
        </clipPath>
      </defs>

      {yTicks.map((tick, index) => (
        <g key={index}>
          <line x1={L} y1={tick.y} x2={L + PW} y2={tick.y} stroke="var(--line)" strokeWidth={1} />
          <text x={L - 5} y={tick.y + 4} textAnchor="end" fontSize={10} fill="var(--muted)">{tick.label}</text>
        </g>
      ))}
      {points.map((point, index) => {
        const x = tx(point.index, market.points.length)
        return (
          <g key={point.label}>
            <line x1={x} y1={UT + UPH} x2={x} y2={UT + UPH + 4} stroke="var(--line)" strokeWidth={1} />
            <text x={x} y={UT + UPH + 15} textAnchor="middle" fontSize={9} fill="var(--muted)">{point.label}</text>
          </g>
        )
      })}

      <line x1={L} y1={UT} x2={L} y2={UT + UPH} stroke="var(--line)" strokeWidth={1} />
      <line x1={L} y1={UT + UPH} x2={L + PW} y2={UT + UPH} stroke="var(--line)" strokeWidth={1} />
      <path d={haloPath} fill="#8a5bb8" fillOpacity={0.10} stroke="none" clipPath={`url(#${clipId})`} />
      <path d={polyline(attributedPts)} fill="none" stroke="var(--blue)" strokeWidth={2.25} clipPath={`url(#${clipId})`} />
      <path d={polyline(vendorPts)} fill="none" stroke="#8a5bb8" strokeWidth={2.5} strokeDasharray="7 5" clipPath={`url(#${clipId})`} />
      {attributedPts.map((point, index) => (
        <circle key={`au-${index}`} cx={point.x} cy={point.y} r={2.5} fill="var(--blue)" />
      ))}
      {vendorPts.map((point, index) => (
        <circle key={`vu-${index}`} cx={point.x} cy={point.y} r={2.5} fill="#8a5bb8" />
      ))}

      {showValues && points.map((point, index) => (
        <g key={`uv-${point.label}`}>
          <text x={vendorPts[index].x} y={vendorPts[index].y - 9} textAnchor="middle" fontSize={9} fill="#8a5bb8">
            {point.vendorUnits.toLocaleString('en-US')}
          </text>
          <text x={attributedPts[index].x} y={attributedPts[index].y + 14} textAnchor="middle" fontSize={9} fill="var(--blue)">
            {point.attributedUnits.toLocaleString('en-US')}
          </text>
        </g>
      ))}

      <g transform={`translate(${L}, 12)`}>
        <line x1={0} y1={5} x2={16} y2={5} stroke="#8a5bb8" strokeWidth={2.5} strokeDasharray="7 5" />
        <text x={20} y={9} fontSize={10} fill="var(--ink)">Vendor units (sell-in)</text>
        <line x1={150} y1={5} x2={166} y2={5} stroke="var(--blue)" strokeWidth={2.25} />
        <text x={170} y={9} fontSize={10} fill="var(--ink)">Attributed orders</text>
        <text x={290} y={9} fontSize={10} fill="var(--muted)">gap = un-attributed volume</text>
      </g>
    </svg>
  )
}

// ── Public wrapper — manages tab state ──────────────────────────────────────
export default function LongTermSection({
  markets,
  vendorMarkets,
}: {
  markets: LongTermMarket[]
  vendorMarkets: VendorLongTermMarket[]
}) {
  const active = TAB_ORDER
    .map(cc => markets.find(m => m.country === cc))
    .filter((m): m is LongTermMarket => !!m && m.points.length > 0)

  const [tab, setTab]             = useState(active[0]?.country ?? 'ES')
  const [showValues, setShowValues] = useState(false)
  const current = active.find(m => m.country === tab) ?? active[0]
  const currentVendor = vendorMarkets.find(m => m.country === current?.country)

  if (!current) return null

  const latestVendorPoint = currentVendor?.points.at(-1)
  const latestConsolePoint = latestVendorPoint
    ? current.points.find(point => point.label === latestVendorPoint.label)
    : undefined
  const unitsCaption = latestVendorPoint && latestConsolePoint
    ? `Amazon bought ${Math.round(latestVendorPoint.units12).toLocaleString('en-US')} books; ads claim ${Math.round(latestConsolePoint.orders12).toLocaleString('en-US')} orders. The gap is the rest of your business.`
    : 'Amazon sell-in and attributed orders, shown separately. The gap is the rest of your business.'

  return (
    <div className={styles.chartSection}>
      {/* Tab bar + values toggle — styled like ChartSection's daily toggle */}
      <div className={styles.chartTabs}>
        {active.map(m => {
          const isActive = m.country === tab
          return (
            <button
              key={m.country}
              onClick={() => setTab(m.country)}
              className={`${styles.chartTab} ${isActive ? styles.chartTabActive : ''}`}
            >
              {m.country}
            </button>
          )
        })}
        <label className={styles.chartToggle}>
          <input
            type="checkbox"
            checked={showValues}
            onChange={e => setShowValues(e.target.checked)}
            className={styles.chartCheckbox}
          />
          values
        </label>
      </div>

      {/* Chart card */}
      <div className={styles.chartPanel}>
        <h3 className={styles.panelTitle}>{COUNTRY_NAMES[current.country] ?? current.country}, rolling 12 months</h3>
        <div className={styles.panelCaption}>Each point is a full year ending that month — seasonality removed.</div>
        <RollingChart market={current} vendor={currentVendor} showValues={showValues} />
        <div className={styles.panelSource}>sources: console exports (all ad types){currentVendor ? ' · vendor invoices (sell-in)' : ''}</div>
      </div>
      {currentVendor && (
        <div className={styles.chartPanel}>
          <h3 className={styles.panelTitle}>What ads can&apos;t see · {COUNTRY_NAMES[current.country] ?? current.country}</h3>
          <div className={styles.panelCaption}>{unitsCaption}</div>
          <UnitsPanel market={current} vendor={currentVendor} showValues={showValues} />
          <div className={styles.panelSource}>sources: vendor invoices (sell-in) · console exports (all ad types) · read quarterly</div>
        </div>
      )}
    </div>
  )
}
