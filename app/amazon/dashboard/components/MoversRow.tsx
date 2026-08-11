// Design choice: estate-wide movers with currency symbols. Tab-scoping would
// require threading client tab state into a server-rendered component; keeping
// this server-side and estate-wide is simpler and still readable with currency labels.

export interface ClusterStats {
  impThis:   number
  clkThis:   number
  spendThis: number
  ordThis:   number
  impLast:   number
  clkLast:   number
  spendLast: number
  ordLast:   number
}

export interface MoverRow {
  name:      string
  country:   string
  currency:  string
  salesThis: number
  salesLast: number
  delta:     number
}

const SYM: Record<string, string> = { EUR: '€', USD: '$', MXN: 'MX$', GBP: '£', CAD: 'CA$' }

function trunc(s: string, max = 38) {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function pctLabel(now: number, prior: number): string {
  if (prior === 0) return now > 0 ? 'new' : '—'
  const p = (now - prior) / prior * 100
  return `${p >= 0 ? '+' : ''}${p.toFixed(0)}%`
}

function clusterLine(c: ClusterStats): string {
  const parts: string[] = []
  if (c.impLast > 0) {
    const p = (c.impThis - c.impLast) / c.impLast * 100
    parts.push(`${p >= 0 ? '+' : ''}${p.toFixed(0)}% imp (${c.impThis.toLocaleString('en-US')})`)
  } else {
    parts.push(`${c.impThis.toLocaleString('en-US')} imp`)
  }
  if (c.clkLast > 0) {
    const p = (c.clkThis - c.clkLast) / c.clkLast * 100
    parts.push(`${p >= 0 ? '+' : ''}${p.toFixed(0)}% clk`)
  } else {
    parts.push(`${c.clkThis} clk`)
  }
  const sd = c.spendThis - c.spendLast
  parts.push(`${sd >= 0 ? '+' : ''}€${Math.abs(sd).toFixed(2)} spend`)
  parts.push(`${c.ordThis} orders`)
  return parts.join(' · ')
}

function MoverTable({ rows, kind }: { rows: MoverRow[]; kind: 'up' | 'down' }) {
  const isUp = kind === 'up'
  const col  = isUp ? 'var(--cdl-ok)' : 'var(--cdl-warn)'
  const hdr  = isUp ? '↑ Top gainers this week' : '↓ Top decliners this week'

  return (
    <div style={{ border: '1px solid #c8dfe9', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{
        background: 'var(--cdl-sky)', padding: '0.4rem 1rem',
        fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: col,
      }}>
        {hdr}
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={3} style={{ padding: '0.7rem 1rem', color: 'var(--cdl-muted)' }}>—</td></tr>
          ) : rows.map((r, i) => {
            const sym   = SYM[r.currency] ?? r.currency
            const amt   = `${sym}${Math.abs(r.delta).toFixed(0)}`
            const sign  = isUp ? '+' : '−'
            const pct   = pctLabel(r.salesThis, r.salesLast)
            return (
              <tr key={i} style={{ borderTop: '1px solid #edf3f7' }}>
                <td style={{ padding: '0.45rem 0.75rem 0.45rem 1rem' }}>{trunc(r.name)}</td>
                <td style={{ padding: '0.45rem 0.35rem', color: 'var(--cdl-muted)', fontSize: '0.73rem', whiteSpace: 'nowrap' }}>{r.country}</td>
                <td style={{ padding: '0.45rem 1rem 0.45rem 0', textAlign: 'right', whiteSpace: 'nowrap', color: col, fontWeight: 700 }}>
                  {sign}{amt} <span style={{ fontWeight: 400, fontSize: '0.75rem' }}>({pct})</span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

export default function MoversRow({ cluster, gainers, decliners }: {
  cluster:   ClusterStats | null
  gainers:   MoverRow[]
  decliners: MoverRow[]
}) {
  return (
    <div style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ marginBottom: '0.75rem' }}>What Moved</h2>

      {/* CLUSTER experiment one-liner */}
      {cluster && (cluster.impThis > 0 || cluster.impLast > 0) && (
        <div style={{
          background: '#f0f8fe', border: '1px solid #b8d8eb', borderRadius: 6,
          padding: '0.55rem 1rem', marginBottom: '1rem',
          fontSize: '0.82rem', display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '0 0.4rem',
        }}>
          <span style={{ fontWeight: 700, color: 'var(--cdl-blue)', marginRight: '0.3rem' }}>CLUSTER</span>
          <span>{clusterLine(cluster)}</span>
          <span style={{ color: 'var(--cdl-muted)', fontStyle: 'italic', marginLeft: '0.5rem' }}>· verdict Aug 17</span>
        </div>
      )}

      {/* Top gainers / decliners */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
        <MoverTable rows={gainers}   kind="up"   />
        <MoverTable rows={decliners} kind="down" />
      </div>
    </div>
  )
}
