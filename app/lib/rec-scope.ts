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
