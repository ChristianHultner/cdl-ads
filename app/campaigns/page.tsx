export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

const cell: React.CSSProperties = { border: '1px solid #ccc', padding: '4px 8px' }
const headCell: React.CSSProperties = { ...cell, background: '#f0f0f0', textAlign: 'left' }

interface Campaign {
  country_code: string
  name: string
  state: string
  targeting_type: string | null
  start_date: string | null
  budget_amount: string | null
  budget_type: string | null
  synced_at: string
}

export default async function CampaignsPage() {
  const sql = neon(process.env.DATABASE_URL!)

  const campaigns = (await sql`
    SELECT
      p.country_code,
      c.name,
      c.state,
      c.targeting_type,
      c.start_date,
      c.budget_amount::text,
      c.budget_type,
      c.synced_at::text
    FROM amazon_campaigns c
    JOIN amazon_profiles p ON p.profile_id = c.profile_id
    ORDER BY p.country_code, c.name
  `) as unknown as Campaign[]

  return (
    <main style={{ fontFamily: 'monospace', padding: '2rem', maxWidth: '1400px', margin: '0 auto' }}>
      <nav style={{ marginBottom: '1.5rem' }}>
        <a href="/">← Home</a>
      </nav>
      <h1 style={{ marginTop: 0 }}>Amazon Campaigns ({campaigns.length})</h1>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            {['Country','Name','State','Targeting Type','Start Date','Budget Amount','Budget Type','Synced At'].map(h => (
              <th key={h} style={headCell}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c, i) => (
            <tr key={i}>
              <td style={cell}>{c.country_code}</td>
              <td style={cell}>{c.name}</td>
              <td style={cell}>{c.state}</td>
              <td style={cell}>{c.targeting_type ?? '—'}</td>
              <td style={cell}>{c.start_date ?? '—'}</td>
              <td style={cell}>{c.budget_amount ?? '—'}</td>
              <td style={cell}>{c.budget_type ?? '—'}</td>
              <td style={cell}>{c.synced_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  )
}
