// ACoS line chart, 900×160 viewBox. Dashed reference line at profile target_acos.
// Rolling ACoS = rolling_spend / rolling_sales (ratio of sums, NOT avg of daily ratios).
// Daily faint line behind rolling bold line. Receives up to 120 days; plots last 90.

import type { ChartPoint } from './SalesSpendChart'

const W = 900, H = 160
const L = 50, R = 56, T = 10, B = 28
const PW = W - L - R
const PH = H - T - B
const PLOT_DAYS = 90
const ROLL_WIN  = 30

function tx(i: number, n: number) { return n <= 1 ? L : L + (i / (n - 1)) * PW }
function ty(v: number, maxV: number) {
  if (maxV === 0) return T + PH
  return T + PH - Math.min(v / maxV, 1.05) * PH
}
function polyline(pts: { x: number; y: number }[]) {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

// Rolling ACoS: ratio of rolling spend sum / rolling sales sum — never avg of ratios
function rollingAcosArr(points: ChartPoint[], window: number): (number | null)[] {
  return points.map((_, i) => {
    const start = Math.max(0, i - window + 1)
    const slice = points.slice(start, i + 1)
    const spend = slice.reduce((a, b) => a + b.spend, 0)
    const sales = slice.reduce((a, b) => a + b.sales, 0)
    return sales > 0 ? spend / sales : null
  })
}

// Split a sequence of nullable points into contiguous non-null segments for polyline
function segments(
  n: number,
  getValue: (i: number) => number | null,
  getX: (i: number) => number,
  getY: (v: number) => number,
): { x: number; y: number }[][] {
  const result: { x: number; y: number }[][] = []
  let seg: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const v = getValue(i)
    if (v !== null) {
      seg.push({ x: getX(i), y: getY(v) })
    } else {
      if (seg.length > 1) result.push(seg)
      seg = []
    }
  }
  if (seg.length > 1) result.push(seg)
  return result
}

export default function AcosChart({ points, targetAcos }: { points: ChartPoint[]; targetAcos: number }) {
  if (points.length === 0) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cdl-muted)', fontSize: '0.85rem' }}>
        No ACoS data
      </div>
    )
  }

  // Compute rolling over full input, take last PLOT_DAYS for display
  const rollAll  = rollingAcosArr(points, ROLL_WIN)
  const plot     = points.slice(-PLOT_DAYS)
  const rollPlot = rollAll.slice(-PLOT_DAYS)
  const n        = plot.length

  const validRoll = rollPlot.filter((v): v is number => v !== null)
  if (validRoll.length === 0) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cdl-muted)', fontSize: '0.85rem' }}>
        No ACoS data
      </div>
    )
  }

  const peak = Math.max(...validRoll, targetAcos)
  const maxV = Math.min(peak * 1.2, 2.5)   // cap at 250% — avoids degenerate scale

  const refY = ty(targetAcos, maxV)

  const dailySegs = segments(n, i => plot[i].acos,   i => tx(i, n), v => ty(v, maxV))
  const rollSegs  = segments(n, i => rollPlot[i],     i => tx(i, n), v => ty(v, maxV))

  // Weekly x-ticks
  const xTicks: { x: number; label: string }[] = []
  for (let i = 0; i < n; i += 7) {
    const d = new Date(plot[i].date + 'T00:00:00Z')
    xTicks.push({
      x: tx(i, n),
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    })
  }

  // Y ticks: 0 / 50% / 100% of scale
  const yTicks = [0, 0.5, 1].map(f => ({
    y: T + PH - f * PH,
    label: `${(f * maxV * 100).toFixed(0)}%`,
  }))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible' }}>
      {/* Gridlines + Y labels */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={L} y1={t.y} x2={L + PW} y2={t.y} stroke="#e4eef3" strokeWidth={1} />
          <text x={L - 4} y={t.y + 4} textAnchor="end" fontSize={9.5} fill="#8a97a5">{t.label}</text>
        </g>
      ))}

      {/* Target ACoS reference line */}
      <line x1={L} y1={refY} x2={L + PW} y2={refY} stroke="#8a97a5" strokeWidth={1.2} strokeDasharray="5 3" />
      <text x={L + PW + 4} y={refY + 4} fontSize={9.5} fill="#8a97a5" dominantBaseline="middle">
        target {(targetAcos * 100).toFixed(0)}%
      </text>

      {/* X ticks */}
      {xTicks.map((t, i) => (
        <g key={i}>
          <line x1={t.x} y1={T + PH} x2={t.x} y2={T + PH + 4} stroke="#c8dfe9" strokeWidth={1} />
          <text x={t.x} y={T + PH + 15} textAnchor="middle" fontSize={9.5} fill="#8a97a5">{t.label}</text>
        </g>
      ))}

      {/* Axes */}
      <line x1={L} y1={T} x2={L} y2={T + PH} stroke="#c8dfe9" strokeWidth={1} />
      <line x1={L} y1={T + PH} x2={L + PW} y2={T + PH} stroke="#c8dfe9" strokeWidth={1} />

      {/* Daily faint lines */}
      {dailySegs.map((seg, i) => (
        <path key={i} d={polyline(seg)} fill="none" stroke="var(--cdl-blue)" strokeWidth={1} strokeOpacity={0.25} />
      ))}

      {/* Rolling bold lines */}
      {rollSegs.map((seg, i) => (
        <path key={i} d={polyline(seg)} fill="none" stroke="var(--cdl-blue)" strokeWidth={2} />
      ))}
    </svg>
  )
}
