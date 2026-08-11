// Inline SVG sales + spend line chart. No chart library. 900×260 viewBox.
// Receives up to 120 days; plots last 90 with 30-day rolling averages (bold).
// Daily values shown as faint thin lines (~25% opacity) behind the rolling pair.
// Rolling window = 30: each plotted point = mean of that day + prior 29.

export interface ChartPoint {
  date:  string        // YYYY-MM-DD
  sales: number
  spend: number
  acos:  number | null
}

const W = 900, H = 260
const L = 64, R = 14, T = 14, B = 32
const PW = W - L - R
const PH = H - T - B
const PLOT_DAYS = 90
const ROLL_WIN  = 30

function tx(i: number, n: number) { return n <= 1 ? L : L + (i / (n - 1)) * PW }
function ty(v: number, maxV: number) {
  if (maxV === 0) return T + PH
  return T + PH - (v / maxV) * PH
}
function polyline(pts: { x: number; y: number }[]) {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}
function niceMax(v: number): number {
  if (v <= 0) return 100
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const candidates = [1, 2, 2.5, 5, 10].map(f => f * mag)
  return candidates.find(c => c >= v) ?? v * 1.1
}
function rollingAvg(vals: number[], window: number): number[] {
  return vals.map((_, i) => {
    const start = Math.max(0, i - window + 1)
    const slice = vals.slice(start, i + 1)
    return slice.reduce((a, b) => a + b, 0) / slice.length
  })
}

const SYM: Record<string, string> = { EUR: '€', USD: '$', MXN: 'MX$', GBP: '£', CAD: 'CA$' }

export default function SalesSpendChart({ points, currency }: { points: ChartPoint[]; currency: string }) {
  if (points.length === 0) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cdl-muted)', fontSize: '0.85rem' }}>
        No data
      </div>
    )
  }

  // Compute rolling over full input (up to 120 days), slice to last 90 for plotting
  const rollSalesAll = rollingAvg(points.map(p => p.sales), ROLL_WIN)
  const rollSpendAll = rollingAvg(points.map(p => p.spend), ROLL_WIN)
  const plot         = points.slice(-PLOT_DAYS)
  const rSalesPlot   = rollSalesAll.slice(-PLOT_DAYS)
  const rSpendPlot   = rollSpendAll.slice(-PLOT_DAYS)
  const n            = plot.length

  const sym  = SYM[currency] ?? currency
  const maxV = niceMax(Math.max(
    ...rSalesPlot, ...rSpendPlot,
    ...plot.map(p => p.sales), ...plot.map(p => p.spend),
  ))

  // Daily faint points
  const dailySalePts  = plot.map((p, i) => ({ x: tx(i, n), y: ty(p.sales, maxV) }))
  const dailySpendPts = plot.map((p, i) => ({ x: tx(i, n), y: ty(p.spend, maxV) }))
  // Rolling bold points
  const rollSalePts   = rSalesPlot.map((v, i) => ({ x: tx(i, n), y: ty(v, maxV) }))
  const rollSpendPts  = rSpendPlot.map((v, i) => ({ x: tx(i, n), y: ty(v, maxV) }))

  // Weekly x-ticks
  const xTicks: { x: number; label: string }[] = []
  for (let i = 0; i < n; i += 7) {
    const d = new Date(plot[i].date + 'T00:00:00Z')
    xTicks.push({
      x: tx(i, n),
      label: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }),
    })
  }

  // Y-axis ticks (0 / 25% / 50% / 75% / 100%)
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map(f => ({
    y: T + PH - f * PH,
    label: `${sym}${Math.round(f * maxV).toLocaleString('en-US')}`,
  }))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: 'block', overflow: 'visible' }}>
      {/* Y gridlines + labels */}
      {yTicks.map((t, i) => (
        <g key={i}>
          <line x1={L} y1={t.y} x2={L + PW} y2={t.y} stroke="#e4eef3" strokeWidth={1} />
          <text x={L - 5} y={t.y + 4} textAnchor="end" fontSize={10} fill="#8a97a5">{t.label}</text>
        </g>
      ))}

      {/* X ticks + labels */}
      {xTicks.map((t, i) => (
        <g key={i}>
          <line x1={t.x} y1={T + PH} x2={t.x} y2={T + PH + 4} stroke="#c8dfe9" strokeWidth={1} />
          <text x={t.x} y={T + PH + 15} textAnchor="middle" fontSize={9.5} fill="#8a97a5">{t.label}</text>
        </g>
      ))}

      {/* Axis borders */}
      <line x1={L} y1={T} x2={L} y2={T + PH} stroke="#c8dfe9" strokeWidth={1} />
      <line x1={L} y1={T + PH} x2={L + PW} y2={T + PH} stroke="#c8dfe9" strokeWidth={1} />

      {/* Daily faint lines (behind rolling) */}
      <path d={polyline(dailySpendPts)} fill="none" stroke="#e8825c" strokeWidth={1}   strokeOpacity={0.25} />
      <path d={polyline(dailySalePts)}  fill="none" stroke="#0093d0" strokeWidth={1}   strokeOpacity={0.25} />

      {/* Rolling bold lines */}
      <path d={polyline(rollSpendPts)} fill="none" stroke="#e8825c" strokeWidth={2}   strokeOpacity={0.85} />
      <path d={polyline(rollSalePts)}  fill="none" stroke="#0093d0" strokeWidth={2.5} />

      {/* Inline legend */}
      <g transform={`translate(${L + PW - 200}, ${T + 6})`}>
        <line x1={0} y1={5} x2={16} y2={5} stroke="#0093d0" strokeWidth={2.5} />
        <text x={20} y={9} fontSize={10} fill="#1a2b3c">Sales (30d avg)</text>
        <line x1={110} y1={5} x2={126} y2={5} stroke="#e8825c" strokeWidth={2} strokeOpacity={0.85} />
        <text x={130} y={9} fontSize={10} fill="#1a2b3c">Spend (30d avg)</text>
      </g>
    </svg>
  )
}
