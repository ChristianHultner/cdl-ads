export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

const th: React.CSSProperties = {
  border: '1px solid #ccc', padding: '6px 10px',
  background: '#f0f0f0', textAlign: 'left', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  border: '1px solid #ccc', padding: '6px 10px', whiteSpace: 'nowrap',
}
const tdWrap: React.CSSProperties = {
  border: '1px solid #ccc', padding: '6px 10px',
  maxWidth: '360px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
}

interface RecRow {
  rec_type: string
  target_text: string
  proposal: string
  status: string
  created_at: string
  country_code: string
}

export default async function RecommendationsPage() {
  const sql = neon(process.env.DATABASE_URL!)

  const rows = (await sql`
    SELECT
      r.rec_type,
      r.target_text,
      r.proposal,
      r.status,
      r.created_at::text,
      p.country_code
    FROM recommendations r
    JOIN amazon_profiles p USING (profile_id)
    ORDER BY
      CASE r.status WHEN 'DRAFT' THEN 0 ELSE 1 END,
      r.rec_type,
      r.id
  `) as unknown as RecRow[]

  const draftRows    = rows.filter((r) => r.status === 'DRAFT')
  const nonDraftRows = rows.filter((r) => r.status !== 'DRAFT')

  // Group DRAFT rows by rec_type (insertion order preserved)
  const draftByType = new Map<string, RecRow[]>()
  for (const row of draftRows) {
    if (!draftByType.has(row.rec_type)) draftByType.set(row.rec_type, [])
    draftByType.get(row.rec_type)!.push(row)
  }

  // Non-DRAFT counts by status
  const nonDraftCounts = new Map<string, number>()
  for (const row of nonDraftRows) {
    nonDraftCounts.set(row.status, (nonDraftCounts.get(row.status) ?? 0) + 1)
  }

  return (
    <div style={{ fontFamily: 'monospace', padding: '1.5rem 2rem' }}>
      <nav style={{
        marginBottom: '1.5rem',
        borderBottom: '1px solid #eee',
        paddingBottom: '0.75rem',
      }}>
        <a href="/" style={{ marginRight: '1rem' }}>← Home</a>
        <a href="/accounts"  style={{ marginRight: '1rem' }}>Accounts</a>
        <a href="/campaigns" style={{ marginRight: '1rem' }}>Campaigns</a>
        <a href="/spend"     style={{ marginRight: '1rem' }}>Spend</a>
        <strong>Recommendations</strong>
      </nav>

      <h1 style={{ fontSize: '1.25rem', marginBottom: '1.5rem' }}>
        Recommendations
      </h1>

      {rows.length === 0 ? (
        <p style={{ color: '#888' }}>No recommendations yet.</p>
      ) : (
        <>
          {draftRows.length === 0 ? (
            <p style={{ color: '#888' }}>No DRAFT recommendations.</p>
          ) : (
            Array.from(draftByType.entries()).map(([recType, typeRows]) => (
              <div key={recType} style={{ marginBottom: '2.5rem' }}>
                <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
                  {recType}{' '}
                  <span style={{ color: '#555', fontWeight: 'normal' }}>
                    — {typeRows.length} draft{typeRows.length !== 1 ? 's' : ''}
                  </span>
                </h2>
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr>
                        <th style={th}>Country</th>
                        <th style={th}>Target</th>
                        <th style={th}>Proposal</th>
                        <th style={th}>Created At</th>
                      </tr>
                    </thead>
                    <tbody>
                      {typeRows.map((r, i) => (
                        <tr key={i}>
                          <td style={td}>{r.country_code}</td>
                          <td style={td}>{r.target_text}</td>
                          <td style={tdWrap}>{r.proposal}</td>
                          <td style={td}>{r.created_at}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          )}

          <hr style={{ margin: '1rem 0 0.75rem', borderColor: '#eee' }} />
          <p style={{ fontSize: '0.8rem', color: '#666' }}>
            Non-draft totals:{' '}
            {(['APPROVED', 'REJECTED', 'PUSHED'] as const).map((s) => (
              <span key={s} style={{ marginRight: '1.25rem' }}>
                {s}: {nonDraftCounts.get(s) ?? 0}
              </span>
            ))}
          </p>
        </>
      )}
    </div>
  )
}
