export const dynamic = 'force-dynamic'

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
      sql`
        SELECT
          ap.profile_id::text,
          ap.country_code,
          ap.currency_code,
          ap.target_acos::text,
          coalesce(sum(acd.cost),      0)::text                                AS spend_30d,
          coalesce(sum(acd.sales_14d), 0)::text                                AS sales_30d,
          (sum(acd.cost) / nullif(sum(acd.sales_14d), 0))::text                AS acos
        FROM amazon_profiles ap
        LEFT JOIN amazon_campaign_daily acd
          ON  acd.profile_id = ap.profile_id
          AND acd.date >= CURRENT_DATE - INTERVAL '30 days'
        GROUP BY ap.profile_id, ap.country_code, ap.currency_code, ap.target_acos
        ORDER BY coalesce(sum(acd.cost), 0) DESC
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
