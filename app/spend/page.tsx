export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

const th: React.CSSProperties = {
  border: '1px solid #ccc', padding: '6px 10px',
  background: '#f0f0f0', textAlign: 'left', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  border: '1px solid #ccc', padding: '6px 10px', whiteSpace: 'nowrap',
}

interface ReportRow {
  country_code: string
  report_type: string
  start_date: string | null
  end_date: string | null
  status: string
  requested_at: string | null
  completed_at: string | null
}

export default async function SpendPage() {
  const sql = neon(process.env.DATABASE_URL!)

  const rows = (await sql`
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
  `) as unknown as ReportRow[]

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
        <div style={{ overflowX: 'auto' }}>
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
    </div>
  )
}
