export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { approveRecommendation, rejectRecommendation } from './actions'

interface Placement {
  campaign_id: string
  ad_group_id: string
  spend: number
  clicks: number
  orders: number
  sales: number
}

interface Evidence {
  spend?: number
  clicks?: number
  orders?: number
  sales?: number
  acos?: number | null
  window_start?: string
  window_end?: string
  params_used?: { target_acos?: number }
  campaign_ids?: string[]
  placements?: Placement[]
  primary_placement?: Placement
  pushed_keyword_ids?: string[]
  pushed_target_ids?: string[]
}

interface RecRow {
  id: number
  rec_type: string
  target_text: string
  proposal: string
  status: string
  created_at: string
  country_code: string
  profile_id: string
  currency_code: string
  evidence: Evidence
}

interface CampaignInfo {
  profile_id: string
  campaign_id: string
  name: string
  state: string
}

interface AdGroupInfo {
  profile_id: string
  ad_group_id: string
  name: string
}

interface DailyAgg {
  profile_id: string
  campaign_id: string
  spend_30d: string
  sales_30d: string
  acos: string | null
}

function recTypeBadge(rt: string): string {
  if (rt === 'PROMOTE_TERM' || rt === 'PROMOTE_ASIN') return 'badge badge-ok'
  if (rt === 'NEGATE_TERM')  return 'badge badge-warn'
  return 'badge badge-muted'
}

function stateBadgeCls(state: string): string {
  const s = state.toUpperCase()
  if (s === 'ENABLED')  return 'badge badge-ok'
  if (s === 'ARCHIVED') return 'badge badge-dim'
  return 'badge badge-muted'
}

function statusBadgeCls(status: string): string {
  if (status === 'APPROVED' || status === 'PUSHED') return 'badge badge-ok'
  if (status === 'REJECTED') return 'badge badge-warn'
  return 'badge badge-muted'
}

function fmtN(v: number | undefined | null): string {
  if (v == null) return '—'
  return v.toFixed(2)
}

function fmtMoney(v: string): string {
  return parseFloat(v).toFixed(2)
}

const COUNTRY_TLD: Record<string, string> = {
  ES: 'es', US: 'com', MX: 'com.mx', CA: 'ca', UK: 'co.uk',
}
const ASIN_RE = /^([0-9]{9}[0-9xX]|b0[a-z0-9]{8})$/i

function amazonLink(target: string, country: string): string | null {
  if (!ASIN_RE.test(target)) return null
  const tld = COUNTRY_TLD[country.toUpperCase()] ?? 'com'
  return `https://www.amazon.${tld}/dp/${target.toUpperCase()}`
}

export default async function RecommendationsPage() {
  const sql = neon(process.env.DATABASE_URL!)

  const [rows, allCampaigns, dailyAgg, allAdGroups] = (await Promise.all([
    sql`
      SELECT
        r.id,
        r.rec_type,
        r.target_text,
        r.proposal,
        r.status,
        r.created_at::text,
        p.country_code,
        p.profile_id::text,
        p.currency_code,
        r.evidence
      FROM recommendations r
      JOIN amazon_profiles p USING (profile_id)
      ORDER BY
        CASE r.status WHEN 'DRAFT' THEN 0 ELSE 1 END,
        r.rec_type,
        r.id
    `,
    sql`
      SELECT profile_id::text, campaign_id, name, state
      FROM amazon_campaigns
    `,
    sql`
      SELECT
        profile_id::text,
        campaign_id,
        sum(cost)::text       AS spend_30d,
        sum(sales_14d)::text  AS sales_30d,
        (sum(cost) / nullif(sum(sales_14d), 0))::text AS acos
      FROM amazon_campaign_daily
      WHERE date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY profile_id, campaign_id
    `,
    sql`
      SELECT profile_id::text, ad_group_id, name
      FROM amazon_ad_groups
    `,
  ])) as unknown as [RecRow[], CampaignInfo[], DailyAgg[], AdGroupInfo[]]

  // Lookup maps
  const campMap = new Map<string, { name: string; state: string }>()
  for (const c of allCampaigns) {
    campMap.set(`${c.profile_id}:${c.campaign_id}`, { name: c.name, state: c.state })
  }

  const dailyMap = new Map<string, { spend_30d: string; sales_30d: string; acos: string | null }>()
  for (const d of dailyAgg) {
    dailyMap.set(`${d.profile_id}:${d.campaign_id}`, {
      spend_30d: d.spend_30d,
      sales_30d: d.sales_30d,
      acos: d.acos,
    })
  }

  const adGroupMap = new Map<string, string>() // "profileId:adGroupId" → name
  for (const ag of allAdGroups) {
    adGroupMap.set(`${ag.profile_id}:${ag.ad_group_id}`, ag.name)
  }

  const draftRows    = rows.filter(r => r.status === 'DRAFT')
  const nonDraftRows = rows.filter(r => r.status !== 'DRAFT')

  // Group DRAFTs by rec_type; sort within each group by evidence.spend desc
  const draftByType = new Map<string, RecRow[]>()
  for (const row of draftRows) {
    if (!draftByType.has(row.rec_type)) draftByType.set(row.rec_type, [])
    draftByType.get(row.rec_type)!.push(row)
  }
  for (const group of draftByType.values()) {
    group.sort((a, b) => (b.evidence.spend ?? 0) - (a.evidence.spend ?? 0))
  }

  const nonDraftCounts = new Map<string, number>()
  for (const row of nonDraftRows) {
    nonDraftCounts.set(row.status, (nonDraftCounts.get(row.status) ?? 0) + 1)
  }

  // ── Evidence stat block ──────────────────────────────────────────────────
  function EvStats({ ev, currency }: { ev: Evidence; currency: string }) {
    const acosRatio = ev.acos ?? (ev.spend && ev.sales ? ev.spend / ev.sales : null)
    const acosPct   = acosRatio != null ? acosRatio * 100 : null
    const tgtPct    = (ev.params_used?.target_acos ?? 0.30) * 100
    return (
      <div className="ev-stats">
        <div>
          <div className="ev-stat-label">Spend</div>
          <div>{fmtN(ev.spend)} {currency}</div>
        </div>
        <div>
          <div className="ev-stat-label">Clicks</div>
          <div>{ev.clicks ?? '—'}</div>
        </div>
        <div>
          <div className="ev-stat-label">Orders</div>
          <div>{ev.orders ?? '—'}</div>
        </div>
        <div>
          <div className="ev-stat-label">Sales</div>
          <div>{fmtN(ev.sales)} {currency}</div>
        </div>
        <div>
          <div className="ev-stat-label">ACOS</div>
          <div>
            {acosPct != null
              ? <span className={acosPct <= tgtPct ? 'badge badge-ok' : 'badge badge-warn'}>
                  {acosPct.toFixed(1)}%
                </span>
              : '—'}
            {' '}
            <span style={{ color: 'var(--cdl-muted)', fontSize: '0.8em' }}>
              tgt {tgtPct.toFixed(0)}%
            </span>
          </div>
        </div>
        <div>
          <div className="ev-stat-label">Window</div>
          <div style={{ fontSize: '0.85em', whiteSpace: 'nowrap' }}>
            {ev.window_start ?? '—'} → {ev.window_end ?? '—'}
          </div>
        </div>
      </div>
    )
  }

  // ── Why line ─────────────────────────────────────────────────────────────
  function WhyLine({ recType, ev, term, currency }: { recType: string; ev: Evidence; term: string; currency: string }) {
    const orders    = ev.orders ?? 0
    const spend     = fmtN(ev.spend)
    const clicks    = ev.clicks ?? 0
    const acosRatio = ev.acos ?? (ev.spend && ev.sales ? ev.spend / ev.sales : null)
    const acosPct   = acosRatio != null ? (acosRatio * 100).toFixed(1) : '—'
    const tgtPct    = ((ev.params_used?.target_acos ?? 0.30) * 100).toFixed(0)
    let sentence: string
    if (recType === 'PROMOTE_ASIN') {
      sentence = `Your ads shown on this book's product page produced ${orders} orders at ${acosPct}% ACOS (${spend} ${currency} spend) — below your ${tgtPct}% target. Proposal: add it as an explicit product target.`
    } else if (recType === 'PROMOTE_TERM') {
      sentence = `Shoppers searching '${term}' bought ${orders} times at ${acosPct}% ACOS — below your ${tgtPct}% target. Proposal: add it as an exact-match keyword.`
    } else if (recType === 'NEGATE_TERM') {
      sentence = `This term spent ${spend} ${currency} over ${clicks} clicks with zero orders. It was negated to stop the spend.`
    } else {
      return null
    }
    return (
      <p style={{
        margin: '0 0 0.6rem 0',
        fontSize: '0.88rem',
        color: 'var(--cdl-fg)',
        lineHeight: 1.5,
      }}>
        {sentence}
      </p>
    )
  }

  // ── "Applies to" table ───────────────────────────────────────────────────
  function AppliesTo({ ev, profileId, currency }: { ev: Evidence; profileId: string; currency: string }) {
    const placements = (ev.placements ?? []).slice().sort((a, b) => b.spend - a.spend)
    if (placements.length === 0) return null
    const primaryId = ev.primary_placement?.ad_group_id
    return (
      <div style={{ marginTop: '0.85rem' }}>
        <div style={{
          fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.05em', color: 'var(--cdl-muted)', marginBottom: '0.4rem',
        }}>
          Where this happened (evidence)
        </div>
        <div className="table-card" style={{ marginBottom: 0 }}>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Ad Group</th>
                  <th>Campaign</th>
                  <th>State</th>
                  <th>Spend</th>
                  <th>Clicks</th>
                  <th>Orders</th>
                  <th>Sales</th>
                </tr>
              </thead>
              <tbody>
                {placements.map((p) => {
                  const campKey   = `${profileId}:${p.campaign_id}`
                  const agKey     = `${profileId}:${p.ad_group_id}`
                  const camp      = campMap.get(campKey)
                  const agName    = adGroupMap.get(agKey)
                  const isPrimary = p.ad_group_id === primaryId
                  const primaryPill = isPrimary ? (
                    <span style={{
                      marginLeft: '0.4em',
                      fontSize: '0.72rem', fontWeight: 700,
                      background: 'var(--cdl-blue)', color: '#fff',
                      borderRadius: '0.3em', padding: '0.1em 0.4em',
                      whiteSpace: 'nowrap',
                    }}>
                      → will be added here if approved
                    </span>
                  ) : null
                  return (
                    <tr key={`${p.campaign_id}:${p.ad_group_id}`}>
                      <td>
                        {agName
                          ? <span>{agName}{primaryPill}</span>
                          : (
                              <span style={{ color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
                                {p.ad_group_id} (not in sync){primaryPill}
                              </span>
                            )}
                      </td>
                      <td style={{ maxWidth: '16em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {camp
                          ? (
                              <a
                                href={`/campaigns/${profileId}/${encodeURIComponent(p.campaign_id)}`}
                                style={{ color: 'var(--cdl-blue)' }}
                                title={camp.name}
                              >
                                {camp.name}
                              </a>
                            )
                          : (
                              <span style={{ color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
                                {p.campaign_id} (not in sync)
                              </span>
                            )}
                      </td>
                      <td>
                        {camp
                          ? <span className={stateBadgeCls(camp.state)}>{camp.state}</span>
                          : '—'}
                      </td>
                      <td className="num">{p.spend.toFixed(2)} {currency}</td>
                      <td className="num">{p.clicks}</td>
                      <td className="num">{p.orders}</td>
                      <td className="num">{p.sales.toFixed(2)} {currency}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )
  }

  // ── Push receipts (NEGATE_TERM ruled rows) ───────────────────────────────
  function PushReceipts({ ev }: { ev: Evidence }) {
    const kw  = ev.pushed_keyword_ids ?? []
    const tgt = ev.pushed_target_ids  ?? []
    if (kw.length === 0 && tgt.length === 0) return null
    return (
      <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--cdl-muted)', lineHeight: 1.6 }}>
        {kw.length > 0 && (
          <div>
            <span style={{ fontWeight: 700 }}>Keyword IDs pushed: </span>
            {kw.join(', ')}
          </div>
        )}
        {tgt.length > 0 && (
          <div>
            <span style={{ fontWeight: 700 }}>Target IDs pushed: </span>
            {tgt.join(', ')}
          </div>
        )}
      </div>
    )
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
                  <span style={{
                    color: 'var(--cdl-muted)', fontWeight: 400,
                    fontFamily: 'inherit', fontSize: '0.9rem',
                  }}>
                    — {typeRows.length} draft{typeRows.length !== 1 ? 's' : ''}
                  </span>
                </h2>

                {typeRows.map(r => (
                  <details key={r.id} className="rec-card">
                    <summary>
                      <span className={recTypeBadge(r.rec_type)}>{r.rec_type}</span>
                      <span style={{ fontWeight: 600, flexShrink: 0 }}>
                        {(() => { const url = amazonLink(r.target_text, r.country_code); return url ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--cdl-blue)' }}>{r.target_text}</a> : r.target_text })()}
                      </span>
                      <span style={{
                        color: 'var(--cdl-muted)', flex: 1, minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {r.proposal}
                      </span>
                      <span style={{ color: 'var(--cdl-muted)', fontSize: '0.82rem', flexShrink: 0 }}>
                        {r.country_code}
                      </span>
                      <form action={approveRecommendation} style={{ display: 'inline', flexShrink: 0 }}>
                        <input type="hidden" name="id" value={r.id} />
                        <button type="submit" className="btn-approve">Approve</button>
                      </form>
                      <form action={rejectRecommendation} style={{ display: 'inline', flexShrink: 0 }}>
                        <input type="hidden" name="id" value={r.id} />
                        <button type="submit" className="btn-reject">Reject</button>
                      </form>
                    </summary>

                    <div className="rec-card-body">
                      <WhyLine recType={r.rec_type} ev={r.evidence} term={r.target_text} currency={r.currency_code} />
                      <EvStats ev={r.evidence} currency={r.currency_code} />
                      <AppliesTo ev={r.evidence} profileId={r.profile_id} currency={r.currency_code} />
                    </div>
                  </details>
                ))}
              </div>
            ))
          )}

          {/* ── Ruled section — collapsed ── */}
          {nonDraftRows.length > 0 && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary style={{
                cursor: 'pointer',
                fontFamily: 'var(--font-fraunces, Fraunces, Georgia, serif)',
                fontSize: '1.1rem', fontWeight: 700, color: 'var(--cdl-muted)',
                padding: '0.5rem 0',
              }}>
                Ruled ({nonDraftRows.length}){' '}
                <span style={{ fontWeight: 400, fontSize: '0.82rem' }}>
                  — {(['APPROVED', 'REJECTED', 'PUSHED'] as const)
                    .map(s => `${s} ${nonDraftCounts.get(s) ?? 0}`)
                    .join(' · ')}
                </span>
              </summary>

              <div style={{ marginTop: '0.75rem' }}>
                {nonDraftRows.map(r => (
                  <details key={r.id} className="rec-card">
                    <summary>
                      <span className={recTypeBadge(r.rec_type)}>{r.rec_type}</span>
                      <span style={{ fontWeight: 600, flexShrink: 0 }}>
                        {(() => { const url = amazonLink(r.target_text, r.country_code); return url ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--cdl-blue)' }}>{r.target_text}</a> : r.target_text })()}
                      </span>
                      <span style={{
                        color: 'var(--cdl-muted)', flex: 1, minWidth: 0,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>
                        {r.proposal}
                      </span>
                      <span style={{ color: 'var(--cdl-muted)', fontSize: '0.82rem', flexShrink: 0 }}>
                        {r.country_code}
                      </span>
                      <span className={statusBadgeCls(r.status)}>{r.status}</span>
                    </summary>

                    <div className="rec-card-body">
                      <WhyLine recType={r.rec_type} ev={r.evidence} term={r.target_text} currency={r.currency_code} />
                      <EvStats ev={r.evidence} currency={r.currency_code} />
                      <AppliesTo ev={r.evidence} profileId={r.profile_id} currency={r.currency_code} />
                      {r.rec_type === 'NEGATE_TERM' && (
                        <PushReceipts ev={r.evidence} />
                      )}
                    </div>
                  </details>
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  )
}
