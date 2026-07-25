export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

interface ReportRow {
  country_code: string
  report_type: string
  start_date: string | null
  end_date: string | null
  status: string
  requested_at: string | null
  completed_at: string | null
}

interface DailyRow {
  country_code: string
  currency_code: string
  date: string
  total_cost: string
  total_clicks: string
  total_impressions: string
  total_sales: string
  acos: string | null
}

interface CampaignRow {
  campaign_name: string
  country_code: string
  currency_code: string
  total_cost: string
  total_clicks: string
  total_sales: string
  acos: string | null
}

export default async function SpendPage() {
  const sql = neon(process.env.DATABASE_URL!)

  const [rows, daily, campaigns] = (await Promise.all([
    sql`
      SELECT
        ap.country_code,
        arr.report_type,
        arr.start_date::text,
        arr.end_date::text,
        arr.status,
        arr.requested_at::text,
        arr.completed_at::text
      FROM amazon_report_requests arr
      JOIN amazon_profiles ap USING (profile_id)
      ORDER BY arr.requested_at DESC
    `,
    sql`
      SELECT
        ap.country_code,
        ap.currency_code,
        acd.date::text,
        sum(acd.cost)::text         AS total_cost,
        sum(acd.clicks)::text       AS total_clicks,
        sum(acd.impressions)::text  AS total_impressions,
        sum(acd.sales_14d)::text    AS total_sales,
        (sum(acd.cost) / nullif(sum(acd.sales_14d), 0))::text AS acos
      FROM amazon_campaign_daily acd
      JOIN amazon_profiles ap USING (profile_id)
      GROUP BY ap.country_code, ap.currency_code, acd.date
      ORDER BY acd.date DESC, ap.country_code
    `,
    sql`
      SELECT
        coalesce(c.name, d.campaign_id)     AS campaign_name,
        p.country_code,
        p.currency_code,
        sum(d.cost)::text                   AS total_cost,
        sum(d.clicks)::text                 AS total_clicks,
        sum(d.sales_14d)::text              AS total_sales,
        (sum(d.cost) / nullif(sum(d.sales_14d), 0))::text AS acos
      FROM amazon_campaign_daily d
      JOIN amazon_profiles p USING (profile_id)
      LEFT JOIN amazon_campaigns c
        ON c.campaign_id = d.campaign_id AND c.profile_id = d.profile_id
      GROUP BY coalesce(c.name, d.campaign_id), p.country_code, p.currency_code
      ORDER BY sum(d.cost) DESC
      LIMIT 20
    `,
  ])) as unknown as [ReportRow[], DailyRow[], CampaignRow[]]

  return (
    <div>
      <h1>Spend / Reports</h1>

      <h2>Report Ledger</h2>
      {rows.length === 0 ? (
        <p style={{ color: 'var(--cdl-muted)', marginBottom: '2rem' }}>No reports yet.</p>
      ) : (
        <div className="table-card">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Country</th>
                  <th>Report Type</th>
                  <th>Start Date</th>
                  <th>End Date</th>
                  <th>Status</th>
                  <th>Requested At</th>
                  <th>Completed At</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td>{r.country_code}</td>
                    <td>{r.report_type}</td>
                    <td>{r.start_date ?? '—'}</td>
                    <td>{r.end_date ?? '—'}</td>
                    <td>{r.status}</td>
                    <td>{r.requested_at ?? '—'}</td>
                    <td>{r.completed_at ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h2>Daily Totals</h2>
      {daily.length === 0 ? (
        <p style={{ color: 'var(--cdl-muted)', marginBottom: '2rem' }}>No data landed yet.</p>
      ) : (
        <div className="table-card">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Country</th>
                  <th>Date</th>
                  <th>Cost</th>
                  <th>Clicks</th>
                  <th>Impressions</th>
                  <th>Sales</th>
                  <th>ACOS</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((r, i) => {
                  const acos  = r.acos != null
                    ? `${(parseFloat(r.acos) * 100).toFixed(1)}%`
                    : '—'
                  const cost  = parseFloat(r.total_cost).toFixed(2)
                  const sales = parseFloat(r.total_sales).toFixed(2)
                  return (
                    <tr key={i}>
                      <td>{r.country_code}</td>
                      <td>{r.date}</td>
                      <td className="num">{cost} {r.currency_code}</td>
                      <td className="num">{r.total_clicks}</td>
                      <td className="num">{r.total_impressions}</td>
                      <td className="num">{sales} {r.currency_code}</td>
                      <td className="num">
                        {r.acos != null
                          ? <span className="badge badge-muted">{acos}</span>
                          : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <h2>Top Campaigns by Spend</h2>
      {campaigns.length === 0 ? (
        <p style={{ color: 'var(--cdl-muted)' }}>No data landed yet.</p>
      ) : (
        <div className="table-card">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Country</th>
                  <th>Cost</th>
                  <th>Clicks</th>
                  <th>Sales</th>
                  <th>ACOS</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((r, i) => {
                  const acos  = r.acos != null
                    ? `${(parseFloat(r.acos) * 100).toFixed(1)}%`
                    : '—'
                  const cost  = parseFloat(r.total_cost).toFixed(2)
                  const sales = parseFloat(r.total_sales).toFixed(2)
                  return (
                    <tr key={i}>
                      <td>{r.campaign_name}</td>
                      <td>{r.country_code}</td>
                      <td className="num">{cost} {r.currency_code}</td>
                      <td className="num">{r.total_clicks}</td>
                      <td className="num">{sales} {r.currency_code}</td>
                      <td className="num">
                        {r.acos != null
                          ? <span className="badge badge-muted">{acos}</span>
                          : '—'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
