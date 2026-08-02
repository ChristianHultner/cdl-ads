export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { PushAllButton } from './PushAllButton'
import type { ProfileMeta } from './PushAllButton'
import { RecCard, type RecCardContext, type RecRow, type DestTargetRow, type RecOutcomeRow } from '@/app/components/RecCard'
import { evidenceCampaignId } from '@/app/lib/rec-scope'

// ── Local interfaces (page-query shapes only) ─────────────────────────────
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

interface TargetAcosRow {
  profile_id: string
  ad_group_id: string
  search_term_lower: string
  spend: string
  orders: string
  sales: string
}

interface BidAdjStateRow {
  target_id: string
  state: string
}

interface CampDraftCount {
  profile_id: string
  resolved_campaign_id: string
  draft_count: string
}

// ── Page ──────────────────────────────────────────────────────────────────
export default async function RecommendationsPage() {
  const sql = neon(process.env.DATABASE_URL!)

  // ── Main queries ───────────────────────────────────────────────────────
  const [rows, allCampaigns, dailyAgg, allAdGroups, campDraftCounts] = (await Promise.all([
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
    sql`SELECT profile_id::text, campaign_id, name, state FROM amazon_campaigns`,
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
    sql`SELECT profile_id::text, ad_group_id, name FROM amazon_ad_groups`,
    // Per-campaign DRAFT counts with full scoping (for scoreboard badges).
    // Priority: campaign_id col → evidence.campaign_id → resolved_destination.campaign_id
    //           → destination_ad_group_id resolved through amazon_ad_groups
    sql`
      SELECT
        r.profile_id::text,
        COALESCE(
          r.campaign_id::text,
          r.evidence->>'campaign_id',
          r.evidence->'resolved_destination'->>'campaign_id',
          ag.campaign_id::text
        ) AS resolved_campaign_id,
        count(*)::text AS draft_count
      FROM recommendations r
      LEFT JOIN amazon_ad_groups ag
        ON  (r.evidence->>'destination_ad_group_id')::text = ag.ad_group_id::text
        AND r.campaign_id IS NULL
        AND r.evidence->>'campaign_id' IS NULL
        AND r.evidence->'resolved_destination'->>'campaign_id' IS NULL
      WHERE r.status = 'DRAFT'
      GROUP BY
        r.profile_id,
        COALESCE(
          r.campaign_id::text,
          r.evidence->>'campaign_id',
          r.evidence->'resolved_destination'->>'campaign_id',
          ag.campaign_id::text
        )
      HAVING COALESCE(
        r.campaign_id::text,
        r.evidence->>'campaign_id',
        r.evidence->'resolved_destination'->>'campaign_id',
        ag.campaign_id::text
      ) IS NOT NULL
      ORDER BY count(*) DESC
    `,
  ])) as unknown as [RecRow[], CampaignInfo[], DailyAgg[], AdGroupInfo[], CampDraftCount[]]

  // ── Primary lookup maps ────────────────────────────────────────────────
  const campMap = new Map<string, { name: string; state: string }>()
  for (const c of allCampaigns) {
    campMap.set(`${c.profile_id}:${c.campaign_id}`, { name: c.name, state: c.state })
  }

  const adGroupMap = new Map<string, string>()
  for (const ag of allAdGroups) {
    adGroupMap.set(`${ag.profile_id}:${ag.ad_group_id}`, ag.name)
  }

  // ── Collect IDs for supplemental queries (RecCard ctx for ruled section) ─
  const promoteAsinRecs = rows.filter(r => r.rec_type === 'PROMOTE_ASIN')
  const bidAdjRecs      = rows.filter(r => r.rec_type === 'BID_ADJUST')

  const destAgProfileIds = [...new Set(promoteAsinRecs.map(r => r.profile_id))]
  const destAgIds        = [
    ...new Set(
      promoteAsinRecs
        .map(r => r.evidence.primary_placement?.ad_group_id)
        .filter((x): x is string => x != null),
    ),
  ]
  const bidAdjTargetIds  = [
    ...new Set(
      bidAdjRecs
        .map(r => r.evidence.chosen_target?.target_id)
        .filter((x): x is string => x != null),
    ),
  ]
  const bidAdjProfileIds = [...new Set(bidAdjRecs.map(r => r.profile_id))]

  // ── BID_ADJUST entity name resolution (batch, no N–1) ──────────────────
  interface KwNameRow  { entity_id: string; keyword_text: string; match_type: string }
  interface TgtNameRow { entity_id: string; resolved_asin: string | null; expression: unknown }

  const kwEntityIds = [...new Set(
    bidAdjRecs
      .filter(r => r.evidence.entity_kind === 'KEYWORD')
      .map(r => r.evidence.entity_id)
      .filter((x): x is string => x != null),
  )]
  const tgtEntityIds = [...new Set(
    bidAdjRecs
      .filter(r => r.evidence.entity_kind === 'TARGET' || r.evidence.entity_kind === 'AUTO_STRATEGY')
      .map(r => r.evidence.entity_id)
      .filter((x): x is string => x != null),
  )]

  const entityKindByEntityId = new Map<string, string>()
  for (const r of bidAdjRecs) {
    if (r.evidence.entity_id && r.evidence.entity_kind) {
      entityKindByEntityId.set(r.evidence.entity_id, r.evidence.entity_kind)
    }
  }

  let kwNameRows:  KwNameRow[]  = []
  let tgtNameRows: TgtNameRow[] = []

  if (kwEntityIds.length > 0 && bidAdjProfileIds.length > 0) {
    kwNameRows = (await sql`
      SELECT keyword_id::text AS entity_id, keyword_text, match_type
      FROM amazon_keywords
      WHERE profile_id::text = ANY(${bidAdjProfileIds})
        AND keyword_id::text = ANY(${kwEntityIds})
    `) as unknown as KwNameRow[]
  }
  if (tgtEntityIds.length > 0 && bidAdjProfileIds.length > 0) {
    tgtNameRows = (await sql`
      SELECT target_id::text AS entity_id, resolved_asin, expression
      FROM amazon_targets
      WHERE profile_id::text = ANY(${bidAdjProfileIds})
        AND target_id::text  = ANY(${tgtEntityIds})
    `) as unknown as TgtNameRow[]
  }

  const AUTO_EXPR_LABEL: Record<string, string> = {
    'close-match':             'Close Match',
    'loose-match':             'Loose Match',
    'substitutes':             'Substitutes',
    'complements':             'Complements',
    'QUERY_HIGH_REL_MATCHES':  'Close Match',
    'QUERY_BROAD_REL_MATCHES': 'Loose Match',
    'ASIN_SUBSTITUTE_RELATED': 'Substitutes',
    'ASIN_ACCESSORY_RELATED':  'Complements',
  }

  const bidAdjNameMap = new Map<string, string>()
  for (const row of kwNameRows) {
    const matchTag = row.match_type ? ` [${row.match_type}]` : ''
    bidAdjNameMap.set(row.entity_id, `${row.keyword_text}${matchTag}`)
  }
  for (const row of tgtNameRows) {
    const kind = entityKindByEntityId.get(row.entity_id)
    if (kind === 'AUTO_STRATEGY') {
      const exprArr = Array.isArray(row.expression) ? (row.expression as Array<{ type?: string }>) : []
      const rawType = exprArr[0]?.type ?? null
      bidAdjNameMap.set(row.entity_id, (rawType && AUTO_EXPR_LABEL[rawType]) ?? 'Auto')
    } else if (row.resolved_asin) {
      bidAdjNameMap.set(row.entity_id, row.resolved_asin)
    }
  }

  // ── Supplemental queries ───────────────────────────────────────────────
  let destTargetRows:  DestTargetRow[]  = []
  let targetAcosRows:  TargetAcosRow[]  = []
  let bidAdjStateRows: BidAdjStateRow[] = []

  if (destAgIds.length > 0) {
    ;[destTargetRows, targetAcosRows] = (await Promise.all([
      sql`
        SELECT
          target_id,
          ad_group_id,
          profile_id::text AS profile_id,
          state,
          expression_type,
          resolved_asin,
          bid::text
        FROM amazon_targets
        WHERE profile_id::text = ANY(${destAgProfileIds})
          AND ad_group_id      = ANY(${destAgIds})
        ORDER BY ad_group_id, resolved_asin NULLS LAST
      `,
      sql`
        SELECT
          profile_id::text,
          ad_group_id,
          lower(search_term) AS search_term_lower,
          sum(cost)::text          AS spend,
          sum(purchases_14d)::text AS orders,
          sum(sales_14d)::text     AS sales
        FROM amazon_search_term_daily
        WHERE profile_id::text = ANY(${destAgProfileIds})
          AND ad_group_id      = ANY(${destAgIds})
          AND date >= CURRENT_DATE - INTERVAL '60 days'
        GROUP BY profile_id, ad_group_id, lower(search_term)
      `,
    ])) as unknown as [DestTargetRow[], TargetAcosRow[]]
  }

  if (bidAdjTargetIds.length > 0) {
    bidAdjStateRows = (await sql`
      SELECT target_id, state
      FROM amazon_targets
      WHERE target_id      = ANY(${bidAdjTargetIds})
        AND profile_id::text = ANY(${bidAdjProfileIds})
    `) as unknown as BidAdjStateRow[]
  }

  // ── Supplemental maps ──────────────────────────────────────────────────
  const destTargetsMap = new Map<string, DestTargetRow[]>()
  for (const t of destTargetRows) {
    const key = `${t.profile_id}:${t.ad_group_id}`
    if (!destTargetsMap.has(key)) destTargetsMap.set(key, [])
    destTargetsMap.get(key)!.push(t)
  }

  // targetAcosMap retained for future use
  const _targetAcosMap = new Map<string, { spend: string; orders: string; sales: string }>()
  for (const row of targetAcosRows) {
    _targetAcosMap.set(
      `${row.profile_id}:${row.ad_group_id}:${row.search_term_lower}`,
      { spend: row.spend, orders: row.orders, sales: row.sales },
    )
  }

  const bidAdjStateMap = new Map<string, string>()
  for (const row of bidAdjStateRows) {
    bidAdjStateMap.set(row.target_id, row.state)
  }

  // ── rec_outcomes — one IN query for all PUSHED recs (no N+1) ─────────
  const pushedIds = rows.filter(r => r.status === 'PUSHED').map(r => r.id)
  let outcomeRows: RecOutcomeRow[] = []
  if (pushedIds.length > 0) {
    outcomeRows = (await sql`
      SELECT rec_id::text, horizon, captured_at::text, metrics
      FROM rec_outcomes
      WHERE rec_id = ANY(${pushedIds})
    `) as unknown as RecOutcomeRow[]
  }
  const outcomesMap = new Map<string, RecOutcomeRow[]>()
  for (const o of outcomeRows) {
    if (!outcomesMap.has(o.rec_id)) outcomesMap.set(o.rec_id, [])
    outcomesMap.get(o.rec_id)!.push(o)
  }

  // ── RecCard context (for ruled section) ───────────────────────────────
  const ctx: RecCardContext = { adGroupMap, campMap, bidAdjStateMap, destTargetsMap, outcomesMap, bidAdjNameMap }

  // ── Partition rows ─────────────────────────────────────────────────────
  const draftRows    = rows.filter(r => r.status === 'DRAFT')
  const nonDraftRows = rows.filter(r => r.status !== 'DRAFT')

  // Unattributed DRAFT recs: no campaign from any TypeScript-visible leg (1–3)
  // AND no destination_ad_group_id (leg 4 resolves via amazon_ad_groups in SQL).
  // CREATE_STRUCTURE, bare NEGATE_TERMs, etc. surface here for approve/reject.
  const unattributedDraftRows = draftRows.filter(r =>
    evidenceCampaignId(null, r.evidence) === null &&
    r.evidence.destination_ad_group_id == null,
  )

  const nonDraftCounts = new Map<string, number>()
  for (const row of nonDraftRows) {
    nonDraftCounts.set(row.status, (nonDraftCounts.get(row.status) ?? 0) + 1)
  }

  // ── PushAllButton data ─────────────────────────────────────────────────
  const approvedRows   = nonDraftRows.filter(r => r.status === 'APPROVED')
  const totalApproved  = approvedRows.length
  const profileApprMap = new Map<string, { count: number; country: string }>()
  for (const r of approvedRows) {
    const entry = profileApprMap.get(r.profile_id) ?? { count: 0, country: r.country_code }
    entry.count++
    profileApprMap.set(r.profile_id, entry)
  }
  const approvedProfiles: ProfileMeta[] = Array.from(profileApprMap.entries()).map(
    ([profileId, { count, country }]) => ({ profileId, label: country, count }),
  )

  // Per-rec_type approved counts for Push button breakdown
  const approvedByType: Record<string, number> = {}
  for (const r of approvedRows) {
    approvedByType[r.rec_type] = (approvedByType[r.rec_type] ?? 0) + 1
  }

  // ── Scoreboard derived data ────────────────────────────────────────────
  const draftByProfile = new Map<string, number>()
  for (const r of draftRows) {
    draftByProfile.set(r.profile_id, (draftByProfile.get(r.profile_id) ?? 0) + 1)
  }

  const approvedByProfile = new Map<string, number>()
  for (const r of approvedRows) {
    approvedByProfile.set(r.profile_id, (approvedByProfile.get(r.profile_id) ?? 0) + 1)
  }

  // Profile info (country / currency) from any row for that profile
  const profileInfoMap = new Map<string, { country: string; currency: string }>()
  for (const r of rows) {
    if (!profileInfoMap.has(r.profile_id)) {
      profileInfoMap.set(r.profile_id, { country: r.country_code, currency: r.currency_code })
    }
  }

  // Campaign badges per profile — SQL already sorted by count DESC
  const campBadgesMap = new Map<string, Array<{ campaignId: string; name: string; count: number }>>()
  for (const row of campDraftCounts) {
    const camp = campMap.get(`${row.profile_id}:${row.resolved_campaign_id}`)
    const name = camp?.name ?? row.resolved_campaign_id
    if (!campBadgesMap.has(row.profile_id)) campBadgesMap.set(row.profile_id, [])
    campBadgesMap.get(row.profile_id)!.push({
      campaignId: row.resolved_campaign_id,
      name,
      count: parseInt(row.draft_count, 10),
    })
  }

  // All profiles with open (DRAFT or APPROVED) recs, sorted by draft count desc
  const openProfileIds = [
    ...new Set([
      ...draftRows.map(r => r.profile_id),
      ...approvedRows.map(r => r.profile_id),
    ]),
  ].sort((a, b) => (draftByProfile.get(b) ?? 0) - (draftByProfile.get(a) ?? 0))

  // Suppress unused-variable warnings
  void dailyAgg

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div>
      <h1>Recommendations</h1>

      {/* ── Push button (top, unchanged) ── */}
      <PushAllButton totalApproved={totalApproved} profiles={approvedProfiles} recTypeCounts={approvedByType} />

      {/* ── Empty state ── */}
      {openProfileIds.length === 0 ? (
        <p style={{ color: 'var(--cdl-muted)', marginBottom: '1.5rem' }}>
          No open recommendations — the queue is clear.
        </p>
      ) : (
        /* ── Scoreboard ── */
        <div className="table-card" style={{ marginBottom: '2rem' }}>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="num">Draft</th>
                  <th className="num">Approved</th>
                  <th>Campaigns with drafts</th>
                </tr>
              </thead>
              <tbody>
                {openProfileIds.map(pid => {
                  const info     = profileInfoMap.get(pid) ?? { country: '??', currency: '??' }
                  const draft    = draftByProfile.get(pid)    ?? 0
                  const approved = approvedByProfile.get(pid) ?? 0
                  const badges   = campBadgesMap.get(pid)     ?? []
                  const visible  = badges.slice(0, 6)
                  const overflow = badges.length > 6 ? badges.length - 6 : 0
                  return (
                    <tr key={pid}>
                      <td>{info.country} ({info.currency})</td>
                      <td className="num">
                        {draft > 0
                          ? <span className="badge badge-blue">{draft}</span>
                          : '—'}
                      </td>
                      <td className="num">
                        {approved > 0
                          ? <span className="badge badge-ok">{approved}</span>
                          : '—'}
                      </td>
                      <td>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', alignItems: 'center' }}>
                          {visible.map(b => {
                            const dn = b.name.length > 24 ? b.name.slice(0, 24) : b.name
                            return (
                              <a
                                key={b.campaignId}
                                href={`/amazon/campaigns/${pid}/${encodeURIComponent(b.campaignId)}#recs`}
                                style={{ textDecoration: 'none' }}
                              >
                                <span className="badge badge-blue">{dn} ({b.count})</span>
                              </a>
                            )
                          })}
                          {overflow > 0 && (
                            <a href="/amazon/campaigns" style={{ textDecoration: 'none' }}>
                              <span className="badge badge-muted">+{overflow} more</span>
                            </a>
                          )}
                          {badges.length === 0 && draft > 0 && (
                            <span style={{ fontSize: '0.82rem', color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
                              unattributed
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Needs review (unattributed) ── */}
      {unattributedDraftRows.length > 0 && (
        <div style={{ marginBottom: '2rem' }}>
          <h2 style={{ marginBottom: '0.75rem' }}>
            Needs review{' '}
            <span style={{
              color:      'var(--cdl-muted)',
              fontWeight: 400,
              fontFamily: 'inherit',
              fontSize:   '0.9rem',
            }}>
              — unattributed ({unattributedDraftRows.length})
            </span>
          </h2>
          {unattributedDraftRows.map(r => <RecCard key={r.id} rec={r} ctx={ctx} />)}
        </div>
      )}

            {/* ── Ruled section — collapsed if present, else lifetime tally ── */}
      {nonDraftRows.length > 0 ? (
        <details style={{ marginTop: '0.5rem' }}>
          <summary style={{
            cursor: 'pointer',
            fontFamily: 'var(--font-fraunces, Fraunces, Georgia, serif)',
            fontSize: '1.1rem', fontWeight: 700, color: 'var(--cdl-muted)',
            padding: '0.5rem 0',
          }}>
            Ruled ({nonDraftRows.length}){' '}
            <span style={{ fontWeight: 400, fontSize: '0.82rem' }}>
              {'— '}PUSHED {nonDraftCounts.get('PUSHED') ?? 0}
              {' · '}APPROVED {nonDraftCounts.get('APPROVED') ?? 0}
              {' · '}REJECTED {nonDraftCounts.get('REJECTED') ?? 0}
              {' · '}<span className="badge badge-hold">{nonDraftCounts.get('HELD') ?? 0} HELD</span>
            </span>
          </summary>
          <div style={{ marginTop: '0.75rem' }}>
            {nonDraftRows.map(r => <RecCard key={r.id} rec={r} ctx={ctx} />)}
          </div>
        </details>
      ) : (
        <p style={{ color: 'var(--cdl-muted)', fontSize: '0.85rem', marginTop: '1rem' }}>
          Ruled all-time: {nonDraftRows.length}{' '}
          (PUSHED {nonDraftCounts.get('PUSHED') ?? 0}{' '}
          · REJECTED {nonDraftCounts.get('REJECTED') ?? 0}{' '}
          · SKIPPED {nonDraftCounts.get('SKIPPED') ?? 0}{' '}
          · HELD {nonDraftCounts.get('HELD') ?? 0})
        </p>
      )}
    </div>
  )
}
