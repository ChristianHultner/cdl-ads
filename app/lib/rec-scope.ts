/**
 * Rec campaign / ad-group scoping helpers.
 *
 * Campaign attribution — priority order:
 *   1. recommendations.campaign_id::text         (direct column)
 *   2. evidence->>'campaign_id'                  (JSON, ::text)
 *   3. evidence->'resolved_destination'->>'campaign_id'
 *   4. evidence->>'destination_ad_group_id'      resolved through amazon_ad_groups→campaign
 *
 * Ad-group attribution — priority order:
 *   1. evidence->>'ad_group_id'
 *   2. evidence->'resolved_destination'->>'ad_group_id'
 *   3. evidence->>'destination_ad_group_id'
 *
 * ::text discipline: all JSON extraction paths yield text; no implicit casts.
 */

import type { Evidence } from '@/app/components/RecCard'

/**
 * Returns the attributed ad_group_id from a rec's evidence, or null if
 * the rec has no ad-group attribution (i.e. it is campaign-level).
 */
export function evidenceAdGroupId(ev: Evidence): string | null {
  return (
    ev.ad_group_id ??
    ev.resolved_destination?.ad_group_id ??
    ev.destination_ad_group_id ??
    null
  )
}

/** Rec types that are always campaign-level regardless of evidence content. */
export const CAMPAIGN_LEVEL_TYPES = new Set(['BUDGET_ADJUST', 'PAUSE_CAMPAIGN'])

/**
 * Returns true if this rec should be rendered in the campaign-level section
 * rather than attributed to a specific ad group.
 */
export function isCampaignLevel(recType: string, ev: Evidence): boolean {
  return CAMPAIGN_LEVEL_TYPES.has(recType) || evidenceAdGroupId(ev) === null
}

/**
 * Returns the attributed campaign_id for a rec (TypeScript-side legs 1–3 only).
 * Leg 4 (destination_ad_group_id → amazon_ad_groups) requires a DB join and is
 * NOT available client-side — a null return here does not mean unattributed when
 * evidence.destination_ad_group_id is set.
 *
 * Priority mirrors the SQL COALESCE in the consuming queries:
 *   1. recommendations.campaign_id column   (pass as recCampaignId)
 *   2. evidence->>'campaign_id'
 *   3. evidence->'resolved_destination'->>'campaign_id'
 */
export function evidenceCampaignId(
  recCampaignId: string | null | undefined,
  ev: Evidence,
): string | null {
  return (
    recCampaignId ??
    ev.campaign_id ??
    ev.resolved_destination?.campaign_id ??
    null
  )
}
