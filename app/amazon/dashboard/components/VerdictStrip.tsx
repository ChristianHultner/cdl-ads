// Design choices (round 2):
// (a) Trend arrows inline beside each currency figure: '€1,524 ↑4%'
// (b) Spend arrows neutral grey both directions — spend up is not inherently bad
// (c) Materiality floor: currencies with week-sales < 50 local units fold into '+ minor'
// (d) ACoS row: 'ES 34.6% / tgt 30%' — target shown inline, red only when above target

export interface MarketVerdictRow {
  country:       string
  currency:      string
  targetAcos:    number
  salesThis:     number
  salesPriorAvg: number
  spendThis:     number
  spendPriorAvg: number
}

const SYM: Record<string, string> = { EUR: '€', USD: '$', MXN: 'MX$', GBP: '£', CAD: 'CA$' }
const MATERIALITY = 50   // local currency units; below this → fold into '+ minor'

function fmt(n: number, cur: string) {
  return `${SYM[cur] ?? cur}${Math.round(n).toLocaleString('en-US')}`
}

function pctDelta(now: number, prior: number): number | null {
  if (prior === 0) return null
  return (now - prior) / prior * 100
}

function SalesArrow({ pct }: { pct: number }) {
  return (
    <span style={{
      fontSize: '0.72rem', fontWeight: 700, marginLeft: '0.22rem',
      color: pct >= 0 ? 'var(--cdl-ok)' : 'var(--cdl-warn)',
    }}>
      {pct >= 0 ? '↑' : '↓'}{Math.abs(pct).toFixed(0)}%
    </span>
  )
}

function SpendArrow({ pct }: { pct: number }) {
  // Neutral grey — spend direction is not good/bad on its own
  return (
    <span style={{ fontSize: '0.72rem', fontWeight: 700, marginLeft: '0.22rem', color: '#8a97a5' }}>
      {pct >= 0 ? '↑' : '↓'}{Math.abs(pct).toFixed(0)}%
    </span>
  )
}

export default function VerdictStrip({ rows }: { rows: MarketVerdictRow[] }) {
  // Aggregate by currency
  const byCur: Record<string, { salesThis: number; salesPrior: number; spendThis: number; spendPrior: number }> = {}
  for (const r of rows) {
    if (!byCur[r.currency]) byCur[r.currency] = { salesThis: 0, salesPrior: 0, spendThis: 0, spendPrior: 0 }
    byCur[r.currency].salesThis  += r.salesThis
    byCur[r.currency].salesPrior += r.salesPriorAvg
    byCur[r.currency].spendThis  += r.spendThis
    byCur[r.currency].spendPrior += r.spendPriorAvg
  }

  const allActive = ['EUR', 'USD', 'MXN', 'GBP', 'CAD'].filter(c =>
    byCur[c] && (byCur[c].salesThis > 0 || byCur[c].spendThis > 0)
  )

  // Split material vs minor by sales threshold
  const material = allActive.filter(c => byCur[c].salesThis >= MATERIALITY)
  const minor    = allActive.filter(c => byCur[c].salesThis < MATERIALITY)

  // ACoS per major market — spend/sales this week
  const acosMarkets = ['ES', 'US', 'MX', 'UK']
    .map(cc => {
      const r = rows.find(x => x.country === cc)
      if (!r || r.salesThis === 0) return null
      return { cc, acos: r.spendThis / r.salesThis, target: r.targetAcos }
    })
    .filter((x): x is { cc: string; acos: number; target: number } => x !== null)

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', flexWrap: 'wrap',
    padding: '0.5rem 0', borderBottom: '1px solid #e2ecf0', gap: '0.35rem 0.5rem',
  }
  const labelStyle: React.CSSProperties = {
    width: 48, flexShrink: 0, fontSize: '0.67rem', fontWeight: 700,
    textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--cdl-muted)',
  }

  return (
    <div style={{
      background: 'var(--cdl-sky)', border: '1px solid #c8dfe9', borderRadius: 8,
      padding: '0.15rem 1.5rem 0.5rem', marginBottom: '1.5rem',
    }}>

      {/* SALES — arrows inline, green/red */}
      <div style={rowStyle}>
        <span style={labelStyle}>Sales</span>
        <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 1.1rem' }}>
          {material.map((c, i) => {
            const p = pctDelta(byCur[c].salesThis, byCur[c].salesPrior)
            return (
              <span key={c} style={{ display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap' }}>
                {i > 0 && <span style={{ color: 'var(--cdl-muted)', marginRight: '0.75rem' }}>+</span>}
                <strong style={{ fontSize: '1.25rem' }}>{fmt(byCur[c].salesThis, c)}</strong>
                {p != null && <SalesArrow pct={p} />}
              </span>
            )
          })}
          {minor.length > 0 && (
            <span style={{ fontSize: '0.78rem', color: 'var(--cdl-muted)', alignSelf: 'center' }}>
              + minor ({minor.map(c => `${SYM[c] ?? c}${Math.round(byCur[c].salesThis)}`).join(', ')})
            </span>
          )}
        </div>
      </div>

      {/* SPEND — arrows inline, neutral grey */}
      <div style={rowStyle}>
        <span style={labelStyle}>Spend</span>
        <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 1.1rem' }}>
          {material.map((c, i) => {
            const p = pctDelta(byCur[c].spendThis, byCur[c].spendPrior)
            return (
              <span key={c} style={{ display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap' }}>
                {i > 0 && <span style={{ color: 'var(--cdl-muted)', marginRight: '0.75rem' }}>+</span>}
                <strong style={{ fontSize: '1.25rem' }}>{fmt(byCur[c].spendThis, c)}</strong>
                {p != null && <SpendArrow pct={p} />}
              </span>
            )
          })}
          {minor.length > 0 && (
            <span style={{ fontSize: '0.78rem', color: 'var(--cdl-muted)', alignSelf: 'center' }}>
              + minor
            </span>
          )}
        </div>
      </div>

      {/* ACOS — target inline per market, red when above */}
      <div style={{ ...rowStyle, borderBottom: 'none', paddingBottom: 0 }}>
        <span style={labelStyle}>ACoS</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 1.1rem' }}>
          {acosMarkets.map((m, i) => (
            <span key={m.cc} style={{ display: 'inline-flex', alignItems: 'baseline', whiteSpace: 'nowrap' }}>
              {i > 0 && <span style={{ color: 'var(--cdl-muted)', marginRight: '0.75rem' }}>·</span>}
              <span style={{ fontSize: '0.72rem', color: 'var(--cdl-muted)', fontWeight: 600, marginRight: '0.18rem' }}>{m.cc}</span>
              <strong style={{ color: m.acos > m.target ? 'var(--cdl-warn)' : 'var(--cdl-ink)' }}>
                {(m.acos * 100).toFixed(1)}%
              </strong>
              <span style={{ fontSize: '0.7rem', color: 'var(--cdl-muted)', marginLeft: '0.22rem' }}>
                / tgt {(m.target * 100).toFixed(0)}%
              </span>
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
