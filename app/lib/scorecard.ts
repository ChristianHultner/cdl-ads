// app/lib/scorecard.ts
// Layer 3.1: GP-derived judgment, ACoS band 25-35, REVIEW state.
// Server-side scorecard logic — ported from scripts/scorecard.mjs; no deviations.

// ── Types ─────────────────────────────────────────────────────────────────────

export type Verdict = 'WIN' | 'PARTIAL' | 'LEAK' | 'NO-DATA' | 'REVIEW'

export interface VerdictCounts {
  WIN:       number
  PARTIAL:   number
  LEAK:      number
  'NO-DATA': number
  REVIEW:    number
}

export interface RawScorecardRow {
  id:            string | number
  rec_type:      string
  target_text:   string
  campaign_id:   string | null
  evidence:      unknown
  country_code:  string
  currency_code: string
  horizon:       string
  metrics:       unknown
  captured_at:   string
  pushed_at?:    string | null
}

export interface Judgment {
  verdict:           Verdict
  direction?:        string
  euros_stopped?:    number | null
  pct_of_ref?:       number
  pct_reduced?:      number
  acos_delta?:       number | null
  gp_delta?:         number | null
  pre_gp_grading?:   boolean
  b0_spend?:         number | null
  hc_orders?:        number | null
  before_cost?:      number | null
  after_cost?:       number | null
  spend_change_pct?: number | null
  sales_change_pct?: number | null
  clicks?:           number
  purchases?:        number
  note?:             string
}

export interface JudgedRow extends RawScorecardRow {
  judgment: Judgment
}

export interface MarketCounts {
  market: string
  n:      number
  dn:     number
  counts: VerdictCounts
}

export interface BidDirectionGroup {
  direction:       'CUT' | 'RAISE'
  n:               number
  dn:              number
  counts:          VerdictCounts
  medianAcosDelta: number | null
  byMarket:        MarketCounts[]
}

export interface PerRecEntry {
  id:         string | number
  market:     string
  direction?: string
  verdict:    Verdict
  note?:      string
}

export interface HorizonGroup {
  horizon:             string
  n:                   number
  dn:                  number
  counts:              VerdictCounts
  medianEurosStopped?: number | null
  byMarket:            MarketCounts[]
  bidSplit?:           BidDirectionGroup[]
  perRec?:             PerRecEntry[]
}

export interface TypeSection {
  recType:       string
  isSmallCohort: boolean
  horizons:      HorizonGroup[]
}

export interface HeroStats {
  replaceWinPct:            number | null
  promoteTermServingPct:    number | null
  negateMedianEurosStopped: number | null
  raiseWinPct:              number | null
  cutWinPct:                number | null
  totalStamps:              number
  totalGraded:              number
  reviewCount:              number
}

export interface ScorecardResult {
  hero:     HeroStats
  sections: TypeSection[]
  judged:   JudgedRow[]
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeN(x: unknown): number {
  return x == null ? NaN : Number(x)
}

function median(arr: number[]): number | null {
  if (arr.length === 0) return null
  const s = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

function zeroVerdicts(): VerdictCounts {
  return { WIN: 0, PARTIAL: 0, LEAK: 0, 'NO-DATA': 0, REVIEW: 0 }
}

function aggCounts(rows: JudgedRow[]): { n: number; dn: number; counts: VerdictCounts } {
  const counts = zeroVerdicts()
  for (const r of rows) counts[r.judgment.verdict]++
  const n  = rows.length
  const dn = n - counts['NO-DATA']   // REVIEW counts in dn (graded data)
  return { n, dn, counts }
}

// ── Judgment functions ────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeNegateTerm(ev: any, m: any): Judgment {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' }

  const cost     = safeN(m.cost)
  const refSpend = safeN(ev.spend)

  // L3.1 GP grading requires before-window (before_rows_found present)
  const hasBefore = m.before_rows_found != null

  if (!hasBefore) {
    // Legacy stamp: grade on old definition, tag pre_gp_grading
    const stopped = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null
    if (!isNaN(refSpend) && refSpend > 0) {
      const ratio = cost / refSpend
      if (ratio <= 0.05) return { verdict: 'WIN',     euros_stopped: stopped, pct_of_ref: ratio, pre_gp_grading: true }
      if (ratio <= 0.50) return { verdict: 'PARTIAL', euros_stopped: stopped, pct_of_ref: ratio, pct_reduced: 1 - ratio, pre_gp_grading: true }
      return               { verdict: 'LEAK',          euros_stopped: stopped, pct_of_ref: ratio, pre_gp_grading: true }
    }
    if (cost < 0.10) return { verdict: 'WIN',    euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', pre_gp_grading: true }
    return                  { verdict: 'PARTIAL', euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', pre_gp_grading: true }
  }

  // GP grading (L3.1): gp_delta = (sales_after − spend_after) − (sales_before − spend_before)
  const salesAfter  = safeN(m.sales_14d  ?? 0)
  const beforeCost  = safeN(m.before_cost ?? 0)
  const beforeSales = safeN(m.before_sales_14d ?? 0)
  const gp_delta    = (salesAfter - cost) - (beforeSales - beforeCost)
  const stopped     = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null

  // Spend-stopped test (existing bar: ≤5% of ref spend)
  const spendStopped = !isNaN(refSpend) && refSpend > 0
    ? (cost / refSpend) <= 0.05
    : cost < 0.10

  if (spendStopped) {
    if (gp_delta >= 0)
      return { verdict: 'WIN',    euros_stopped: stopped, gp_delta,
               pct_of_ref: !isNaN(refSpend) && refSpend > 0 ? cost / refSpend : undefined }
    return   { verdict: 'REVIEW', euros_stopped: stopped, gp_delta,
               note: 'spend stopped but GP Δ<0: negation may have killed converting traffic' }
  }

  // Spend not fully stopped → PARTIAL / LEAK (unchanged logic)
  if (!isNaN(refSpend) && refSpend > 0) {
    const ratio = cost / refSpend
    if (ratio <= 0.50) return { verdict: 'PARTIAL', euros_stopped: stopped, pct_of_ref: ratio, pct_reduced: 1 - ratio, gp_delta }
    return               { verdict: 'LEAK',          euros_stopped: stopped, pct_of_ref: ratio, gp_delta }
  }
  return { verdict: 'PARTIAL', euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', gp_delta }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeNegateTarget(ev: any, m: any): Judgment {
  // Same logic as NEGATE_TERM (search_term ASIN as target)
  if (m.rows_found === 0) return { verdict: 'NO-DATA' }

  const cost     = safeN(m.cost)
  const refSpend = safeN(ev.spend)
  const hasBefore = m.before_rows_found != null

  if (!hasBefore) {
    const stopped = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null
    if (!isNaN(refSpend) && refSpend > 0) {
      const ratio = cost / refSpend
      if (ratio <= 0.05) return { verdict: 'WIN',     euros_stopped: stopped, pct_of_ref: ratio, pre_gp_grading: true }
      if (ratio <= 0.50) return { verdict: 'PARTIAL', euros_stopped: stopped, pct_of_ref: ratio, pct_reduced: 1 - ratio, pre_gp_grading: true }
      return               { verdict: 'LEAK',          euros_stopped: stopped, pct_of_ref: ratio, pre_gp_grading: true }
    }
    if (cost < 0.10) return { verdict: 'WIN',    euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', pre_gp_grading: true }
    return                  { verdict: 'PARTIAL', euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', pre_gp_grading: true }
  }

  const salesAfter  = safeN(m.sales_14d  ?? 0)
  const beforeCost  = safeN(m.before_cost ?? 0)
  const beforeSales = safeN(m.before_sales_14d ?? 0)
  const gp_delta    = (salesAfter - cost) - (beforeSales - beforeCost)
  const stopped     = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null

  const spendStopped = !isNaN(refSpend) && refSpend > 0
    ? (cost / refSpend) <= 0.05
    : cost < 0.10

  if (spendStopped) {
    if (gp_delta >= 0)
      return { verdict: 'WIN',    euros_stopped: stopped, gp_delta,
               pct_of_ref: !isNaN(refSpend) && refSpend > 0 ? cost / refSpend : undefined }
    return   { verdict: 'REVIEW', euros_stopped: stopped, gp_delta,
               note: 'spend stopped but GP Δ<0: negation may have killed converting traffic' }
  }

  if (!isNaN(refSpend) && refSpend > 0) {
    const ratio = cost / refSpend
    if (ratio <= 0.50) return { verdict: 'PARTIAL', euros_stopped: stopped, pct_of_ref: ratio, pct_reduced: 1 - ratio, gp_delta }
    return               { verdict: 'LEAK',          euros_stopped: stopped, pct_of_ref: ratio, gp_delta }
  }
  return { verdict: 'PARTIAL', euros_stopped: stopped, note: 'refSpend unknown; absolute fallback', gp_delta }
}

function judgeBidAdjust(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ev: any, m: any,
  countryCode: string,
  marketRollingAcos: Record<string, number>,
): Judgment {
  const pushed  = safeN(ev.pushed_bid ?? ev.proposed_bid)
  let   current = safeN(ev.current_bid)
  if (isNaN(current) && Array.isArray(ev.existing_targets) && ev.existing_targets.length > 0)
    current = safeN(ev.existing_targets[0].bid)
  // REVIVE: current_bid not top-level; resolve from evidence.current_max (#8 fix — 2026-08-12).
  if (isNaN(current) && ev.kind === 'REVIVE' && ev.current_max != null)
    current = safeN(ev.current_max)

  const targetAcos = safeN(ev.params_used?.target_acos ?? 0.30)
  const bandHigh   = targetAcos + 0.05

  let direction: string
  if (!isNaN(current) && !isNaN(pushed)) {
    direction = pushed < current * 0.99 ? 'CUT'
              : pushed > current * 1.01 ? 'RAISE'
              : 'FLAT'
  } else {
    direction = 'UNKNOWN'
  }

  if (m.rows_found === 0) return { verdict: 'NO-DATA', direction }

  const afterCost   = safeN(m.cost)
  const afterSales  = safeN(m.sales_14d)
  const afterClicks = safeN(m.clicks)
  const beforeCost  = safeN(m.before_cost)
  const beforeSales = safeN(m.before_sales_14d)
  const beforeClks  = safeN(m.before_clicks)

  const afterAcos  = afterSales  > 0 ? afterCost  / afterSales  : null
  const beforeAcos = beforeSales > 0 ? beforeCost / beforeSales : null
  const acosDelta  = (afterAcos !== null && beforeAcos !== null) ? afterAcos - beforeAcos : null

  // GP delta — BID_ADJUST always has before/after (from Layer 2 onward)
  const gp_delta = (!isNaN(afterCost) && !isNaN(beforeCost))
    ? (afterSales - afterCost) - (beforeSales - beforeCost)
    : null

  if (direction === 'CUT') {
    // WIN = gp_delta > 0 (saved spend exceeded any lost sales)
    if (gp_delta !== null && gp_delta > 0)
      return { verdict: 'WIN',     direction, acos_delta: acosDelta, gp_delta }
    // ACoS improvement alone without GP gain = PARTIAL
    const acosBetter = afterAcos !== null && beforeAcos !== null && afterAcos < beforeAcos
    if (acosBetter)
      return { verdict: 'PARTIAL', direction, acos_delta: acosDelta, gp_delta,
               note: 'ACoS improved but GP Δ≤0' }
    const spendFell = afterCost < beforeCost * 0.90
    if (spendFell)
      return { verdict: 'PARTIAL', direction, acos_delta: acosDelta, gp_delta,
               note: 'spend fell but GP Δ≤0 (sales fell more)' }
    return { verdict: 'LEAK', direction, acos_delta: acosDelta, gp_delta }
  }

  if (direction === 'RAISE') {
    if (gp_delta !== null && gp_delta > 0) {
      // Check market band: rolling ACoS vs target_acos + 5pp ceiling
      const marketAcos    = marketRollingAcos[countryCode]
      const marketAbove   = marketAcos != null && marketAcos > bandHigh

      if (!marketAbove) {
        // Market in/below band: WIN
        const note = marketAcos != null
          ? `market ${(marketAcos * 100).toFixed(1)}% in/below band`
          : undefined
        return { verdict: 'WIN', direction, acos_delta: acosDelta, gp_delta, note }
      }
      // Above-band market: entity's own ACoS must also be ≤ band ceiling
      if (afterAcos == null || afterAcos <= bandHigh) {
        return { verdict: 'WIN',     direction, acos_delta: acosDelta, gp_delta,
                 note: `market ${(marketAcos! * 100).toFixed(1)}% above band; entity ACoS within ceiling` }
      }
      return   { verdict: 'PARTIAL', direction, acos_delta: acosDelta, gp_delta,
                 note: `GP Δ>0 but market ${(marketAcos! * 100).toFixed(1)}% above band; entity ACoS ${(afterAcos * 100).toFixed(1)}%>ceiling` }
    }
    // gp_delta ≤ 0
    const clicksRose = afterClicks > beforeClks
    if (clicksRose)
      return { verdict: 'PARTIAL', direction, acos_delta: acosDelta, gp_delta,
               note: 'clicks rose but GP Δ≤0' }
    return { verdict: 'LEAK', direction, acos_delta: acosDelta, gp_delta,
             note: 'clicks did not rise and GP Δ≤0' }
  }

  return {
    verdict: 'NO-DATA', direction,
    note: direction === 'FLAT'
      ? 'pushed_bid ≈ current_bid; no directional change'
      : 'current_bid unavailable in evidence',
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeReplaceProductAd(ev: any, m: any): Judgment {
  if (m.rows_found === 0) return {
    verdict: 'NO-DATA',
    note: 'no daily rows for B0 or HC in window',
  }
  const b0Impr   = safeN(m.b0_impressions ?? 0)
  const hcImpr   = safeN(m.hc_impressions ?? 0)
  const hcClicks = safeN(m.hc_clicks      ?? 0)
  const b0Spend  = safeN(m.b0_spend)
  const hcOrders = safeN(m.hc_orders      ?? 0)
  const b0Dark   = b0Impr === 0
  const hcServe  = hcImpr > 0 || hcClicks > 0

  // GP delta informational — pair-level (L3.1 stamps only)
  let gp_delta: number | null = null
  if (m.before_b0_spend != null && m.before_hc_spend != null) {
    const afterGP  = safeN(m.hc_sales  ?? 0) + safeN(m.b0_sales  ?? 0)
                   - safeN(m.hc_spend  ?? 0) - safeN(m.b0_spend  ?? 0)
    const beforeGP = safeN(m.before_hc_sales ?? 0) + safeN(m.before_b0_sales ?? 0)
                   - safeN(m.before_hc_spend ?? 0) - safeN(m.before_b0_spend ?? 0)
    gp_delta = afterGP - beforeGP
  }

  if (b0Dark && hcServe)
    return { verdict: 'WIN',     note: 'B0 dark, HC serving', b0_spend: b0Spend, hc_orders: hcOrders, gp_delta }
  if (b0Dark)
    return { verdict: 'PARTIAL', note: 'B0 dark but HC not yet serving', b0_spend: b0Spend, gp_delta }
  if (hcServe)
    return { verdict: 'PARTIAL', note: 'HC serving but B0 still active', b0_spend: b0Spend, gp_delta }
  return   { verdict: 'LEAK',    note: 'B0 still active, HC not serving', b0_spend: b0Spend, gp_delta }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgePromoteTerm(ev: any, m: any, horizon: string): Judgment {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' }
  const clicks    = safeN(m.clicks)
  const purchases = safeN(m.purchases_14d ?? 0)
  if (isNaN(clicks)) return { verdict: 'NO-DATA', note: 'no clicks field in metrics' }

  // GP delta informational (L3.1 stamps only)
  let gp_delta: number | null = null
  if (m.before_rows_found != null) {
    const afterSales  = safeN(m.sales_14d  ?? 0)
    const afterCost   = safeN(m.cost       ?? 0)
    const beforeSales = safeN(m.before_sales_14d ?? 0)
    const beforeCost  = safeN(m.before_cost ?? 0)
    gp_delta = (afterSales - afterCost) - (beforeSales - beforeCost)
  }

  // WIN: serving (unchanged); STRONG = gp_delta > 0
  if (clicks > 0) {
    if (gp_delta != null && gp_delta > 0)
      return { verdict: 'WIN', note: 'STRONG: gp_delta>0',
               clicks, purchases: purchases > 0 ? purchases : undefined, gp_delta }
    if (horizon === 't14' && purchases > 0)
      return { verdict: 'WIN', note: 'STRONG: orders>0 at t14', clicks, purchases, gp_delta }
    return { verdict: 'WIN', note: 'serving at ' + horizon + ' (clicks>0; impression proxy)', clicks, gp_delta }
  }
  return { verdict: 'LEAK', note: 'rows found but zero clicks — keyword dark', clicks: 0, gp_delta }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeCreativeKeyword(ev: any, m: any, horizon: string): Judgment {
  return judgePromoteTerm(ev, m, horizon)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgePromoteAsin(ev: any, m: any, horizon: string): Judgment {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' }
  const clicks    = safeN(m.clicks)
  const purchases = safeN(m.purchases ?? m.purchases_14d ?? 0)

  let gp_delta: number | null = null
  if (m.before_rows_found != null) {
    const afterSales  = safeN(m.sales  ?? m.sales_14d  ?? 0)
    const afterCost   = safeN(m.cost   ?? 0)
    const beforeSales = safeN(m.before_sales ?? m.before_sales_14d ?? 0)
    const beforeCost  = safeN(m.before_cost ?? 0)
    gp_delta = (afterSales - afterCost) - (beforeSales - beforeCost)
  }

  if (clicks > 0) {
    if (gp_delta != null && gp_delta > 0)
      return { verdict: 'WIN', note: 'STRONG: gp_delta>0', clicks,
               purchases: purchases > 0 ? purchases : undefined, gp_delta }
    if (horizon === 't14' && purchases > 0)
      return { verdict: 'WIN', note: 'STRONG: orders>0 at t14', clicks, purchases, gp_delta }
    return { verdict: 'WIN', note: 'serving (clicks>0)', clicks, gp_delta }
  }
  return { verdict: 'LEAK', note: 'target dark (rows found, zero clicks)', clicks: 0, gp_delta }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeCreativeTarget(ev: any, m: any, horizon: string): Judgment {
  return judgePromoteAsin(ev, m, horizon)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgePauseCampaign(ev: any, m: any): Judgment {
  if (m.rows_found === 0 && (!m.before_rows_found || m.before_rows_found === 0))
    return { verdict: 'NO-DATA' }
  const afterCost  = safeN(m.cost)
  const beforeCost = safeN(m.before_cost)
  if (afterCost < 0.10) return { verdict: 'WIN',     before_cost: beforeCost, after_cost: afterCost }
  if (!isNaN(beforeCost) && beforeCost > 0 && afterCost < beforeCost * 0.50)
    return { verdict: 'PARTIAL', before_cost: beforeCost, after_cost: afterCost }
  return { verdict: 'LEAK', before_cost: beforeCost, after_cost: afterCost }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeBudgetAdjust(ev: any, m: any): Judgment {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' }
  const spendChg = (safeN(m.before_cost) > 0)
    ? (safeN(m.cost) - safeN(m.before_cost)) / safeN(m.before_cost)
    : null
  const salesChg = (safeN(m.before_sales_14d) > 0)
    ? (safeN(m.sales_14d) - safeN(m.before_sales_14d)) / safeN(m.before_sales_14d)
    : null
  // GP delta (L3.1-parity; campaign_daily before/after always present for BUDGET_ADJUST).
  const gp_delta = (!isNaN(safeN(m.cost)) && !isNaN(safeN(m.before_cost)))
    ? (safeN(m.sales_14d) - safeN(m.cost)) - (safeN(m.before_sales_14d) - safeN(m.before_cost))
    : null
  // WIN  = spend rose (raise took) AND gp_delta ≥ 0.
  // LEAK = spend rose but GP fell (volume gained at a loss).
  // PARTIAL = spend flat/fell (raise did not take; no directional signal).
  // BUDGET_ADJUST is raise-only by generation — no direction inversion needed (#3 fix — 2026-08-12).
  let verdict: Verdict
  if (spendChg === null) {
    verdict = 'PARTIAL' // no baseline — cannot judge
  } else if (spendChg > 0) {
    verdict = (gp_delta !== null && gp_delta >= 0) ? 'WIN' : 'LEAK'
  } else {
    verdict = 'PARTIAL' // raise did not take
  }
  return {
    verdict,
    note: `spend_chg=${spendChg !== null ? (spendChg * 100).toFixed(0) + '%' : '?'} sales_chg=${salesChg !== null ? (salesChg * 100).toFixed(0) + '%' : '?'}`,
    spend_change_pct: spendChg,
    sales_change_pct: salesChg,
    gp_delta,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeCreateStructure(ev: any, m: any): Judgment {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' }
  const impr = safeN(m.impressions)
  if (impr > 0) return { verdict: 'WIN',     note: `campaign serving (impr=${impr})` }
  return       { verdict: 'PARTIAL', note: 'campaign exists but impressions=0' }
}

function judgeRow(
  row: RawScorecardRow,
  marketRollingAcos: Record<string, number> = {},
): Judgment {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : (row.evidence as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m  = typeof row.metrics  === 'string' ? JSON.parse(row.metrics)  : (row.metrics  as any)
  switch (row.rec_type) {
    case 'NEGATE_TERM':        return judgeNegateTerm(ev, m)
    case 'NEGATE_TARGET':      return judgeNegateTarget(ev, m)
    case 'BID_ADJUST':         return judgeBidAdjust(ev, m, row.country_code, marketRollingAcos)
    case 'REPLACE_PRODUCT_AD': return judgeReplaceProductAd(ev, m)
    case 'PROMOTE_TERM':       return judgePromoteTerm(ev, m, row.horizon)
    case 'CREATIVE_KEYWORD':   return judgeCreativeKeyword(ev, m, row.horizon)
    case 'PROMOTE_ASIN':       return judgePromoteAsin(ev, m, row.horizon)
    case 'CREATIVE_TARGET':    return judgeCreativeTarget(ev, m, row.horizon)
    case 'PAUSE_CAMPAIGN':     return judgePauseCampaign(ev, m)
    case 'BUDGET_ADJUST':      return judgeBudgetAdjust(ev, m)
    case 'CREATE_STRUCTURE':   return judgeCreateStructure(ev, m)
    default:                   return { verdict: 'NO-DATA', note: `unhandled type: ${row.rec_type}` }
  }
}

// ── Type order ────────────────────────────────────────────────────────────────
const TYPE_ORDER = [
  'REPLACE_PRODUCT_AD',
  'PROMOTE_TERM',
  'NEGATE_TERM',
  'NEGATE_TARGET',
  'BID_ADJUST',
  'CREATIVE_KEYWORD',
  'PROMOTE_ASIN',
  'CREATIVE_TARGET',
  'PAUSE_CAMPAIGN',
  'BUDGET_ADJUST',
  'CREATE_STRUCTURE',
]

const SMALL_TYPES = new Set([
  'PAUSE_CAMPAIGN', 'BUDGET_ADJUST', 'PROMOTE_ASIN',
  'CREATIVE_TARGET', 'CREATE_STRUCTURE', 'CREATIVE_KEYWORD',
])

// ── Adaptation notes ──────────────────────────────────────────────────────────
export const ADAPTATIONS: Record<string, string> = {
  NEGATE_TARGET:
    'NEGATE_TARGET: handler added 2026-08-11; metrics: clicks+cost+sales_14d from amazon_search_term_daily WHERE search_term = target ASIN. L3.1: before-window added. WIN requires spend stopped (≤5% ev.spend) AND gp_delta≥0; spend stopped + gp_delta<0 → REVIEW.',
  REPLACE_PRODUCT_AD:
    'REPLACE_PRODUCT_AD: handler added 2026-08-11; B0+HC ad-pair rows from amazon_advertised_product_daily scoped by campaign_id. L3.1: b0_sales, hc_sales + before-window added; gp_delta informational. Execution bar unchanged.',
  PROMOTE_TERM:
    'PROMOTE_TERM / CREATIVE_KEYWORD: stamp metrics lack impressions. Using clicks>0 as serving proxy. L3.1: before-window added; gp_delta informational; STRONG = gp_delta>0.',
  CREATIVE_KEYWORD:
    'PROMOTE_TERM / CREATIVE_KEYWORD: stamp metrics lack impressions. Using clicks>0 as serving proxy. L3.1: before-window added.',
  BID_ADJUST:
    'BID_ADJUST direction: resolved from evidence.current_bid vs pushed_bid (fallback: existing_targets[0].bid). L3.1: CUT WIN = gp_delta>0; ACoS improvement alone = PARTIAL. RAISE WIN = gp_delta>0 + market ACoS in/below band (target±5pp); above-band market also requires entity ACoS≤ceiling.',
  NEGATE_TERM:
    'NEGATE_TERM: L3.1 GP grading: WIN = spend stopped (≤5% ev.spend) AND gp_delta≥0. Spend stopped + gp_delta<0 → REVIEW. Legacy stamps (no before-window) graded on old definition, tagged pre_gp_grading.',
}

// ── Main export ───────────────────────────────────────────────────────────────
export function computeScorecard(
  rawRows: RawScorecardRow[],
  marketRollingAcos: Record<string, number> = {},
): ScorecardResult {
  const judged: JudgedRow[] = rawRows.map(r => ({ ...r, judgment: judgeRow(r, marketRollingAcos) }))

  const sections: TypeSection[] = []

  for (const recType of TYPE_ORDER) {
    const typeRows = judged.filter(r => r.rec_type === recType)
    if (typeRows.length === 0) continue

    const horizons = [...new Set(typeRows.map(r => r.horizon))].sort()
    const markets  = [...new Set(typeRows.map(r => r.country_code))].sort()
    const isSmall  = SMALL_TYPES.has(recType)

    const horizonGroups: HorizonGroup[] = []

    for (const h of horizons) {
      const hRows = typeRows.filter(r => r.horizon === h)
      const { n, dn, counts } = aggCounts(hRows)

      if (n < 5 || isSmall) {
        horizonGroups.push({
          horizon: h, n, dn, counts, byMarket: [],
          perRec: hRows.map(r => ({
            id:        r.id,
            market:    r.country_code,
            direction: r.judgment.direction,
            verdict:   r.judgment.verdict,
            note:      r.judgment.note,
          })),
        })
        continue
      }

      if (recType === 'BID_ADJUST') {
        const cuts   = hRows.filter(r => r.judgment.direction === 'CUT')
        const raises = hRows.filter(r => r.judgment.direction === 'RAISE')

        const makeSplit = (dir: 'CUT' | 'RAISE', subset: JudgedRow[]): BidDirectionGroup => {
          const { n: sn, dn: sdn, counts: sc } = aggCounts(subset)
          const deltas = subset
            .filter(r => r.judgment.acos_delta != null)
            .map(r => r.judgment.acos_delta as number)
          const byMarket: MarketCounts[] = markets
            .map(mkt => {
              const mr = subset.filter(r => r.country_code === mkt)
              if (mr.length === 0) return null
              const { n: mn, dn: mdn, counts: mc } = aggCounts(mr)
              return { market: mkt, n: mn, dn: mdn, counts: mc }
            })
            .filter((x): x is MarketCounts => x !== null)
          return { direction: dir, n: sn, dn: sdn, counts: sc, medianAcosDelta: median(deltas), byMarket }
        }

        horizonGroups.push({
          horizon: h, n, dn, counts, byMarket: [],
          bidSplit: [makeSplit('CUT', cuts), makeSplit('RAISE', raises)],
        })
        continue
      }

      let medianEurosStopped: number | null = null
      if (recType === 'NEGATE_TERM' || recType === 'NEGATE_TARGET') {
        const stops = hRows
          .filter(r => r.judgment.euros_stopped != null && !isNaN(r.judgment.euros_stopped as number))
          .map(r => r.judgment.euros_stopped as number)
        medianEurosStopped = median(stops)
      }

      const byMarket: MarketCounts[] = markets
        .map(mkt => {
          const mr = hRows.filter(r => r.country_code === mkt)
          if (mr.length === 0) return null
          const { n: mn, dn: mdn, counts: mc } = aggCounts(mr)
          return { market: mkt, n: mn, dn: mdn, counts: mc }
        })
        .filter((x): x is MarketCounts => x !== null)

      horizonGroups.push({ horizon: h, n, dn, counts, medianEurosStopped, byMarket })
    }

    sections.push({ recType, isSmallCohort: isSmall, horizons: horizonGroups })
  }

  // ── Hero stats ─────────────────────────────────────────────────────────────
  const replaceRows    = judged.filter(r => r.rec_type === 'REPLACE_PRODUCT_AD')
  const replaceGraded  = replaceRows.filter(r => r.judgment.verdict !== 'NO-DATA')
  const replaceWinPct  = replaceGraded.length > 0
    ? replaceRows.filter(r => r.judgment.verdict === 'WIN').length / replaceGraded.length * 100
    : null

  const promoteRows           = judged.filter(r => r.rec_type === 'PROMOTE_TERM')
  const promoteGraded         = promoteRows.filter(r => r.judgment.verdict !== 'NO-DATA')
  const promoteTermServingPct = promoteGraded.length > 0
    ? promoteRows.filter(r => r.judgment.verdict === 'WIN').length / promoteGraded.length * 100
    : null

  const negateRows = judged.filter(r =>
    r.rec_type === 'NEGATE_TERM' || r.rec_type === 'NEGATE_TARGET')
  const negateStops = negateRows
    .filter(r => r.judgment.euros_stopped != null && !isNaN(r.judgment.euros_stopped as number))
    .map(r => r.judgment.euros_stopped as number)
  const negateMedianEurosStopped = median(negateStops)

  const bidRows      = judged.filter(r => r.rec_type === 'BID_ADJUST')
  const raises       = bidRows.filter(r => r.judgment.direction === 'RAISE')
  const cuts         = bidRows.filter(r => r.judgment.direction === 'CUT')
  const raisesGraded = raises.filter(r => r.judgment.verdict !== 'NO-DATA')
  const cutsGraded   = cuts.filter(r => r.judgment.verdict !== 'NO-DATA')
  const raiseWinPct  = raisesGraded.length > 0
    ? raises.filter(r => r.judgment.verdict === 'WIN').length / raisesGraded.length * 100
    : null
  const cutWinPct    = cutsGraded.length > 0
    ? cuts.filter(r => r.judgment.verdict === 'WIN').length / cutsGraded.length * 100
    : null

  const reviewCount = judged.filter(r => r.judgment.verdict === 'REVIEW').length

  return {
    hero: {
      replaceWinPct,
      promoteTermServingPct,
      negateMedianEurosStopped,
      raiseWinPct,
      cutWinPct,
      totalStamps:  judged.length,
      totalGraded:  judged.filter(r => r.judgment.verdict !== 'NO-DATA').length,
      reviewCount,
    },
    sections,
    judged,
  }
}

// ── ACoS Contribution ─────────────────────────────────────────────────────────
export interface AcosContributionMonthEntry {
  spend_stopped:       number
  currency:            string
  est_acos_points:     number | null
  bid_cut_delta_med:   number | null
  bid_raise_delta_med: number | null
  n_actions:           number
  rolling_acos?:       number | null        // market 30-day rolling ACoS
  band_position?:      'below' | 'in' | 'above' | null   // vs band_low/band_high
}

export interface AcosContributionEstateMonth {
  byCurrency:          Record<string, number>
  bid_cut_delta_med:   number | null
  bid_raise_delta_med: number | null
  n_actions:           number
}

export interface AcosContributionResult {
  byMarket: Record<string, Record<string, AcosContributionMonthEntry>>
  estate:   Record<string, AcosContributionEstateMonth>
}

export type MarketMonthSales = Record<string, Record<string, number>>

export function computeAcosContribution(
  judged: JudgedRow[],
  marketMonthSales: MarketMonthSales,
  marketRollingAcos: Record<string, number> = {},
  // Per-market target_acos from amazon_profiles — replaces hardcoded 25/35 constants
  // (#4 fix — 2026-08-12). Callers must pass this; defaults to empty (band falls back to 0.30±0.05).
  marketTargetAcos: Record<string, number> = {},
): AcosContributionResult {
  const getMonth = (r: JudgedRow): string | null => {
    if (!r.pushed_at) return null
    const d = new Date(r.pushed_at)
    if (isNaN(d.getTime())) return null
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }

  const acc: Record<string, Record<string, {
    currency:         string
    spendStoppedList: number[]
    cutDeltas:        number[]
    raiseDeltas:      number[]
    nActions:         number
  }>> = {}

  const ensure = (mkt: string, month: string, currency: string) => {
    if (!acc[mkt])        acc[mkt]        = {}
    if (!acc[mkt][month]) acc[mkt][month] = { currency, spendStoppedList: [], cutDeltas: [], raiseDeltas: [], nActions: 0 }
  }

  for (const r of judged) {
    const month    = getMonth(r)
    if (!month) continue
    const mkt      = r.country_code
    const currency = r.currency_code
    const v        = r.judgment.verdict

    if ((r.rec_type === 'NEGATE_TERM' || r.rec_type === 'NEGATE_TARGET') && (v === 'WIN' || v === 'PARTIAL' || v === 'REVIEW')) {
      ensure(mkt, month, currency)
      const s = r.judgment.euros_stopped
      if (s != null && !isNaN(s)) acc[mkt][month].spendStoppedList.push(s)
      acc[mkt][month].nActions++
    }

    if (r.rec_type === 'BID_ADJUST' && (v === 'WIN' || v === 'PARTIAL')) {
      ensure(mkt, month, currency)
      const delta = r.judgment.acos_delta
      if (delta != null && !isNaN(delta)) {
        if (r.judgment.direction === 'CUT')   acc[mkt][month].cutDeltas.push(delta)
        if (r.judgment.direction === 'RAISE') acc[mkt][month].raiseDeltas.push(delta)
      }
      acc[mkt][month].nActions++
    }
  }

  const byMarket: AcosContributionResult['byMarket'] = {}
  for (const mkt of Object.keys(acc)) {
    byMarket[mkt] = {}
    for (const month of Object.keys(acc[mkt])) {
      const d             = acc[mkt][month]
      const spend_stopped = d.spendStoppedList.reduce((a, b) => a + b, 0)
      const sales         = marketMonthSales[mkt]?.[month] ?? null
      const rolling_acos  = marketRollingAcos[mkt] ?? null
      const _ta   = marketTargetAcos[mkt] ?? 0.30
      const _bLow = _ta - 0.05
      const _bHigh = _ta + 0.05
      const band_position: 'below' | 'in' | 'above' | null =
        rolling_acos == null ? null
        : rolling_acos < _bLow  ? 'below'
        : rolling_acos <= _bHigh ? 'in'
        : 'above'
      byMarket[mkt][month] = {
        spend_stopped,
        currency:            d.currency,
        est_acos_points:     (sales != null && sales > 0) ? (spend_stopped / sales) * 100 : null,
        bid_cut_delta_med:   median(d.cutDeltas),
        bid_raise_delta_med: median(d.raiseDeltas),
        n_actions:           d.nActions,
        rolling_acos,
        band_position,
      }
    }
  }

  const estAcc: Record<string, {
    byCurrency: Record<string, number>
    nActions:   number
    cutD:       number[]
    raiseD:     number[]
  }> = {}

  for (const mkt of Object.keys(acc)) {
    for (const month of Object.keys(acc[mkt])) {
      if (!estAcc[month]) estAcc[month] = { byCurrency: {}, nActions: 0, cutD: [], raiseD: [] }
      const d   = acc[mkt][month]
      const cur = d.currency
      const amt = d.spendStoppedList.reduce((a, b) => a + b, 0)
      estAcc[month].byCurrency[cur] = (estAcc[month].byCurrency[cur] ?? 0) + amt
      estAcc[month].nActions += d.nActions
      estAcc[month].cutD.push(...d.cutDeltas)
      estAcc[month].raiseD.push(...d.raiseDeltas)
    }
  }

  const estate: AcosContributionResult['estate'] = {}
  for (const month of Object.keys(estAcc)) {
    const d = estAcc[month]
    estate[month] = {
      byCurrency:          d.byCurrency,
      bid_cut_delta_med:   median(d.cutD),
      bid_raise_delta_med: median(d.raiseD),
      n_actions:           d.nActions,
    }
  }

  return { byMarket, estate }
}
