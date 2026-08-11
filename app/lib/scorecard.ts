// app/lib/scorecard.ts
// Server-side scorecard logic — ported from scripts/scorecard.mjs
// Same judgment definitions; no deviations. See ADAPTATIONS export for honesty notes.
//
// DEVIATIONS FROM scorecard.mjs: none.

// ── Types ─────────────────────────────────────────────────────────────────────

export type Verdict = 'WIN' | 'PARTIAL' | 'LEAK' | 'NO-DATA'

export interface VerdictCounts {
  WIN:       number
  PARTIAL:   number
  LEAK:      number
  'NO-DATA': number
}

export interface RawScorecardRow {
  id:           string | number
  rec_type:     string
  target_text:  string
  campaign_id:  string | null
  evidence:     unknown
  country_code: string
  currency_code: string
  horizon:      string
  metrics:      unknown
  captured_at:  string
  pushed_at?:   string | null
}

export interface Judgment {
  verdict:          Verdict
  direction?:       string
  euros_stopped?:   number | null
  pct_of_ref?:      number
  pct_reduced?:     number
  acos_delta?:      number | null
  b0_spend?:        number | null
  hc_orders?:       number | null
  before_cost?:     number | null
  after_cost?:      number | null
  spend_change_pct?: number | null
  sales_change_pct?: number | null
  clicks?:          number
  purchases?:       number
  note?:            string
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
  return { WIN: 0, PARTIAL: 0, LEAK: 0, 'NO-DATA': 0 }
}

function aggCounts(rows: JudgedRow[]): { n: number; dn: number; counts: VerdictCounts } {
  const counts = zeroVerdicts()
  for (const r of rows) counts[r.judgment.verdict]++
  const n  = rows.length
  const dn = n - counts['NO-DATA']
  return { n, dn, counts }
}

// ── Judgment functions — direct port from scripts/scorecard.mjs ───────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeNegateTerm(ev: any, m: any): Judgment {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' }
  const cost     = safeN(m.cost)
  const refSpend = safeN(ev.spend)
  const stopped  = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null
  if (!isNaN(refSpend) && refSpend > 0) {
    const ratio = cost / refSpend
    if (ratio <= 0.05) return { verdict: 'WIN',     euros_stopped: stopped, pct_of_ref: ratio }
    if (ratio <= 0.50) return { verdict: 'PARTIAL', euros_stopped: stopped, pct_of_ref: ratio, pct_reduced: 1 - ratio }
    return               { verdict: 'LEAK',          euros_stopped: stopped, pct_of_ref: ratio }
  }
  if (cost < 0.10) return { verdict: 'WIN',    euros_stopped: stopped, note: 'refSpend unknown; absolute fallback' }
  return                  { verdict: 'PARTIAL', euros_stopped: stopped, note: 'refSpend unknown; absolute fallback' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeNegateTarget(ev: any, m: any): Judgment {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' }
  const cost     = safeN(m.cost)
  const refSpend = safeN(ev.spend)
  const stopped  = (!isNaN(refSpend) && !isNaN(cost)) ? refSpend - cost : null
  if (!isNaN(refSpend) && refSpend > 0) {
    const ratio = cost / refSpend
    if (ratio <= 0.05) return { verdict: 'WIN',     euros_stopped: stopped, pct_of_ref: ratio }
    if (ratio <= 0.50) return { verdict: 'PARTIAL', euros_stopped: stopped, pct_of_ref: ratio, pct_reduced: 1 - ratio }
    return               { verdict: 'LEAK',          euros_stopped: stopped, pct_of_ref: ratio }
  }
  if (cost < 0.10) return { verdict: 'WIN',    euros_stopped: stopped, note: 'refSpend unknown; absolute fallback' }
  return                  { verdict: 'PARTIAL', euros_stopped: stopped, note: 'refSpend unknown; absolute fallback' }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeBidAdjust(ev: any, m: any): Judgment {
  const pushed  = safeN(ev.pushed_bid ?? ev.proposed_bid)
  let   current = safeN(ev.current_bid)
  if (isNaN(current) && Array.isArray(ev.existing_targets) && ev.existing_targets.length > 0)
    current = safeN(ev.existing_targets[0].bid)

  const targetAcos = safeN(ev.params_used?.target_acos ?? 0.30)

  let direction: string
  if (!isNaN(current) && !isNaN(pushed)) {
    direction = pushed < current * 0.99  ? 'CUT'
              : pushed > current * 1.01  ? 'RAISE'
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

  if (direction === 'CUT') {
    const acosBetter = afterAcos !== null && beforeAcos !== null && afterAcos < beforeAcos
    const spendFell  = afterCost < beforeCost * 0.90
    const ordersHeld = afterSales >= beforeSales * 0.80
    if (acosBetter || (spendFell && ordersHeld))
      return { verdict: 'WIN',     direction, acos_delta: acosDelta }
    if (spendFell)
      return { verdict: 'PARTIAL', direction, acos_delta: acosDelta, note: 'spend fell but sales also fell' }
    return { verdict: 'LEAK',    direction, acos_delta: acosDelta }
  }

  if (direction === 'RAISE') {
    const clicksRose = afterClicks > beforeClks
    const acosOk     = afterAcos === null || afterAcos <= targetAcos * 1.20
    if (clicksRose && acosOk)  return { verdict: 'WIN',     direction, acos_delta: acosDelta }
    if (clicksRose && !acosOk) return { verdict: 'PARTIAL', direction, acos_delta: acosDelta,
                                         note: 'clicks rose but ACoS > target+20%' }
    return { verdict: 'LEAK',    direction, acos_delta: acosDelta, note: 'clicks did not rise' }
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
  if (b0Dark && hcServe)
    return { verdict: 'WIN',     note: 'B0 dark, HC serving', b0_spend: b0Spend, hc_orders: hcOrders }
  if (b0Dark)
    return { verdict: 'PARTIAL', note: 'B0 dark but HC not yet serving', b0_spend: b0Spend }
  if (hcServe)
    return { verdict: 'PARTIAL', note: 'HC serving but B0 still active', b0_spend: b0Spend }
  return   { verdict: 'LEAK',    note: 'B0 still active, HC not serving', b0_spend: b0Spend }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgePromoteTerm(ev: any, m: any, horizon: string): Judgment {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' }
  const clicks    = safeN(m.clicks)
  const purchases = safeN(m.purchases_14d ?? 0)
  if (isNaN(clicks)) return { verdict: 'NO-DATA', note: 'no clicks field in metrics' }
  if (horizon === 't14' && purchases > 0)
    return { verdict: 'WIN', note: 'STRONG: orders>0 at t14', clicks, purchases }
  if (clicks > 0)
    return { verdict: 'WIN', note: 'serving at ' + horizon + ' (clicks>0; impression proxy)', clicks }
  return { verdict: 'LEAK', note: 'rows found but zero clicks — keyword dark', clicks: 0 }
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
  if (horizon === 't14' && purchases > 0)
    return { verdict: 'WIN', note: 'STRONG: orders>0 at t14', clicks, purchases }
  if (clicks > 0) return { verdict: 'WIN', note: 'serving (clicks>0)', clicks }
  return { verdict: 'LEAK', note: 'target dark (rows found, zero clicks)', clicks: 0 }
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
  return {
    verdict: spendChg !== null ? (spendChg > 0 ? 'PARTIAL' : 'WIN') : 'PARTIAL',
    note: `spend_chg=${spendChg !== null ? (spendChg * 100).toFixed(0) + '%' : '?'} sales_chg=${salesChg !== null ? (salesChg * 100).toFixed(0) + '%' : '?'}`,
    spend_change_pct: spendChg,
    sales_change_pct: salesChg,
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function judgeCreateStructure(ev: any, m: any): Judgment {
  if (m.rows_found === 0) return { verdict: 'NO-DATA' }
  const impr = safeN(m.impressions)
  if (impr > 0) return { verdict: 'WIN',     note: `campaign serving (impr=${impr})` }
  return       { verdict: 'PARTIAL', note: 'campaign exists but impressions=0' }
}

function judgeRow(row: RawScorecardRow): Judgment {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ev = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : (row.evidence as any)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m  = typeof row.metrics  === 'string' ? JSON.parse(row.metrics)  : (row.metrics  as any)
  switch (row.rec_type) {
    case 'NEGATE_TERM':        return judgeNegateTerm(ev, m)
    case 'NEGATE_TARGET':      return judgeNegateTarget(ev, m)
    case 'BID_ADJUST':         return judgeBidAdjust(ev, m)
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

// ── Type order (task spec: REPLACE, PROMOTE_TERM, NEGATE_TERM, NEGATE_TARGET,
//   BID_ADJUST, then small cohorts) ──────────────────────────────────────────

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

// ── Adaptation notes (exported for honesty footer) ────────────────────────────

export const ADAPTATIONS: Record<string, string> = {
  NEGATE_TARGET:
    'NEGATE_TARGET: handler added 2026-08-11; metrics: clicks+cost from amazon_search_term_daily WHERE search_term = target ASIN. WIN bar mirrors NEGATE_TERM (≤5% of ev.spend).',
  REPLACE_PRODUCT_AD:
    'REPLACE_PRODUCT_AD: handler added 2026-08-11; B0+HC ad-pair rows from amazon_advertised_product_daily scoped by campaign_id. HC ASIN = ev.hc_isbn10. Grain: asin+campaign_id (approximate if ASIN rides other campaigns).',
  PROMOTE_TERM:
    'PROMOTE_TERM / CREATIVE_KEYWORD: stamp metrics lack impressions. Using clicks>0 as serving proxy (clicks ≥ 1 ⟹ impressions ≥ 1).',
  CREATIVE_KEYWORD:
    'PROMOTE_TERM / CREATIVE_KEYWORD: stamp metrics lack impressions. Using clicks>0 as serving proxy.',
  BID_ADJUST:
    'BID_ADJUST direction: proposed_bid == approved_bid == pushed_bid for all stamps; cannot use proposed-vs-approved delta. Direction resolved from evidence.current_bid vs pushed_bid (fallback: existing_targets[0].bid for older recs). WIN bar definition differs for CUTs vs RAISEs — see section.',
  NEGATE_TERM:
    'NEGATE_TERM WIN bar: changed 2026-08-11 from cost<0.10 (absolute, unreachable vs attribution lag) to ≤5% of ev.spend = WIN, ≤50% = PARTIAL, else LEAK.',
}

// ── Main export ───────────────────────────────────────────────────────────────

export function computeScorecard(rawRows: RawScorecardRow[]): ScorecardResult {
  const judged: JudgedRow[] = rawRows.map(r => ({ ...r, judgment: judgeRow(r) }))

  // ── Per-type sections ──────────────────────────────────────────────────
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

      // Small cohort or n<5: per-rec listing
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

      // BID_ADJUST: split CUTs vs RAISEs
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

      // Standard: compute median euros_stopped for negates
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

  // ── Hero stats (computed across ALL horizons) ──────────────────────────
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

  return {
    hero: {
      replaceWinPct,
      promoteTermServingPct,
      negateMedianEurosStopped,
      raiseWinPct,
      cutWinPct,
      totalStamps: judged.length,
      totalGraded: judged.filter(r => r.judgment.verdict !== 'NO-DATA').length,
    },
    sections,
    judged,
  }
}

// ── ACoS Contribution ─────────────────────────────────────────────────────────
// Computed section: attributable spend removed + directional bid delta estimates.
// Negation euros_stopped = attributable (counterfactual honest — zero orders on graded WIN/PARTIAL).
// Bid deltas = directional estimate (cruder; median ACoS delta × cohort).

export interface AcosContributionMonthEntry {
  euros_stopped:       number        // sum euros_stopped — NEGATE WIN+PARTIAL
  est_acos_points:     number | null // null when market-month sales unavailable
  bid_cut_delta_med:   number | null // median acos_delta for CUT WIN+PARTIAL (directional)
  bid_raise_delta_med: number | null // median acos_delta for RAISE WIN+PARTIAL (directional)
  n_actions:           number        // total NEGATE+BID_ADJUST WIN+PARTIAL stamps
}

export interface AcosContributionResult {
  byMarket: Record<string, Record<string, AcosContributionMonthEntry>> // market → YYYY-MM → entry
  estate:   Record<string, AcosContributionMonthEntry>                 // YYYY-MM → aggregate
}

// market → YYYY-MM → total ad sales (from amazon_campaign_daily.sales_14d)
export type MarketMonthSales = Record<string, Record<string, number>>

export function computeAcosContribution(
  judged: JudgedRow[],
  marketMonthSales: MarketMonthSales,
): AcosContributionResult {
  const getMonth = (r: JudgedRow): string | null => {
    if (!r.pushed_at) return null
    const d = new Date(r.pushed_at)
    if (isNaN(d.getTime())) return null
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
  }

  const acc: Record<string, Record<string, {
    eurosStoppedList: number[]
    cutDeltas:        number[]
    raiseDeltas:      number[]
    nActions:         number
  }>> = {}

  const ensure = (mkt: string, month: string) => {
    if (!acc[mkt])        acc[mkt]        = {}
    if (!acc[mkt][month]) acc[mkt][month] = { eurosStoppedList: [], cutDeltas: [], raiseDeltas: [], nActions: 0 }
  }

  for (const r of judged) {
    const month = getMonth(r)
    if (!month) continue
    const mkt = r.country_code
    const v   = r.judgment.verdict

    if ((r.rec_type === 'NEGATE_TERM' || r.rec_type === 'NEGATE_TARGET') && (v === 'WIN' || v === 'PARTIAL')) {
      ensure(mkt, month)
      const s = r.judgment.euros_stopped
      if (s != null && !isNaN(s)) acc[mkt][month].eurosStoppedList.push(s)
      acc[mkt][month].nActions++
    }

    if (r.rec_type === 'BID_ADJUST' && (v === 'WIN' || v === 'PARTIAL')) {
      ensure(mkt, month)
      const delta = r.judgment.acos_delta
      if (delta != null && !isNaN(delta)) {
        if (r.judgment.direction === 'CUT')   acc[mkt][month].cutDeltas.push(delta)
        if (r.judgment.direction === 'RAISE') acc[mkt][month].raiseDeltas.push(delta)
      }
      acc[mkt][month].nActions++
    }
  }

  // ── Per-market result ──
  const byMarket: AcosContributionResult['byMarket'] = {}
  for (const mkt of Object.keys(acc)) {
    byMarket[mkt] = {}
    for (const month of Object.keys(acc[mkt])) {
      const d             = acc[mkt][month]
      const euros_stopped = d.eurosStoppedList.reduce((a, b) => a + b, 0)
      const sales         = marketMonthSales[mkt]?.[month] ?? null
      byMarket[mkt][month] = {
        euros_stopped,
        est_acos_points:     (sales != null && sales > 0) ? (euros_stopped / sales) * 100 : null,
        bid_cut_delta_med:   median(d.cutDeltas),
        bid_raise_delta_med: median(d.raiseDeltas),
        n_actions:           d.nActions,
      }
    }
  }

  // ── Estate totals (aggregate across all markets per month) ──
  const estAcc: Record<string, { euros: number; nActions: number; cutD: number[]; raiseD: number[] }> = {}
  for (const mkt of Object.keys(acc)) {
    for (const month of Object.keys(acc[mkt])) {
      if (!estAcc[month]) estAcc[month] = { euros: 0, nActions: 0, cutD: [], raiseD: [] }
      const d = acc[mkt][month]
      estAcc[month].euros    += d.eurosStoppedList.reduce((a, b) => a + b, 0)
      estAcc[month].nActions += d.nActions
      estAcc[month].cutD.push(...d.cutDeltas)
      estAcc[month].raiseD.push(...d.raiseDeltas)
    }
  }
  const estate: AcosContributionResult['estate'] = {}
  for (const month of Object.keys(estAcc)) {
    const d          = estAcc[month]
    const totalSales = Object.keys(marketMonthSales)
      .reduce((sum, mkt) => sum + (marketMonthSales[mkt]?.[month] ?? 0), 0)
    estate[month] = {
      euros_stopped:       d.euros,
      est_acos_points:     totalSales > 0 ? (d.euros / totalSales) * 100 : null,
      bid_cut_delta_med:   median(d.cutD),
      bid_raise_delta_med: median(d.raiseD),
      n_actions:           d.nActions,
    }
  }

  return { byMarket, estate }
}
