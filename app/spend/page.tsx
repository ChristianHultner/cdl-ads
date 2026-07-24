export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

const th: React.CSSProperties = {
  border: '1px solid #ccc', padding: '6px 10px',
  background: '#f0f0f0', textAlign: 'left', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  border: '1px solid #ccc', padding: '6px 10px', whiteSpace: 'nowrap',
}
const tdR: React.CSSProperties = { ...td, textAlign: 'right' }

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
    <div style={{ fontFamily: 'monospace', padding: '1.5rem 2rem' }}>
      <nav style={{ marginBottom: '1.5rem', borderBottom: '1px solid #eee', paddingBottom: '0.75rem' }}>
        <a href="/" style={{ marginRight: '1rem' }}>← Home</a>
        <a href="/accounts" style={{ marginRight: '1rem' }}>Accounts</a>
        <a href="/campaigns" style={{ marginRight: '1rem' }}>Campaigns</a>
        <strong>Spend / Reports</strong>
      </nav>

      <h1 style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>Report Ledger</h1>

      {rows.length === 0 ? (
        <p style={{ color: '#888' }}>No reports yet.</p>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: '2.5rem' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th style={th}>Country</th>
                <th style={th}>Report Type</th>
                <th style={th}>Start Date</th>
                <th style={th}>End Date</th>
                <th style={th}>Status</th>
                <th style={th}>Requested At</th>
                <th style={th}>Completed At</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td style={td}>{r.country_code}</td>
                  <td style={td}>{r.report_type}</td>
                  <td style={td}>{r.start_date ?? '—'}</td>
                  <td style={td}>{r.end_date ?? '—'}</td>
                  <td style={td}>{r.status}</td>
                  <td style={td}>{r.requested_at ?? '—'}</td>
                  <td style={td}>{r.completed_at ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ fontSize: '1.1rem', marginBottom: '1rem' }}>Daily Totals</h2>

      {daily.length === 0 ? (
        <p style={{ color: '#888', marginBottom: '2.5rem' }}>No data landed yet.</p>
      ) : (
        <div style={{ overflowX: 'auto', marginBottom: '2.5rem' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th style={th}>Country</th>
                <th style={th}>Date</th>
                <th style={th}>Cost (currency)</th>
                <th style={th}>Clicks</th>
                <th style={th}>Impressions</th>
                <th style={th}>Sales (currency)</th>
                <th style={th}>ACOS</th>
              </tr>
            </thead>
            <tbody>
              {daily.map((r, i) => {
                const acos = r.acos != null
                  ? `${(parseFloat(r.acos) * 100).toFixed(1)}%`
                  : '—'
                const cost = parseFloat(r.total_cost).toFixed(2)
                const sales = parseFloat(r.total_sales).toFixed(2)
                return (
                  <tr key={i}>
                    <td style={td}>{r.country_code}</td>
                    <td style={td}>{r.date}</td>
                    <td style={tdR}>{cost} {r.currency_code}</td>
                    <td style={tdR}>{r.total_clicks}</td>
                    <td style={tdR}>{r.total_impressions}</td>
                    <td style={tdR}>{sales} {r.currency_code}</td>
                    <td style={tdR}>{acos}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ fontSize: '1.1rem', marginBottom: '1rem' }}>Top Campaigns by Spend</h2>

      {campaigns.length === 0 ? (
        <p style={{ color: '#888' }}>No data landed yet.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem' }}>
            <thead>
              <tr>
                <th style={th}>Campaign</th>
                <th style={th}>Country</th>
                <th style={th}>Cost (currency)</th>
                <th style={th}>Clicks</th>
                <th style={th}>Sales (currency)</th>
                <th style={th}>ACOS</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map((r, i) => {
                const acos = r.acos != null
                  ? `${(parseFloat(r.acos) * 100).toFixed(1)}%`
                  : '—'
                const cost = parseFloat(r.total_cost).toFixed(2)
                const sales = parseFloat(r.total_sales).toFixed(2)
                return (
                  <tr key={i}>
                    <td style={td}>{r.campaign_name}</td>
                    <td style={td}>{r.country_code}</td>
                    <td style={tdR}>{cost} {r.currency_code}</td>
                    <td style={tdR}>{r.total_clicks}</td>
                    <td style={tdR}>{sales} {r.currency_code}</td>
                    <td style={tdR}>{acos}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
