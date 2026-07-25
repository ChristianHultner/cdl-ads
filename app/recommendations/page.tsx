export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { approveRecommendation, rejectRecommendation } from './actions'

interface RecRow {
  id: number
  rec_type: string
  target_text: string
  proposal: string
  status: string
  created_at: string
  country_code: string
}

function statusBadge(status: string): string {
  if (status === 'APPROVED' || status === 'PUSHED') return 'badge badge-ok'
  if (status === 'REJECTED') return 'badge badge-warn'
  return 'badge badge-muted'
}

export default async function RecommendationsPage() {
  const sql = neon(process.env.DATABASE_URL!)

  const rows = (await sql`
    SELECT
      r.id,
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
    <div>
      <h1>Recommendations</h1>

      {rows.length === 0 ? (
        <p style={{ color: 'var(--cdl-muted)' }}>No recommendations yet.</p>
      ) : (
        <>
          {/* ── DRAFT groups ── */}
          {draftRows.length === 0 ? (
            <p style={{ color: 'var(--cdl-muted)', marginBottom: '1.5rem' }}>
              No DRAFT recommendations.
            </p>
          ) : (
            Array.from(draftByType.entries()).map(([recType, typeRows]) => (
              <div key={recType} style={{ marginBottom: '2.5rem' }}>
                <h2>
                  {recType}{' '}
                  <span style={{ color: 'var(--cdl-muted)', fontWeight: 400, fontFamily: 'inherit' }}>
                    — {typeRows.length} draft{typeRows.length !== 1 ? 's' : ''}
                  </span>
                </h2>
                <div className="table-card">
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Country</th>
                          <th>Target</th>
                          <th>Proposal</th>
                          <th>Created At</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {typeRows.map((r) => (
                          <tr key={r.id}>
                            <td>{r.country_code}</td>
                            <td>{r.target_text}</td>
                            <td className="wrap">{r.proposal}</td>
                            <td>{r.created_at}</td>
                            <td>
                              <form
                                action={approveRecommendation}
                                style={{ display: 'inline', marginRight: '0.4rem' }}
                              >
                                <input type="hidden" name="id" value={r.id} />
                                <button type="submit" className="btn-approve">Approve</button>
                              </form>
                              <form action={rejectRecommendation} style={{ display: 'inline' }}>
                                <input type="hidden" name="id" value={r.id} />
                                <button type="submit" className="btn-reject">Reject</button>
                              </form>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ))
          )}

          {/* ── Non-DRAFT rows ── */}
          {nonDraftRows.length > 0 && (
            <div style={{ marginBottom: '2rem' }}>
              <h2 style={{ color: 'var(--cdl-muted)' }}>Ruled</h2>
              <div className="table-card">
                <div className="table-scroll">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>Country</th>
                        <th>Rec Type</th>
                        <th>Target</th>
                        <th>Proposal</th>
                        <th>Created At</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nonDraftRows.map((r) => (
                        <tr key={r.id}>
                          <td>{r.country_code}</td>
                          <td>{r.rec_type}</td>
                          <td>{r.target_text}</td>
                          <td className="wrap">{r.proposal}</td>
                          <td>{r.created_at}</td>
                          <td>
                            <span className={statusBadge(r.status)}>{r.status}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {/* ── Summary ── */}
          <hr style={{ margin: '0.5rem 0 0.75rem', borderColor: '#c8dfe9' }} />
          <p style={{ fontSize: '0.82rem', color: 'var(--cdl-muted)' }}>
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
