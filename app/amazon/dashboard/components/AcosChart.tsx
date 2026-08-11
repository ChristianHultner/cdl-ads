// ACoS line chart, 900×160 viewBox. Dashed reference line at profile target_acos.
// Called from client ChartSection (shares activeTab state with SalesSpendChart).

import type { ChartPoint } from './SalesSpendChart'

const W = 900, H = 160
const L = 50, R = 56, T = 10, B = 28
const PW = W - L - R
const PH = H - T - B

function tx(i: number, n: number) { return n <= 1 ? L : L + (i / (n - 1)) * PW }
function ty(v: number, maxV: number) {
  if (maxV === 0) return T + PH
  return T + PH - Math.min(v / maxV, 1.05) * PH
}
function polyline(pts: { x: number; y: number }[]) {
  return pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
}

export default function AcosChart({ points, targetAcos }: { points: ChartPoint[]; targetAcos: number }) {
  const withAcos = points.filter(p => p.acos !== null) as (ChartPoint & { acos: number })[]

  if (withAcos.length === 0) {
    return (
      <div style={{ height: H, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--cdl-muted)', fontSize: '0.85rem' }}>
        No ACoS data
      </div>
    )
  }

  const n    = points.length
  const peak = Math.max(...withAcos.map(p => p.acos), targetAcos)
  const maxV = Math.min(peak * 1.2, 2.5)  // cap at 250% to avoid degenerate scale

  const acosPath = withAcos.map(p => ({
    x: tx(points.indexOf(p), n),
    y: ty(p.acos, maxV),
  }))

  const refY = ty(targetAcos, maxV)

  // Weekly x-ticks
  const xTicks: { x: number; label: string }[] = []
  for (let i = 0; i < n; i += 7) {
    const d = new Date(points[i].date + 'T00:00:00Z')
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
      <line
        x1={L} y1={refY} x2={L + PW} y2={refY}
        stroke="#8a97a5" strokeWidth={1.2} strokeDasharray="5 3"
      />
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

      {/* ACoS line */}
      <path d={polyline(acosPath)} fill="none" stroke="var(--cdl-blue)" strokeWidth={2} />
    </svg>
  )
}
