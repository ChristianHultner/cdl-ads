export const dynamic = 'force-dynamic'

import { CAMPAIGN_METRICS_CTE, CAMPAIGN_LABEL_SQL } from '@/lib/amazon/campaign-display'
import { neon } from '@neondatabase/serverless'
import { CampaignsClient } from './CampaignsClient'
import type { MarketRow, CampaignRow } from './CampaignsClient'

interface CampaignCount {
  profile_id: string
  total: string
}

interface RecCount {
  profile_id: string
  resolved_campaign_id: string
  rec_count: string
}

export default async function CampaignsPage() {
  const sql = neon(process.env.DATABASE_URL!)

  const [markets, allCampaigns, campaignCounts, draftRecs] =
    (await Promise.all([
      // All profiles — LEFT JOIN so zero-spend markets still appear (spend shows 0.00)
      sql.query(CAMPAIGN_METRICS_CTE + `
        SELECT ap.profile_id::text,ap.country_code,ap.currency_code,ap.target_acos::text,
          coalesce(sum(m.spend),0)::text AS spend_30d,coalesce(sum(m.sales),0)::text AS sales_30d,
          (sum(m.spend)/nullif(sum(m.sales),0))::text AS acos
        FROM amazon_profiles ap LEFT JOIN campaign_metrics m ON m.profile_id=ap.profile_id
        GROUP BY ap.profile_id,ap.country_code,ap.currency_code,ap.target_acos
        ORDER BY coalesce(sum(m.spend),0) DESC
      `),
      sql.query(CAMPAIGN_METRICS_CTE + `
        SELECT c.profile_id::text,c.campaign_id,c.name AS campaign_name,c.state,c.campaign_type,
          ${CAMPAIGN_LABEL_SQL} AS type_label,
          coalesce(d.spend,0)::text AS spend_30d,coalesce(d.sales,0)::text AS sales_30d,
          coalesce(d.orders,0)::text AS orders_30d,(d.spend/nullif(d.orders,0))::text AS cost_per_order,
          (d.spend/nullif(d.sales,0))::text AS acos,c.budget_amount::text,c.budget_type
        FROM amazon_campaigns c LEFT JOIN campaign_metrics d
          ON d.profile_id=c.profile_id AND d.campaign_id=c.campaign_id AND d.campaign_type=c.campaign_type
        WHERE c.state IN ('ENABLED','PAUSED','ARCHIVED')
        ORDER BY c.profile_id,d.spend DESC NULLS LAST,c.name
      `),
      // Total campaign count per profile (all states)
      sql`
        SELECT profile_id::text, count(*)::text AS total
        FROM amazon_campaigns
        GROUP BY profile_id
      `,
      // DRAFT rec counts — full campaign scoping
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
    ])) as unknown as [MarketRow[], CampaignRow[], CampaignCount[], RecCount[]]

  // ── Build plain-object maps for client component ──────────────────────────
  // Maps are not serialisable across the server→client boundary; use Records.
  const campsByProfile: Record<string, CampaignRow[]> = {}
  for (const c of allCampaigns) {
    if (!campsByProfile[c.profile_id]) campsByProfile[c.profile_id] = []
    campsByProfile[c.profile_id].push(c)
  }

  const countMap: Record<string, string> = Object.fromEntries(
    campaignCounts.map(c => [c.profile_id, c.total]),
  )

  const recMap: Record<string, number> = Object.fromEntries(
    draftRecs.map(r => [
      `${r.profile_id}:${r.resolved_campaign_id}`,
      parseInt(r.rec_count, 10),
    ]),
  )

  return (
    <CampaignsClient
      markets={markets}
      campsByProfile={campsByProfile}
      countMap={countMap}
      recMap={recMap}
    />
  )
}
