export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

export default async function HomePage() {
  const sql = neon(process.env.DATABASE_URL!)

  const [amazonTotals, recCounts, wdRows] = (await Promise.all([
    sql`
      SELECT
        sum(cost)::text                                      AS spend_30d,
        sum(sales_14d)::text                                 AS sales_30d,
        (sum(cost) / nullif(sum(sales_14d), 0))::text        AS acos_raw
      FROM amazon_campaign_daily
      WHERE date >= CURRENT_DATE - INTERVAL '30 days'
    `,
    sql`
      SELECT
        (count(*) FILTER (WHERE status = 'DRAFT'))::text    AS draft_count,
        (count(*) FILTER (WHERE status = 'APPROVED'))::text AS approved_count
      FROM recommendations
    `,
    sql`SELECT checked_at, verdict, details FROM watchdog_status WHERE id = 1`,
  ])) as unknown as [
    Array<{ spend_30d: string; sales_30d: string; acos_raw: string | null }>,
    Array<{ draft_count: string; approved_count: string }>,
    Array<{ checked_at: Date; verdict: string; details: string[] | null }>,
  ]

  const at = amazonTotals[0] ?? { spend_30d: '0', sales_30d: '0', acos_raw: null }
  const rc = recCounts[0]    ?? { draft_count: '0', approved_count: '0' }
  const wd = wdRows[0]       ?? null

  const spend    = parseFloat(at.spend_30d).toFixed(2)
  const sales    = parseFloat(at.sales_30d).toFixed(2)
  const acosPct  = at.acos_raw != null
    ? (parseFloat(at.acos_raw) * 100).toFixed(1) + '%'
    : '—'
  const draft    = parseInt(rc.draft_count, 10)
  const approved = parseInt(rc.approved_count, 10)

  // Watchdog status strip
  let wdBg      = 'transparent'
  let wdColor   = 'var(--cdl-muted)'
  let wdBorder  = 'none'
  let wdText    = 'watchdog not yet run'

  if (wd) {
    const hhmm = new Date(wd.checked_at).toLocaleTimeString('en-GB', {
      hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid',
    })
    if (wd.verdict === 'OK') {
      wdBg     = '#d4edda'
      wdColor  = '#155724'
      wdBorder = '1px solid #c3e6cb'
      wdText   = `✅ Last night: OK (checked ${hhmm})`
    } else {
      const det = Array.isArray(wd.details) && wd.details.length > 0
        ? wd.details.join(' | ')
        : wd.verdict
      wdBg     = '#f8d7da'
      wdColor  = '#721c24'
      wdBorder = '1px solid #f5c6cb'
      wdText   = `🚨 ALERT: ${det}`
    }
  }

  return (
    <div>
      <div style={{
        background:    wdBg,
        color:         wdColor,
        border:        wdBorder,
        borderRadius:  6,
        padding:       '0.45rem 1rem',
        marginBottom:  '1rem',
        fontSize:      '0.85rem',
      }}>
        {wdText}
      </div>

      <h1>Cuento de Luz — Ads</h1>

      <div className="table-card">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Channel</th>
                <th className="num">Spend 30d</th>
                <th className="num">Sales 30d</th>
                <th className="num">Blended ACoS</th>
                <th className="num">Open Recs</th>
                <th>Links</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td><strong>Amazon</strong></td>
                <td className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>{spend}</td>
                <td className="num" style={{ fontVariantNumeric: 'tabular-nums' }}>{sales}</td>
                <td className="num">{acosPct}</td>
                <td className="num">
                  {draft > 0 && (
                    <span className="badge badge-blue" style={{ marginRight: '0.35rem' }}>
                      {draft} draft
                    </span>
                  )}
                  {approved > 0 && (
                    <span className="badge badge-ok">{approved} approved</span>
                  )}
                  {draft === 0 && approved === 0 && '—'}
                </td>
                <td>
                  <a href="/amazon/campaigns" style={{ color: 'var(--cdl-blue)', marginRight: '1.25rem' }}>
                    Campaigns
                  </a>
                  <a href="/amazon/recommendations" style={{ color: 'var(--cdl-blue)' }}>
                    Recommendations
                  </a>
                </td>
              </tr>
              <tr style={{ color: 'var(--cdl-muted)' }}>
                <td><a href="/google" style={{ color: 'var(--cdl-muted)' }}>Google</a></td>
                <td className="num">—</td>
                <td className="num">—</td>
                <td className="num">—</td>
                <td className="num">—</td>
                <td style={{ fontStyle: 'italic', fontSize: '0.82rem' }}>not yet connected</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
