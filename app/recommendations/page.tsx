export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { PushAllButton } from './PushAllButton'
import type { ProfileMeta } from './PushAllButton'
import { RecCard, type RecCardContext, type RecRow, type DestTargetRow } from '@/app/components/RecCard'

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

// ── Page ──────────────────────────────────────────────────────────────────
export default async function RecommendationsPage() {
  const sql = neon(process.env.DATABASE_URL!)

  // ── Main queries ───────────────────────────────────────────────────────
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
  ])) as unknown as [RecRow[], CampaignInfo[], DailyAgg[], AdGroupInfo[]]

  // ── Primary lookup maps ────────────────────────────────────────────────
  const campMap = new Map<string, { name: string; state: string }>()
  for (const c of allCampaigns) {
    campMap.set(`${c.profile_id}:${c.campaign_id}`, { name: c.name, state: c.state })
  }

  const adGroupMap = new Map<string, string>()
  for (const ag of allAdGroups) {
    adGroupMap.set(`${ag.profile_id}:${ag.ad_group_id}`, ag.name)
  }

  // ── Collect IDs for supplemental queries ───────────────────────────────
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

  // ── Supplemental queries ───────────────────────────────────────────────
  let destTargetRows:   DestTargetRow[]   = []
  let targetAcosRows:   TargetAcosRow[]   = []
  let bidAdjStateRows:  BidAdjStateRow[]  = []

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
      WHERE target_id    = ANY(${bidAdjTargetIds})
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

  // targetAcosMap built for future use
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

  // ── RecCard context ────────────────────────────────────────────────────
  const ctx: RecCardContext = { adGroupMap, campMap, bidAdjStateMap, destTargetsMap }

  // ── Group DRAFTs ───────────────────────────────────────────────────────
  const draftRows    = rows.filter(r => r.status === 'DRAFT')
  const nonDraftRows = rows.filter(r => r.status !== 'DRAFT')

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

  // ── Push-all: approved count + per-profile metadata ───────────────────
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

  // Suppress unused-variable warning — dailyAgg retained for future use
  void dailyAgg

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <div>
      <h1>Recommendations</h1>

      <PushAllButton totalApproved={totalApproved} profiles={approvedProfiles} />

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
                {typeRows.map(r => <RecCard key={r.id} rec={r} ctx={ctx} />)}
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
                {nonDraftRows.map(r => <RecCard key={r.id} rec={r} ctx={ctx} />)}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  )
}
