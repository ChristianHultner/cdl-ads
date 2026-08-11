// Design choice: per-currency trend arrows (EUR / USD / MXN / GBP / CAD) shown
// inline with each total — avoids mixing currencies into a single misleading %.
// ACoS shown per-country (ES / US / MX / UK), never blended. Threshold: green if
// within 10% of target_acos, red if >10% above.

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

function fmt(n: number, cur: string) {
  return `${SYM[cur] ?? cur}${Math.round(n).toLocaleString('en-US')}`
}

function pctDelta(now: number, prior: number): number | null {
  if (prior === 0) return null
  return (now - prior) / prior * 100
}

function TrendArrow({ pct, sym }: { pct: number; sym: string }) {
  const up  = pct >= 0
  const col = up ? 'var(--cdl-ok)' : 'var(--cdl-warn)'
  return (
    <span style={{ fontSize: '0.73rem', color: 'var(--cdl-muted)', whiteSpace: 'nowrap' }}>
      <span style={{ fontSize: '0.65rem' }}>{sym}</span>
      <span style={{ color: col, fontWeight: 700 }}>{up ? '↑' : '↓'}{Math.abs(pct).toFixed(0)}%</span>
    </span>
  )
}

export default function VerdictStrip({ rows }: { rows: MarketVerdictRow[] }) {
  // Aggregate by currency for SALES / SPEND totals
  const byCur: Record<string, { salesThis: number; salesPrior: number; spendThis: number; spendPrior: number }> = {}
  for (const r of rows) {
    if (!byCur[r.currency]) byCur[r.currency] = { salesThis: 0, salesPrior: 0, spendThis: 0, spendPrior: 0 }
    byCur[r.currency].salesThis  += r.salesThis
    byCur[r.currency].salesPrior += r.salesPriorAvg
    byCur[r.currency].spendThis  += r.spendThis
    byCur[r.currency].spendPrior += r.spendPriorAvg
  }

  const activeCurs = ['EUR', 'USD', 'MXN', 'GBP', 'CAD']
    .filter(c => byCur[c] && (byCur[c].salesThis > 0 || byCur[c].spendThis > 0))

  // ACoS per major market (weighted from this-week spend / sales)
  const acosMarkets = ['ES', 'US', 'MX', 'UK']
    .map(cc => {
      const r = rows.find(x => x.country === cc)
      if (!r || r.salesThis === 0) return null
      return { cc, acos: r.spendThis / r.salesThis, target: r.targetAcos }
    })
    .filter((x): x is { cc: string; acos: number; target: number } => x !== null)

  const rowStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: '0.75rem 1rem',
    padding: '0.5rem 0', borderBottom: '1px solid #e2ecf0', flexWrap: 'wrap',
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

      {/* SALES */}
      <div style={rowStyle}>
        <span style={labelStyle}>Sales</span>
        <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 0.5rem' }}>
          {activeCurs.map((c, i) => (
            <span key={c} style={{ display: 'flex', alignItems: 'baseline', gap: '0.15rem' }}>
              {i > 0 && <span style={{ color: 'var(--cdl-muted)', margin: '0 0.15rem' }}>+</span>}
              <strong style={{ fontSize: '1.25rem' }}>{fmt(byCur[c].salesThis, c)}</strong>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {activeCurs.map(c => {
            const p = pctDelta(byCur[c].salesThis, byCur[c].salesPrior)
            return p != null ? <TrendArrow key={c} pct={p} sym={SYM[c] ?? c} /> : null
          })}
        </div>
      </div>

      {/* SPEND */}
      <div style={rowStyle}>
        <span style={labelStyle}>Spend</span>
        <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: '0 0.5rem' }}>
          {activeCurs.map((c, i) => (
            <span key={c} style={{ display: 'flex', alignItems: 'baseline', gap: '0.15rem' }}>
              {i > 0 && <span style={{ color: 'var(--cdl-muted)', margin: '0 0.15rem' }}>+</span>}
              <strong style={{ fontSize: '1.25rem' }}>{fmt(byCur[c].spendThis, c)}</strong>
            </span>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '0.45rem', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {activeCurs.map(c => {
            const p = pctDelta(byCur[c].spendThis, byCur[c].spendPrior)
            return p != null ? <TrendArrow key={c} pct={p} sym={SYM[c] ?? c} /> : null
          })}
        </div>
      </div>

      {/* ACOS */}
      <div style={{ ...rowStyle, borderBottom: 'none', paddingBottom: 0 }}>
        <span style={labelStyle}>ACoS</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0 0.85rem' }}>
          {acosMarkets.map((m, i) => (
            <span key={m.cc} style={{ whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: '0.2rem' }}>
              {i > 0 && <span style={{ color: 'var(--cdl-muted)' }}>·</span>}
              <span style={{ fontSize: '0.72rem', color: 'var(--cdl-muted)', fontWeight: 600 }}>{m.cc}</span>
              <strong style={{
                color: m.acos > m.target * 1.1
                  ? 'var(--cdl-warn)'
                  : m.acos < m.target * 0.9
                    ? 'var(--cdl-ok)'
                    : 'var(--cdl-ink)',
              }}>
                {(m.acos * 100).toFixed(1)}%
              </strong>
            </span>
          ))}
          <span style={{ fontSize: '0.7rem', color: 'var(--cdl-muted)', marginLeft: '0.25rem' }}>this week</span>
        </div>
      </div>
    </div>
  )
}
