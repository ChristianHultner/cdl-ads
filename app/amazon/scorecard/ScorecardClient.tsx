'use client'

import { useState } from 'react'
import type { AcosContributionResult } from '@/app/lib/scorecard'

// ── Serialisable types (server → client boundary) ──────────────────────────────
export interface PanelCounts {
  WIN: number; PARTIAL: number; LEAK: number; 'NO-DATA': number
}
export interface PanelPerRec {
  id: string | number; market: string; direction?: string; verdict: string; note?: string
}
export interface PanelAcosGroup {
  beforeMedian: number | null; afterMedian: number | null; n: number
}
export interface PanelAcosData {
  cut: PanelAcosGroup; raise: PanelAcosGroup
}
export interface PanelData {
  key:             string
  label:           string
  recType:         string
  counts:          PanelCounts
  n:               number
  dn:              number
  medianEurosStopped?: number | null
  acosData?:       PanelAcosData
  perRec?:         PanelPerRec[]
  adaptationNote?: string
  subtitle?:       string
}
export interface TilePayload {
  key: string; label: string; winPct: number | null; dn: number
  usedHorizon: string | null; matureDate: string | null; panelKey: string
  subtitle?: string
}
export interface MatrixRow   { key: string; label: string }
export interface MatrixCellData { dn: number; winPct: number | null; panelKey: string }
export interface SmallCohortEntry { rt: string; n: number; summary: string }

// ── Visual helpers ─────────────────────────────────────────────────────────────
interface ChipCfg { label: string; bg: string; color: string }
function chipConfig(winPct: number | null, dn: number): ChipCfg {
  if (dn === 0 || winPct === null)
    return { label: 'UNGRADED',   bg: 'rgba(138,151,165,0.18)', color: 'var(--cdl-muted)' }
  if (winPct >= 75)
    return { label: 'EXCELLENT',  bg: 'rgba(26,127,78,0.15)',   color: 'var(--cdl-ok)'   }
  if (winPct >= 50)
    return { label: 'GOOD',       bg: 'rgba(0,148,133,0.15)',   color: '#009485'          }
  if (winPct >= 25)
    return { label: 'NEEDS WORK', bg: 'rgba(230,168,23,0.15)',  color: '#a07010'          }
  return   { label: 'NEEDS WORK', bg: 'rgba(192,57,43,0.15)',   color: 'var(--cdl-warn)'  }
}
function cellBg(winPct: number | null, dn: number): string {
  if (dn === 0 || winPct === null) return '#eff1f3'
  const hue = Math.round(Math.min(100, Math.max(0, winPct)) / 100 * 120)
  return `hsl(${hue}, 58%, 87%)`
}
function cellFg(winPct: number | null, dn: number): string {
  if (dn === 0 || winPct === null) return '#8a97a5'
  const hue = Math.round(Math.min(100, Math.max(0, winPct)) / 100 * 120)
  return `hsl(${hue}, 52%, 26%)`
}

// ── VerdictTile ────────────────────────────────────────────────────────────────
function VerdictTile({ t, active, onClick }: {
  t: TilePayload; active: boolean; onClick: () => void
}) {
  const chip = chipConfig(t.winPct, t.dn)
  return (
    <button onClick={onClick} style={{
      border: active ? '2px solid var(--cdl-blue)' : '1px solid #c8dfe9',
      borderRadius: '8px',
      padding: active ? 'calc(0.85rem - 1px) calc(1rem - 1px)' : '0.85rem 1rem',
      background: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,.06)',
      display: 'flex', flexDirection: 'column', gap: '0.3rem',
      cursor: 'pointer', textAlign: 'left', width: '100%',
    }}>
      <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--cdl-muted)' }}>
        {t.label}
      </div>
      {t.subtitle && (
        <div style={{ fontSize: '0.67rem', color: 'var(--cdl-muted)', fontStyle: 'italic', lineHeight: 1.35 }}>
          {t.subtitle}
        </div>
      )}
      <div style={{ fontSize: '1.9rem', fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums', color: chip.color }}>
        {t.winPct !== null ? t.winPct.toFixed(1) + '%' : '—'}
      </div>
      <div style={{ fontSize: '0.7rem', color: 'var(--cdl-muted)' }}>
        graded n=<span style={{ fontWeight: 600 }}>{t.dn}</span>
      </div>
      <div style={{
        display: 'inline-block', alignSelf: 'flex-start',
        padding: '2px 7px', borderRadius: '4px',
        fontSize: '0.65rem', fontWeight: 700, letterSpacing: '0.04em',
        background: chip.bg, color: chip.color,
      }}>{chip.label}</div>
      {t.usedHorizon && (
        <div style={{ fontSize: '0.68rem', color: 'var(--cdl-muted)', fontStyle: 'italic', marginTop: '0.1rem' }}>
          {t.usedHorizon}{t.matureDate ? ` · matures ${t.matureDate}` : ''}
        </div>
      )}
    </button>
  )
}

// ── HeatmapMatrix ──────────────────────────────────────────────────────────────
function HeatmapMatrix({ rows, markets, cells, activePanelKey, onCellClick }: {
  rows:           MatrixRow[]
  markets:        string[]
  cells:          Record<string, MatrixCellData>
  activePanelKey: string | null
  onCellClick:    (panelKey: string) => void
}) {
  if (markets.length === 0) {
    return (
      <div className="table-card" style={{ padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>
        <p style={{ color: 'var(--cdl-muted)', margin: 0 }}>No market data available.</p>
      </div>
    )
  }
  return (
    <div className="table-card" style={{ padding: '1rem 1.25rem', marginBottom: '1.25rem', overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'separate', borderSpacing: '3px', width: '100%', tableLayout: 'auto' }}>
        <thead>
          <tr>
            <th style={{
              textAlign: 'left', padding: '0.25rem 0.6rem',
              fontSize: '0.68rem', fontWeight: 700, color: 'var(--cdl-muted)',
              textTransform: 'uppercase', letterSpacing: '0.06em', whiteSpace: 'nowrap',
            }}>Rule</th>
            {markets.map(mkt => (
              <th key={mkt} style={{
                textAlign: 'center', padding: '0.25rem 0.5rem',
                fontSize: '0.72rem', fontWeight: 700, color: 'var(--cdl-muted)',
                textTransform: 'uppercase', letterSpacing: '0.07em',
              }}>{mkt}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key}>
              <td style={{
                padding: '0.25rem 0.6rem', fontSize: '0.7rem', fontWeight: 700,
                color: 'var(--cdl-muted)', textTransform: 'uppercase',
                letterSpacing: '0.04em', whiteSpace: 'nowrap',
              }}>{row.label}</td>
              {markets.map(mkt => {
                const cellKey = `${row.key}:${mkt}`
                const cell    = cells[cellKey] ?? { dn: 0, winPct: null, panelKey: '' }
                const small   = cell.dn > 0 && cell.dn < 5
                const active  = !!cell.panelKey && activePanelKey === cell.panelKey
                return (
                  <td key={mkt} style={{ padding: '2px', verticalAlign: 'top' }}>
                    <button
                      onClick={() => cell.panelKey && onCellClick(cell.panelKey)}
                      style={{
                        background:   cellBg(cell.winPct, cell.dn),
                        borderRadius: '5px',
                        border:       active ? '2px solid var(--cdl-blue)' : '2px solid transparent',
                        padding:      '0.38rem 0.55rem',
                        textAlign:    'center',
                        minWidth:     '5rem',
                        opacity:      small ? 0.55 : 1,
                        cursor:       cell.panelKey ? 'pointer' : 'default',
                        display:      'block', width: '100%',
                      }}
                    >
                      <div style={{
                        fontSize: '0.75rem', fontWeight: 700,
                        color: cellFg(cell.winPct, cell.dn),
                        fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap',
                      }}>
                        {cell.dn > 0 ? `${cell.winPct!.toFixed(1)}% · n${cell.dn}` : '—'}
                      </div>
                      {small && (
                        <div style={{
                          fontSize: '0.58rem', fontWeight: 700, marginTop: '1px',
                          color: cellFg(cell.winPct, cell.dn), letterSpacing: '0.03em',
                        }}>n&lt;5</div>
                      )}
                    </button>
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ── StackedBarPanel ────────────────────────────────────────────────────────────
function StackedBarPanel({ counts, n, dn }: { counts: PanelCounts; n: number; dn: number }) {
  const fmt = (v: number, d: number) => d > 0 ? (v / d * 100).toFixed(1) + '%' : '—'
  if (dn === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.75rem' }}>
        <div style={{ flex: 1, height: '12px', borderRadius: '4px', background: 'rgba(138,151,165,0.25)' }} />
        <span style={{ fontSize: '0.75rem', color: 'var(--cdl-muted)' }}>all NO-DATA ({n})</span>
      </div>
    )
  }
  const wPct  = counts.WIN     / dn * 100
  const paPct = counts.PARTIAL / dn * 100
  const lPct  = counts.LEAK    / dn * 100
  const ndPct = counts['NO-DATA'] > 0 ? counts['NO-DATA'] / n * 100 : 0
  return (
    <div style={{ marginBottom: '0.85rem' }}>
      <div style={{ display: 'flex', height: '12px', borderRadius: '4px', overflow: 'hidden', background: 'rgba(138,151,165,0.18)' }}>
        {wPct  > 0 && <div style={{ width: `${wPct}%`,  background: 'var(--cdl-ok)',        flexShrink: 0 }} />}
        {paPct > 0 && <div style={{ width: `${paPct}%`, background: '#e6a817',               flexShrink: 0 }} />}
        {lPct  > 0 && <div style={{ width: `${lPct}%`,  background: 'var(--cdl-warn)',       flexShrink: 0 }} />}
        {ndPct > 0 && <div style={{ width: `${ndPct}%`, background: 'rgba(138,151,165,0.4)', flexShrink: 0 }} />}
      </div>
      <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.73rem', flexWrap: 'wrap', marginTop: '5px' }}>
        {counts.WIN     > 0 && <span style={{ color: 'var(--cdl-ok)'   }}>WIN {counts.WIN} ({fmt(counts.WIN, dn)})</span>}
        {counts.PARTIAL > 0 && <span style={{ color: '#a07010'         }}>PARTIAL {counts.PARTIAL} ({fmt(counts.PARTIAL, dn)})</span>}
        {counts.LEAK    > 0 && <span style={{ color: 'var(--cdl-warn)' }}>LEAK {counts.LEAK} ({fmt(counts.LEAK, dn)})</span>}
        {counts['NO-DATA'] > 0 && <span style={{ color: 'var(--cdl-muted)' }}>NO-DATA {counts['NO-DATA']}</span>}
        <span style={{ color: 'var(--cdl-muted)', marginLeft: 'auto' }}>n={n} · graded {dn}</span>
      </div>
    </div>
  )
}

// ── ACoS Dumbbell SVG ──────────────────────────────────────────────────────────
function AcosDumbbell({ acosData }: { acosData: PanelAcosData }) {
  const W = 340, H = 88, PL = 58, PR = 20, PT = 20, PB = 26
  const plotW = W - PL - PR

  const allVals = [
    acosData.cut.beforeMedian, acosData.cut.afterMedian,
    acosData.raise.beforeMedian, acosData.raise.afterMedian,
  ].filter((x): x is number => x !== null)

  if (allVals.length === 0)
    return <p style={{ fontSize: '0.75rem', color: 'var(--cdl-muted)', margin: '0.4rem 0' }}>No ACoS data</p>

  const xMax  = Math.max(...allVals) * 1.25
  const xs    = (v: number) => PL + (v / xMax) * plotW
  const yCut  = PT + (H - PT - PB) * 0.28
  const yRise = PT + (H - PT - PB) * 0.72
  const yAxis = H - PB

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(t => xMax * t)

  const Row = ({ label, before, after, y }: { label: string; before: number | null; after: number | null; y: number }) => {
    const xB = before != null ? xs(before) : null
    const xA = after  != null ? xs(after)  : null
    const improved = before != null && after != null ? after < before : null
    const lc = improved == null ? '#b0bec5' : improved ? '#1a7f4e' : '#c0392b'
    const dotAfterFill = improved === true ? '#1a7f4e' : improved === false ? '#c0392b' : '#64748b'
    return (
      <g>
        <text x={PL - 6} y={y + 4} textAnchor="end" fontSize="10" fill="#8a97a5" fontWeight="700">{label}</text>
        {xB != null && xA != null && <line x1={xB} y1={y} x2={xA} y2={y} stroke={lc} strokeWidth="2.5" />}
        {xB != null && <><circle cx={xB} cy={y} r="5" fill="#64748b" /><text x={xB} y={y - 8} textAnchor="middle" fontSize="9" fill="#64748b">{(before! * 100).toFixed(0)}%</text></>}
        {xA != null && <><circle cx={xA} cy={y} r="5" fill={dotAfterFill} /><text x={xA} y={y - 8} textAnchor="middle" fontSize="9" fill={lc}>{(after! * 100).toFixed(0)}%</text></>}
      </g>
    )
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: `${W}px`, display: 'block', overflow: 'visible' }}>
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={xs(t)} y1={PT} x2={xs(t)} y2={yAxis} stroke="#f0f2f4" strokeWidth="1" />
          <line x1={xs(t)} y1={yAxis} x2={xs(t)} y2={yAxis + 4} stroke="#d1d9e0" strokeWidth="1" />
          <text x={xs(t)} y={yAxis + 14} textAnchor="middle" fontSize="9" fill="#8a97a5">{(t * 100).toFixed(0)}%</text>
        </g>
      ))}
      <line x1={PL} y1={yAxis} x2={W - PR} y2={yAxis} stroke="#d1d9e0" strokeWidth="1" />
      <Row label="CUT"   before={acosData.cut.beforeMedian}   after={acosData.cut.afterMedian}   y={yCut} />
      <Row label="RAISE" before={acosData.raise.beforeMedian} after={acosData.raise.afterMedian} y={yRise} />
      <text x={W / 2} y={H + 2} textAnchor="middle" fontSize="9" fill="#8a97a5">ACoS median — ● before · ● after · green=improvement</text>
    </svg>
  )
}

// ── DrillPanel ─────────────────────────────────────────────────────────────────
function DrillPanel({ panel, onClose }: { panel: PanelData; onClose: () => void }) {
  const isNegate  = panel.recType === 'NEGATE_TERM' || panel.recType === 'NEGATE_TARGET'
  const isBid     = panel.recType === 'BID_ADJUST'
  const hasPerRec = panel.perRec && panel.perRec.length > 0

  return (
    <div style={{
      border: '1px solid var(--cdl-blue)', borderRadius: '8px',
      padding: '1.1rem 1.25rem', marginBottom: '1.25rem', background: '#f8fbfd',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.85rem', gap: '0.5rem' }}>
        <div style={{ fontSize: '0.82rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--cdl-blue)' }}>
          {panel.label}
        </div>
        <button onClick={onClose} aria-label="Close" style={{
          background: 'none', border: 'none', cursor: 'pointer',
          fontSize: '1.1rem', color: 'var(--cdl-muted)', lineHeight: 1, padding: '0 3px', flexShrink: 0,
        }}>×</button>
      </div>

      {/* Rule promise subtitle */}
      {panel.subtitle && (
        <p style={{ fontSize: '0.78rem', color: 'var(--cdl-muted)', fontStyle: 'italic', margin: '0 0 0.7rem', lineHeight: 1.45 }}>
          {panel.subtitle}
        </p>
      )}

      {/* Stacked bar */}
      <StackedBarPanel counts={panel.counts} n={panel.n} dn={panel.dn} />

      {/* Effect: median € stopped */}
      {isNegate && panel.medianEurosStopped != null && (
        <div style={{ marginBottom: '0.7rem', fontSize: '0.83rem' }}>
          <span style={{ color: 'var(--cdl-muted)', fontWeight: 700 }}>Median € stopped: </span>
          <span style={{
            fontWeight: 800, fontVariantNumeric: 'tabular-nums',
            color: panel.medianEurosStopped >= 0 ? 'var(--cdl-ok)' : 'var(--cdl-warn)',
          }}>
            €{panel.medianEurosStopped.toFixed(2)}
          </span>
        </div>
      )}

      {/* Effect: ACoS dumbbell */}
      {isBid && panel.acosData && (
        <div style={{ marginBottom: '0.7rem' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--cdl-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.4rem' }}>
            ACoS Before → After (cohort medians)
          </div>
          <AcosDumbbell acosData={panel.acosData} />
        </div>
      )}

      {/* Per-rec one-liners (n<5) */}
      {hasPerRec && (
        <div style={{ marginBottom: '0.7rem' }}>
          <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--cdl-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '0.3rem' }}>
            Per-rec (n&lt;5)
          </div>
          {panel.perRec!.map((r, i) => {
            const vc = r.verdict === 'WIN' ? 'var(--cdl-ok)' : r.verdict === 'PARTIAL' ? '#a07010' : r.verdict === 'LEAK' ? 'var(--cdl-warn)' : 'var(--cdl-muted)'
            return (
              <div key={i} style={{ fontSize: '0.78rem', display: 'flex', gap: '0.45rem', marginBottom: '2px', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--cdl-muted)', fontVariantNumeric: 'tabular-nums' }}>#{r.id}</span>
                <span style={{ fontWeight: 600, color: 'var(--cdl-muted)' }}>[{r.market}]</span>
                {r.direction && <span style={{ color: 'var(--cdl-blue)' }}>[{r.direction}]</span>}
                <span style={{ fontWeight: 700, color: vc }}>{r.verdict}</span>
                {r.note && <span style={{ color: 'var(--cdl-muted)', fontStyle: 'italic' }}>{r.note}</span>}
              </div>
            )
          })}
        </div>
      )}

      {/* Adaptation / honesty note */}
      {panel.adaptationNote && (
        <p style={{
          fontSize: '0.71rem', color: 'var(--cdl-muted)', fontStyle: 'italic',
          margin: 0, lineHeight: 1.55, borderTop: '1px solid #dce8f0', paddingTop: '0.5rem',
        }}>
          ⚠ {panel.adaptationNote}
        </p>
      )}
    </div>
  )
}

// ── AcosContributionPanel ──────────────────────────────────────────────────────
function currencySymbol(cur: string): string {
  const MAP: Record<string, string> = { EUR: '€', GBP: '£', USD: '$', MXN: 'MX$', CAD: 'C$' }
  return MAP[cur] ?? cur
}

function AcosContributionPanel({ data }: { data: AcosContributionResult }) {
  const months = [...new Set([
    ...Object.keys(data.estate),
    ...Object.values(data.byMarket).flatMap(m => Object.keys(m)),
  ])].sort()

  const [selMonth, setSelMonth] = useState<string>(months[months.length - 1] ?? '')
  if (months.length === 0) return null
  const month   = selMonth || months[months.length - 1]
  const markets = Object.keys(data.byMarket).filter(m => data.byMarket[m][month]).sort()
  const est     = data.estate[month]

  const fmtAmt = (n: number, cur: string) => `${currencySymbol(cur)}${n.toFixed(2)}`
  const fmtPts = (n: number | null) => n != null ? `≈${n.toFixed(1)} pts ACoS` : 'no sales data'
  const fmtD   = (n: number | null, label: string) =>
    n != null ? `${label} Δ${(n * 100).toFixed(1)}pp` : null

  return (
    <div className="table-card" style={{ padding: '0.85rem 1.25rem', marginBottom: '1.25rem' }}>
      {/* Header + month toggle */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.55rem' }}>
        <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--cdl-muted)' }}>
          ACoS impact
          <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: '0.5rem', fontStyle: 'italic' }}>
            estimated contribution — negations attributable, bid deltas directional
          </span>
        </div>
        {months.length > 1 && (
          <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
            {months.map(m => (
              <button key={m} onClick={() => setSelMonth(m)} style={{
                fontSize: '0.68rem', fontWeight: 700, padding: '2px 8px', borderRadius: '4px',
                border: m === month ? '1px solid var(--cdl-blue)' : '1px solid #c8dfe9',
                background: m === month ? 'var(--cdl-blue)' : 'transparent',
                color: m === month ? '#fff' : 'var(--cdl-muted)', cursor: 'pointer',
              }}>{m}</button>
            ))}
          </div>
        )}
      </div>

      {/* Estate total — per-currency sums, no blended points */}
      {est && (
        <div style={{ fontSize: '0.82rem', fontWeight: 700, marginBottom: '0.35rem', paddingBottom: '0.35rem', borderBottom: '1px solid #edf2f5' }}>
          {'Estate: '}
          {Object.entries(est.byCurrency).sort().map(([cur, amt], i) => (
            <span key={cur}>{i > 0 ? ' − ' : '−'}{fmtAmt(amt, cur)}</span>
          ))}
          {' removed'}
          {[fmtD(est.bid_raise_delta_med, 'raises'), fmtD(est.bid_cut_delta_med, 'cuts')].filter(Boolean).map((s, i) => (
            <span key={i} style={{ fontWeight: 400, color: 'var(--cdl-muted)', marginLeft: '0.4rem' }}>· {s}</span>
          ))}
          <span style={{ fontWeight: 400, color: 'var(--cdl-muted)', marginLeft: '0.4rem' }}>· {est.n_actions} actions</span>
        </div>
      )}

      {/* Per-market rows — native currency symbol, same-currency ACoS points */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.2rem' }}>
        {markets.map(mkt => {
          const e = data.byMarket[mkt][month]
          if (!e) return null
          return (
            <div key={mkt} style={{ fontSize: '0.78rem', display: 'flex', gap: '0.3rem', flexWrap: 'wrap', alignItems: 'baseline' }}>
              <span style={{ fontWeight: 700, fontSize: '0.7rem', color: 'var(--cdl-muted)', textTransform: 'uppercase', minWidth: '2.5rem' }}>{mkt}</span>
              <span>{'−'}{fmtAmt(e.spend_stopped, e.currency)}{' dead spend removed ('}{fmtPts(e.est_acos_points)}{')'}</span>
              {[fmtD(e.bid_raise_delta_med, 'raises'), fmtD(e.bid_cut_delta_med, 'cuts')].filter(Boolean).map((s, i) => (
                <span key={i} style={{ color: 'var(--cdl-muted)' }}>· {s}</span>
              ))}
              <span style={{ color: 'var(--cdl-muted)' }}>· {e.n_actions} actions</span>
            </div>
          )
        })}
        {markets.length === 0 && (
          <div style={{ fontSize: '0.75rem', color: 'var(--cdl-muted)', fontStyle: 'italic' }}>No WIN/PARTIAL negations or bid adjustments for {month}.</div>
        )}
      </div>
    </div>
  )
}

// ── SmallCohortsPanel ──────────────────────────────────────────────────────────
function SmallCohortsPanel({ entries }: { entries: SmallCohortEntry[] }) {
  if (entries.length === 0) return null
  return (
    <div className="table-card" style={{ padding: '0.85rem 1.25rem', marginBottom: '1.25rem' }}>
      <div style={{ fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--cdl-muted)', marginBottom: '0.55rem' }}>
        Small cohorts
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.28rem' }}>
        {entries.map(e => (
          <div key={e.rt} style={{ display: 'flex', gap: '0.75rem', alignItems: 'baseline', flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: '0.68rem', color: 'var(--cdl-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', minWidth: '11rem' }}>
              {e.rt}
            </span>
            <span style={{ fontSize: '0.72rem', color: 'var(--cdl-muted)', minWidth: '3rem' }}>n={e.n}</span>
            <span style={{ fontSize: '0.78rem' }}>{e.summary}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Root client component ──────────────────────────────────────────────────────
export default function ScorecardClient({
  tiles,
  matrixRows,
  matrixMarkets,
  matrixCells,
  panelDataMap,
  smallCohorts,
  acosContribution,
}: {
  tiles:             TilePayload[]
  matrixRows:        MatrixRow[]
  matrixMarkets:     string[]
  matrixCells:       Record<string, MatrixCellData>
  panelDataMap:      Record<string, PanelData>
  smallCohorts:      SmallCohortEntry[]
  acosContribution?: AcosContributionResult
}) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const toggle = (k: string) => setOpenKey(prev => prev === k ? null : k)
  const openPanel = openKey ? (panelDataMap[openKey] ?? null) : null

  return (
    <>
      {/* Verdict tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem', marginBottom: '2rem' }}>
        {tiles.map(t => (
          <VerdictTile key={t.key} t={t} active={openKey === t.panelKey} onClick={() => toggle(t.panelKey)} />
        ))}
      </div>

      {/* Heatmap matrix */}
      <HeatmapMatrix
        rows={matrixRows}
        markets={matrixMarkets}
        cells={matrixCells}
        activePanelKey={openKey}
        onCellClick={toggle}
      />

      {/* Drill-down panel — below the matrix, one at a time */}
      {openPanel && <DrillPanel panel={openPanel} onClose={() => setOpenKey(null)} />}

      {/* ACoS impact panel — between matrix and small cohorts */}
      {acosContribution && Object.keys(acosContribution.estate).length > 0 && (
        <AcosContributionPanel data={acosContribution} />
      )}

      {/* Small cohorts */}
      <SmallCohortsPanel entries={smallCohorts} />
    </>
  )
}
