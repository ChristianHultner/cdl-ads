export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

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
    <main>
      <h1>Amazon Campaigns ({campaigns.length})</h1>
      <div className="table-card">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {['Country','Name','State','Targeting Type','Start Date','Budget Amount','Budget Type','Synced At'].map(h => (
                  <th key={h}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {campaigns.map((c, i) => (
                <tr key={i}>
                  <td>{c.country_code}</td>
                  <td>{c.name}</td>
                  <td>{c.state}</td>
                  <td>{c.targeting_type ?? '—'}</td>
                  <td>{c.start_date ?? '—'}</td>
                  <td className="num">{c.budget_amount ?? '—'}</td>
                  <td>{c.budget_type ?? '—'}</td>
                  <td>{c.synced_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  )
}
