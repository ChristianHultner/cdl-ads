export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'

interface MarketRow {
  profile_id: string
  country_code: string
  currency_code: string
  spend_7d: string
  spend_30d: string
  sales_30d: string
  last_date: string
}

interface ProfileSummary {
  profile_id: string
  country_code: string
  currency_code: string
}

interface CampaignCount {
  profile_id: string
  total_campaigns: string
  enabled_campaigns: string
}

interface RecCount {
  profile_id: string
  draft_count: string
  approved_count: string
  pushed_count: string
}

interface AcosParam {
  scope: string
  value: string
}

interface EstateTotals {
  currency_code: string
  spend_7d: string
  spend_30d: string
}

export default async function HomePage() {
  const sql = neon(process.env.DATABASE_URL!)

  const [activeMarkets, allProfiles, campaignCounts, recCounts, acosParams, estateTotals] =
    (await Promise.all([
      // Active profiles: any cost > 0 in last 30 days
      sql`
        SELECT
          ap.profile_id::text,
          ap.country_code,
          ap.currency_code,
          sum(CASE WHEN acd.date >= CURRENT_DATE - INTERVAL '7 days'
                   THEN acd.cost ELSE 0 END)::text  AS spend_7d,
          sum(acd.cost)::text                        AS spend_30d,
          sum(acd.sales_14d)::text                   AS sales_30d,
          max(acd.date)::text                        AS last_date
        FROM amazon_campaign_daily acd
        JOIN amazon_profiles ap USING (profile_id)
        WHERE acd.date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY ap.profile_id, ap.country_code, ap.currency_code
        HAVING sum(acd.cost) > 0
        ORDER BY sum(acd.cost) DESC
      `,
      // All profiles — used to identify dormant ones
      sql`
        SELECT profile_id::text, country_code, currency_code
        FROM amazon_profiles
        ORDER BY profile_id
      `,
      // Campaign counts per profile (all states)
      sql`
        SELECT
          profile_id::text,
          count(*)::text                                        AS total_campaigns,
          (count(*) FILTER (WHERE state = 'enabled'))::text    AS enabled_campaigns
        FROM amazon_campaigns
        GROUP BY profile_id
      `,
      // Recommendation counts per profile
      sql`
        SELECT
          profile_id::text,
          (count(*) FILTER (WHERE status = 'DRAFT'))::text    AS draft_count,
          (count(*) FILTER (WHERE status = 'APPROVED'))::text AS approved_count,
          (count(*) FILTER (WHERE status = 'PUSHED'))::text   AS pushed_count
        FROM recommendations
        GROUP BY profile_id
      `,
      // target_acos: GLOBAL + any profile-scope overrides
      sql`
        SELECT scope, value::text
        FROM engine_parameters
        WHERE key = 'target_acos'
      `,
      // Estate totals by currency — NEVER cross-currency
      sql`
        SELECT
          ap.currency_code,
          sum(CASE WHEN acd.date >= CURRENT_DATE - INTERVAL '7 days'
                   THEN acd.cost ELSE 0 END)::text AS spend_7d,
          sum(acd.cost)::text                       AS spend_30d
        FROM amazon_campaign_daily acd
        JOIN amazon_profiles ap USING (profile_id)
        WHERE acd.date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY ap.currency_code
        ORDER BY ap.currency_code
      `,
    ])) as unknown as [
      MarketRow[],
      ProfileSummary[],
      CampaignCount[],
      RecCount[],
      AcosParam[],
      EstateTotals[],
    ]

  const activeIds = new Set(activeMarkets.map(m => m.profile_id))
  const dormant   = allProfiles.filter(p => !activeIds.has(p.profile_id))

  const campMap = new Map(campaignCounts.map(c => [c.profile_id, c]))
  const recMap  = new Map(recCounts.map(r => [r.profile_id, r]))
  const acosMap = new Map(acosParams.map(p => [p.scope, parseFloat(p.value)]))
  const globalTarget = acosMap.get('GLOBAL') ?? 0.30

  function resolveTarget(pid: string): number {
    return acosMap.get(pid) ?? globalTarget
  }

  function fmt(v: string): string {
    return parseFloat(v).toFixed(2)
  }

  function computeAcos(spend: string, sales: string): string | null {
    const sa = parseFloat(sales)
    if (!sa) return null
    return ((parseFloat(spend) / sa) * 100).toFixed(1)
  }

  function isStale(dateStr: string): boolean {
    const d   = new Date(dateStr)
    const cut = new Date()
    cut.setDate(cut.getDate() - 3)
    return d < cut
  }

  return (
    <div>
      <h1>Estate Overview</h1>

      <div className="table-card">
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Market</th>
                <th>Spend 7d / 30d</th>
                <th>Sales 30d</th>
                <th>ACOS 30d</th>
                <th>Campaigns</th>
                <th>Recs D/A/P</th>
                <th>Last Data</th>
              </tr>
            </thead>
            <tbody>
              {activeMarkets.map(m => {
                const target    = resolveTarget(m.profile_id)
                const acosStr   = computeAcos(m.spend_30d, m.sales_30d)
                const acosNum   = acosStr != null ? parseFloat(acosStr) : null
                const acosBadge = acosNum != null
                  ? (acosNum <= target * 100 ? 'badge badge-ok' : 'badge badge-warn')
                  : ''
                const camps = campMap.get(m.profile_id)
                const recs  = recMap.get(m.profile_id)
                const stale = isStale(m.last_date)
                return (
                  <tr key={m.profile_id}>
                    <td>{m.country_code} ({m.currency_code})</td>
                    <td className="num">
                      {fmt(m.spend_7d)} / {fmt(m.spend_30d)} {m.currency_code}
                    </td>
                    <td className="num">{fmt(m.sales_30d)} {m.currency_code}</td>
                    <td className="num">
                      {acosStr != null
                        ? <span className={acosBadge}>{acosStr}%</span>
                        : '—'}
                      {acosStr != null && (
                        <span style={{ color: 'var(--cdl-muted)', fontSize: '0.78em', marginLeft: '0.5em' }}>
                          tgt {(target * 100).toFixed(0)}%
                        </span>
                      )}
                    </td>
                    <td className="num">
                      {camps
                        ? `${camps.total_campaigns} (${camps.enabled_campaigns} en)`
                        : '—'}
                    </td>
                    <td className="num">
                      {recs
                        ? `${recs.draft_count}/${recs.approved_count}/${recs.pushed_count}`
                        : '0/0/0'}
                    </td>
                    <td style={{ color: stale ? 'var(--cdl-warn)' : undefined }}>
                      {m.last_date}
                    </td>
                  </tr>
                )
              })}
              {dormant.length > 0 && (
                <tr>
                  <td colSpan={7} style={{ color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
                    Dormant (no spend last 30d):{' '}
                    {dormant.map(d => `${d.country_code} (${d.currency_code})`).join(', ')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ fontSize: '0.85rem', color: 'var(--cdl-muted)' }}>
        <strong style={{ color: 'var(--cdl-ink)' }}>Estate totals (30d window):</strong>{' '}
        {estateTotals.length === 0
          ? 'No data.'
          : estateTotals.map((e, i) => (
              <span key={e.currency_code}>
                {i > 0 && ' · '}
                {e.currency_code}&nbsp;{fmt(e.spend_7d)}&nbsp;/&nbsp;{fmt(e.spend_30d)}&nbsp;(7d/30d spend)
              </span>
            ))}
      </div>
    </div>
  )
}
