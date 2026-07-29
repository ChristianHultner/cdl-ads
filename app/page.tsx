export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

export default async function HomePage() {
  const sql = neon(process.env.DATABASE_URL!)

  const [amazonTotals, recCounts] = (await Promise.all([
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
  ])) as unknown as [
    Array<{ spend_30d: string; sales_30d: string; acos_raw: string | null }>,
    Array<{ draft_count: string; approved_count: string }>,
  ]

  const at = amazonTotals[0] ?? { spend_30d: '0', sales_30d: '0', acos_raw: null }
  const rc = recCounts[0]    ?? { draft_count: '0', approved_count: '0' }

  const spend    = parseFloat(at.spend_30d).toFixed(2)
  const sales    = parseFloat(at.sales_30d).toFixed(2)
  const acosPct  = at.acos_raw != null
    ? (parseFloat(at.acos_raw) * 100).toFixed(1) + '%'
    : '—'
  const draft    = parseInt(rc.draft_count, 10)
  const approved = parseInt(rc.approved_count, 10)

  return (
    <div>
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
                <td>Google</td>
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
