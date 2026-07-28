export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

interface MarketRow {
  profile_id: string
  country_code: string
  currency_code: string
  spend_30d: string
  sales_30d: string
  acos: string | null
}

interface CampaignRow {
  profile_id: string
  campaign_id: string
  campaign_name: string
  state: string
  spend_30d: string
  sales_30d: string
  acos: string | null
  budget_amount: string | null
  budget_type: string | null
}

interface CampaignCount {
  profile_id: string
  total: string
}

interface RecCount {
  profile_id: string
  resolved_campaign_id: string
  rec_count: string
}

interface AcosParam {
  scope: string
  value: string
}

function stateBadgeCls(state: string): string {
  const s = state.toUpperCase()
  if (s === 'ENABLED')  return 'badge badge-ok'
  if (s === 'ARCHIVED') return 'badge badge-dim'
  return 'badge badge-muted' // PAUSED + others
}

function fmt(v: string): string {
  return parseFloat(v).toFixed(2)
}

function computeAcos(spend: string, sales: string): string | null {
  const sa = parseFloat(sales)
  if (!sa) return null
  return ((parseFloat(spend) / sa) * 100).toFixed(1)
}

export default async function CampaignsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const sp = await searchParams
  const raw = Array.isArray(sp.state) ? sp.state[0] : sp.state
  const stateFilter = (raw ?? 'enabled').toLowerCase()

  const sql = neon(process.env.DATABASE_URL!)

  const [markets, allCampaigns, campaignCounts, draftRecs, acosParams] =
    (await Promise.all([
      // Active profiles ordered by 30d spend desc
      sql`
        SELECT
          ap.profile_id::text,
          ap.country_code,
          ap.currency_code,
          sum(acd.cost)::text                                     AS spend_30d,
          sum(acd.sales_14d)::text                                AS sales_30d,
          (sum(acd.cost) / nullif(sum(acd.sales_14d), 0))::text  AS acos
        FROM amazon_campaign_daily acd
        JOIN amazon_profiles ap USING (profile_id)
        WHERE acd.date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY ap.profile_id, ap.country_code, ap.currency_code
        HAVING sum(acd.cost) > 0
        ORDER BY sum(acd.cost) DESC
      `,
      // All ENABLED+PAUSED campaigns — LEFT JOIN daily so newborns (zero spend) still appear
      sql`
        SELECT
          c.profile_id::text,
          c.campaign_id,
          c.name                                              AS campaign_name,
          c.state,
          coalesce(sum(d.cost), 0)::text                      AS spend_30d,
          coalesce(sum(d.sales_14d), 0)::text                 AS sales_30d,
          (sum(d.cost) / nullif(sum(d.sales_14d), 0))::text  AS acos,
          c.budget_amount::text,
          c.budget_type
        FROM amazon_campaigns c
        LEFT JOIN amazon_campaign_daily d
          ON  d.campaign_id = c.campaign_id
          AND d.profile_id  = c.profile_id
          AND d.date >= CURRENT_DATE - INTERVAL '30 days'
        WHERE c.state IN ('ENABLED', 'PAUSED')
        GROUP BY c.profile_id, c.campaign_id, c.name, c.state, c.budget_amount, c.budget_type
        ORDER BY c.profile_id, sum(d.cost) DESC NULLS LAST
      `,
      // Total campaign count per profile (all states)
      sql`
        SELECT profile_id::text, count(*)::text AS total
        FROM amazon_campaigns
        GROUP BY profile_id
      `,
      // DRAFT rec counts — full campaign scoping:
      //   1. recommendations.campaign_id::text
      //   2. evidence->>'campaign_id'
      //   3. evidence->'resolved_destination'->>'campaign_id'
      //   4. evidence->>'destination_ad_group_id' → amazon_ad_groups.campaign_id
      sql`
        SELECT
          r.profile_id::text,
          COALESCE(
            r.campaign_id::text,
            r.evidence->>'campaign_id',
            r.evidence->'resolved_destination'->>'campaign_id',
            ag.campaign_id::text
          ) AS resolved_campaign_id,
          count(*)::text AS rec_count
        FROM recommendations r
        LEFT JOIN amazon_ad_groups ag
          ON  (r.evidence->>'destination_ad_group_id')::text = ag.ad_group_id::text
          AND ag.profile_id = r.profile_id
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
      `,
      // target_acos params
      sql`
        SELECT scope, value::text
        FROM engine_parameters
        WHERE key = 'target_acos'
      `,
    ])) as unknown as [MarketRow[], CampaignRow[], CampaignCount[], RecCount[], AcosParam[]]

  const activeIds = new Set(markets.map(m => m.profile_id))

  // Bucket campaigns by profile
  const campsByProfile = new Map<string, CampaignRow[]>()
  for (const c of allCampaigns) {
    if (!activeIds.has(c.profile_id)) continue
    if (!campsByProfile.has(c.profile_id)) campsByProfile.set(c.profile_id, [])
    campsByProfile.get(c.profile_id)!.push(c)
  }

  function applyFilter(camps: CampaignRow[]): CampaignRow[] {
    if (stateFilter === 'all') return camps
    if (stateFilter === 'enabled')
      return camps.filter(c => c.state.toUpperCase() === 'ENABLED')
    if (stateFilter === 'paused')
      return camps.filter(c => ['PAUSED', 'ARCHIVED'].includes(c.state.toUpperCase()))
    return camps
  }

  const countMap = new Map(campaignCounts.map(c => [c.profile_id, c.total]))
  const recMap   = new Map(
    draftRecs.map(r => [`${r.profile_id}:${r.resolved_campaign_id}`, parseInt(r.rec_count, 10)])
  )
  const acosMap      = new Map(acosParams.map(p => [p.scope, parseFloat(p.value)]))
  const globalTarget = acosMap.get('GLOBAL') ?? 0.30

  function resolveTarget(pid: string): number {
    return acosMap.get(pid) ?? globalTarget
  }

  const filterLabel =
    stateFilter === 'enabled' ? 'Enabled'
    : stateFilter === 'paused' ? 'Paused + Archived'
    : 'All'

  return (
    <div>
      <h1>Campaigns</h1>

      {/* ── Filter bar ── */}
      <div className="filter-bar">
        {([
          { key: 'enabled', label: 'Enabled'          },
          { key: 'paused',  label: 'Paused + Archived' },
          { key: 'all',     label: 'All'               },
        ] as const).map(({ key, label }) => (
          <a
            key={key}
            href={`?state=${key}`}
            className={`filter-link${stateFilter === key ? ' active' : ''}`}
          >
            {label}
          </a>
        ))}
      </div>

      {/* ── One section per active market ── */}
      {markets.map(m => {
        const target     = resolveTarget(m.profile_id)
        const camps      = applyFilter(campsByProfile.get(m.profile_id) ?? [])
        const totalCamps = countMap.get(m.profile_id) ?? '0'

        const mAcosNum = m.acos != null ? parseFloat(m.acos) * 100 : null
        const mAcosStr = mAcosNum != null ? mAcosNum.toFixed(1) + '%' : '—'
        const mAcosBadge = mAcosNum != null
          ? (mAcosNum <= target * 100 ? 'badge badge-ok' : 'badge badge-warn')
          : ''

        return (
          <section
            key={m.profile_id}
            id={`p-${m.profile_id}`}
            style={{ marginBottom: '3rem' }}
          >
            {/* Market header */}
            <div style={{
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: '0.75rem',
              marginBottom: '0.75rem',
            }}>
              <h2 style={{ marginBottom: 0 }}>
                {m.country_code} ({m.currency_code})
              </h2>
              <span style={{ fontSize: '0.85rem', color: 'var(--cdl-muted)' }}>
                {totalCamps} campaigns &middot; {fmt(m.spend_30d)} {m.currency_code} 30d
              </span>
              {mAcosStr !== '—' && (
                <span className={mAcosBadge}>{mAcosStr}</span>
              )}
              <span style={{ fontSize: '0.78rem', color: 'var(--cdl-muted)' }}>
                tgt {(target * 100).toFixed(0)}%
              </span>
            </div>

            {/* Campaign table */}
            {camps.length === 0 ? (
              <p style={{ color: 'var(--cdl-muted)', fontSize: '0.85rem' }}>
                No {filterLabel} campaigns.
              </p>
            ) : (
              <div className="table-card">
                <div className="table-scroll">
                  <table className="data-table" style={{ tableLayout: 'fixed' }}>
                    <colgroup>
                      <col style={{ width: '400px' }} />
                      <col style={{ width: '90px' }} />
                      <col style={{ width: '130px' }} />
                      <col style={{ width: '130px' }} />
                      <col style={{ width: '130px' }} />
                      <col style={{ width: '110px' }} />
                      <col style={{ width: '70px' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>State</th>
                        <th className="num">Spend 30d</th>
                        <th className="num">Budget</th>
                        <th className="num">Sales 30d</th>
                        <th className="num">ACOS 30d</th>
                        <th style={{ textAlign: 'center' }}>Recs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {camps.map(c => {
                        const acosStr  = computeAcos(c.spend_30d, c.sales_30d)
                        const acosNum  = acosStr != null ? parseFloat(acosStr) : null
                        const acosBadge = acosNum != null
                          ? (acosNum <= target * 100 ? 'badge badge-ok' : 'badge badge-warn')
                          : ''
                        const recCount = recMap.get(`${m.profile_id}:${c.campaign_id}`) ?? 0
                        return (
                          <tr key={c.campaign_id}>
                            <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <a
                                href={`/campaigns/${m.profile_id}/${encodeURIComponent(c.campaign_id)}`}
                                style={{ color: 'var(--cdl-blue)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={c.campaign_name}
                              >
                                {c.campaign_name}
                              </a>
                            </td>
                            <td>
                              <span className={stateBadgeCls(c.state)}>
                                {c.state}
                              </span>
                            </td>
                            <td className="num">
                              {fmt(c.spend_30d)} {m.currency_code}
                            </td>
                            <td className="num">
                              {c.budget_amount != null
                                ? `${parseFloat(c.budget_amount).toFixed(2)} ${m.currency_code}/day`
                                : '—'}
                            </td>
                            <td className="num">
                              {fmt(c.sales_30d)} {m.currency_code}
                            </td>
                            <td className="num">
                              {acosStr != null
                                ? <span className={acosBadge}>{acosStr}%</span>
                                : '—'}
                            </td>
                            <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                              {recCount > 0
                                ? <a
                                    href={`/campaigns/${m.profile_id}/${encodeURIComponent(c.campaign_id)}#recs`}
                                    style={{ textDecoration: 'none' }}
                                  >
                                    <span className="badge badge-blue">{recCount}</span>
                                  </a>
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
          </section>
        )
      })}
    </div>
  )
}
