export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { computeScorecard, ADAPTATIONS } from '@/app/lib/scorecard'
import type { TypeSection } from '@/app/lib/scorecard'
import { HorizonFilter } from './HorizonFilter'
import ScorecardClient from './ScorecardClient'
import type {
  PanelData, PanelCounts, PanelPerRec, PanelAcosData,
  TilePayload, MatrixRow, MatrixCellData, SmallCohortEntry,
} from './ScorecardClient'

// ── DB row shape ───────────────────────────────────────────────────────────────
interface RawRow {
  id:            string
  rec_type:      string
  target_text:   string
  campaign_id:   string | null
  evidence:      unknown
  country_code:  string
  currency_code: string
  horizon:       string
  metrics:       unknown
  captured_at:   string
}

// ── Verdict tile helpers ───────────────────────────────────────────────────────
function buildMatureMap(rows: RawRow[]): Map<string, Map<string, Date>> {
  const map = new Map<string, Map<string, Date>>()
  for (const r of rows) {
    if (!map.has(r.rec_type)) map.set(r.rec_type, new Map())
    const hMap = map.get(r.rec_type)!
    const d    = new Date(r.captured_at)
    const prev = hMap.get(r.horizon)
    if (!prev || d < prev) hMap.set(r.horizon, d)
  }
  return map
}
function horizonDays(h: string): number {
  const m = h.match(/t(\d+)/); return m ? parseInt(m[1]) : 0
}
function matureDateLabel(
  matureMap: Map<string, Map<string, Date>>,
  recType: string, fallbackHorizon: string, targetHorizon: string,
): string | null {
  const hMap = matureMap.get(recType); if (!hMap) return null
  const base = hMap.get(fallbackHorizon); if (!base) return null
  const d = new Date(base)
  d.setDate(d.getDate() + horizonDays(targetHorizon) - horizonDays(fallbackHorizon))
  return d.toLocaleDateString('en-GB', { month: 'short', day: 'numeric' })
}

interface TileStats { winPct: number | null; dn: number; usedHorizon: string | null }
function getTileStats(section: TypeSection, horizon: string, direction?: 'RAISE' | 'CUT'): TileStats {
  if (horizon === 'all') {
    let totalWin = 0, totalDn = 0
    for (const hg of section.horizons) {
      if (direction) {
        if (hg.bidSplit) { const sp = hg.bidSplit.find(s => s.direction === direction); if (sp) { totalWin += sp.counts.WIN; totalDn += sp.dn } }
        else if (hg.perRec) { const rel = hg.perRec.filter(r => r.direction === direction && r.verdict !== 'NO-DATA'); totalDn += rel.length; totalWin += rel.filter(r => r.verdict === 'WIN').length }
      } else { totalWin += hg.counts.WIN; totalDn += hg.dn }
    }
    return { winPct: totalDn > 0 ? totalWin / totalDn * 100 : null, dn: totalDn, usedHorizon: null }
  }
  const ordered = [...section.horizons.filter(h => h.horizon === horizon), ...section.horizons.filter(h => h.horizon !== horizon)]
  for (const hg of ordered) {
    const fromOther = hg.horizon !== horizon
    if (direction) {
      if (hg.bidSplit) { const sp = hg.bidSplit.find(s => s.direction === direction); if (sp && sp.dn > 0) return { winPct: sp.counts.WIN / sp.dn * 100, dn: sp.dn, usedHorizon: fromOther ? hg.horizon : null } }
      else if (hg.perRec) { const rel = hg.perRec.filter(r => r.direction === direction && r.verdict !== 'NO-DATA'); if (rel.length > 0) return { winPct: rel.filter(r => r.verdict === 'WIN').length / rel.length * 100, dn: rel.length, usedHorizon: fromOther ? hg.horizon : null } }
    } else if (hg.dn > 0) return { winPct: hg.counts.WIN / hg.dn * 100, dn: hg.dn, usedHorizon: fromOther ? hg.horizon : null }
  }
  return { winPct: null, dn: 0, usedHorizon: null }
}

// ── Matrix helpers ─────────────────────────────────────────────────────────────
type MatrixRowDef = { key: string; label: string; recType: string; direction?: 'RAISE' | 'CUT' }
const MATRIX_ROWS: MatrixRowDef[] = [
  { key: 'REPLACE',          label: 'REPLACE',           recType: 'REPLACE_PRODUCT_AD'             },
  { key: 'PROMOTE_TERM',     label: 'PROMOTE_TERM',      recType: 'PROMOTE_TERM'                    },
  { key: 'NEGATE_TERM',      label: 'NEGATE_TERM',       recType: 'NEGATE_TERM'                     },
  { key: 'NEGATE_TARGET',    label: 'NEGATE_TARGET',     recType: 'NEGATE_TARGET'                   },
  { key: 'BID_ADJUST·CUT',   label: 'BID_ADJUST · CUT',  recType: 'BID_ADJUST', direction: 'CUT'   },
  { key: 'BID_ADJUST·RAISE', label: 'BID_ADJUST · RAISE',recType: 'BID_ADJUST', direction: 'RAISE' },
]
const SMALL_COHORT_TYPES = ['PROMOTE_ASIN','CREATIVE_KEYWORD','CREATIVE_TARGET','PAUSE_CAMPAIGN','BUDGET_ADJUST','CREATE_STRUCTURE']
const MAIN_REC_TYPES     = new Set(MATRIX_ROWS.map(r => r.recType))

type TileDef = { key: string; label: string; recType: string; direction?: 'RAISE' | 'CUT' }
const TILE_DEFS: TileDef[] = [
  { key: 'REPLACE',          label: 'REPLACE',          recType: 'REPLACE_PRODUCT_AD'             },
  { key: 'PROMOTE_TERM',     label: 'PROMOTE_TERM',     recType: 'PROMOTE_TERM'                    },
  { key: 'NEGATE_TERM',      label: 'NEGATE_TERM',      recType: 'NEGATE_TERM'                     },
  { key: 'NEGATE_TARGET',    label: 'NEGATE_TARGET',    recType: 'NEGATE_TARGET'                   },
  { key: 'BID_ADJUST·RAISE', label: 'BID_ADJUST·RAISE', recType: 'BID_ADJUST', direction: 'RAISE' },
  { key: 'BID_ADJUST·CUT',   label: 'BID_ADJUST·CUT',   recType: 'BID_ADJUST', direction: 'CUT'   },
]

function getMatrixMarkets(sections: TypeSection[], horizon: string): string[] {
  const s = new Set<string>()
  for (const sec of sections) {
    if (!MAIN_REC_TYPES.has(sec.recType)) continue
    const hGroups = horizon === 'all' ? sec.horizons : sec.horizons.filter(h => h.horizon === horizon)
    for (const hg of hGroups) {
      for (const m of hg.byMarket) s.add(m.market)
      if (hg.bidSplit) for (const sp of hg.bidSplit) for (const m of sp.byMarket) s.add(m.market)
      if (hg.perRec)   for (const r  of hg.perRec)  s.add(r.market)
    }
  }
  return [...s].sort()
}

function getMatrixCell(sections: TypeSection[], recType: string, direction: 'RAISE'|'CUT'|undefined, market: string, horizon: string): { dn: number; winPct: number | null } {
  const section = sections.find(s => s.recType === recType)
  if (!section) return { dn: 0, winPct: null }
  const hGroups = horizon === 'all' ? section.horizons : section.horizons.filter(h => h.horizon === horizon)
  let totalWin = 0, totalDn = 0
  for (const hg of hGroups) {
    if (direction) {
      if (hg.bidSplit) { const sp = hg.bidSplit.find(s => s.direction === direction); if (sp) { const m = sp.byMarket.find(m => m.market === market); if (m) { totalWin += m.counts.WIN; totalDn += m.dn } } }
      else if (hg.perRec) { const rel = hg.perRec.filter(r => r.direction === direction && r.market === market && r.verdict !== 'NO-DATA'); totalDn += rel.length; totalWin += rel.filter(r => r.verdict === 'WIN').length }
    } else {
      if (hg.byMarket.length > 0) { const m = hg.byMarket.find(m => m.market === market); if (m) { totalWin += m.counts.WIN; totalDn += m.dn } }
      else if (hg.perRec) { const rel = hg.perRec.filter(r => r.market === market && r.verdict !== 'NO-DATA'); totalDn += rel.length; totalWin += rel.filter(r => r.verdict === 'WIN').length }
    }
  }
  return { dn: totalDn, winPct: totalDn > 0 ? totalWin / totalDn * 100 : null }
}

// ── Panel data helpers ─────────────────────────────────────────────────────────
function medianOfNonNull(vals: (number | null)[]): number | null {
  const ns = vals.filter((x): x is number => x !== null).sort((a, b) => a - b)
  if (ns.length === 0) return null
  const mid = Math.floor(ns.length / 2)
  return ns.length % 2 === 0 ? (ns[mid - 1] + ns[mid]) / 2 : ns[mid]
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseBidAcosPoints(rawRows: RawRow[], horizon: string, market?: string) {
  const rows = rawRows.filter(r =>
    r.rec_type === 'BID_ADJUST' &&
    (horizon === 'all' || r.horizon === horizon) &&
    (!market || r.country_code === market)
  )
  const cuts:   { before: number | null; after: number | null }[] = []
  const raises: { before: number | null; after: number | null }[] = []
  for (const row of rows) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ev = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const m  = typeof row.metrics  === 'string' ? JSON.parse(row.metrics)  : row.metrics  as any
    const pushed  = Number(ev.pushed_bid ?? ev.proposed_bid)
    let current   = Number(ev.current_bid)
    if (isNaN(current) && Array.isArray(ev.existing_targets) && ev.existing_targets.length > 0)
      current = Number(ev.existing_targets[0]?.bid)
    let dir = 'UNKNOWN'
    if (!isNaN(current) && !isNaN(pushed))
      dir = pushed < current * 0.99 ? 'CUT' : pushed > current * 1.01 ? 'RAISE' : 'FLAT'
    const afterSales  = Number(m.sales_14d)
    const beforeSales = Number(m.before_sales_14d)
    const afterAcos   = afterSales  > 0 ? Number(m.cost)        / afterSales  : null
    const beforeAcos  = beforeSales > 0 ? Number(m.before_cost) / beforeSales : null
    if (dir === 'CUT')   cuts.push({ before: beforeAcos, after: afterAcos })
    if (dir === 'RAISE') raises.push({ before: beforeAcos, after: afterAcos })
  }
  return { cuts, raises }
}

function buildPanelData(
  sections:  TypeSection[],
  rawRows:   RawRow[],
  recType:   string,
  direction: 'CUT' | 'RAISE' | undefined,
  market:    string | undefined,
  horizon:   string,
  label:     string,
  panelKey:  string,
): PanelData {
  const section = sections.find(s => s.recType === recType)
  const hGroups = !section ? [] : (horizon === 'all' ? section.horizons : section.horizons.filter(h => h.horizon === horizon))

  let win = 0, partial = 0, leak = 0, nodata = 0, totalN = 0
  const perRecEntries: PanelPerRec[] = []

  for (const hg of hGroups) {
    if (direction) {
      if (hg.bidSplit) {
        const sp = hg.bidSplit.find(s => s.direction === direction)
        if (sp) {
          if (market) {
            const mkt = sp.byMarket.find(m => m.market === market)
            if (mkt) { win += mkt.counts.WIN; partial += mkt.counts.PARTIAL; leak += mkt.counts.LEAK; nodata += mkt.counts['NO-DATA']; totalN += mkt.n }
          } else { win += sp.counts.WIN; partial += sp.counts.PARTIAL; leak += sp.counts.LEAK; nodata += sp.counts['NO-DATA']; totalN += sp.n }
        }
      } else if (hg.perRec) {
        const rel = hg.perRec.filter(r => r.direction === direction && (!market || r.market === market))
        for (const r of rel) {
          perRecEntries.push({ id: r.id, market: r.market, direction: r.direction, verdict: r.verdict, note: r.note })
          totalN++
          if (r.verdict === 'WIN') win++; else if (r.verdict === 'PARTIAL') partial++; else if (r.verdict === 'LEAK') leak++; else nodata++
        }
      }
    } else {
      if (hg.byMarket.length > 0) {
        if (market) {
          const mkt = hg.byMarket.find(m => m.market === market)
          if (mkt) { win += mkt.counts.WIN; partial += mkt.counts.PARTIAL; leak += mkt.counts.LEAK; nodata += mkt.counts['NO-DATA']; totalN += mkt.n }
        } else { win += hg.counts.WIN; partial += hg.counts.PARTIAL; leak += hg.counts.LEAK; nodata += hg.counts['NO-DATA']; totalN += hg.n }
      } else if (hg.perRec) {
        const rel = market ? hg.perRec.filter(r => r.market === market) : hg.perRec
        for (const r of rel) {
          perRecEntries.push({ id: r.id, market: r.market, direction: r.direction, verdict: r.verdict, note: r.note })
          totalN++
          if (r.verdict === 'WIN') win++; else if (r.verdict === 'PARTIAL') partial++; else if (r.verdict === 'LEAK') leak++; else nodata++
        }
      }
    }
  }

  const counts: PanelCounts = { WIN: win, PARTIAL: partial, LEAK: leak, 'NO-DATA': nodata }
  const dn = totalN - nodata

  // Median € stopped (NEGATE types)
  let medianEurosStopped: number | null | undefined = undefined
  if (recType === 'NEGATE_TERM' || recType === 'NEGATE_TARGET') {
    const stops: (number | null)[] = rawRows
      .filter(r => r.rec_type === recType && (horizon === 'all' || r.horizon === horizon) && (!market || r.country_code === market))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map(row => { const ev = typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence as any; const m = typeof row.metrics === 'string' ? JSON.parse(row.metrics) : row.metrics as any; const ref = Number(ev.spend); const cost = Number(m.cost); return (!isNaN(ref) && !isNaN(cost)) ? ref - cost : null })
    medianEurosStopped = medianOfNonNull(stops)
  }

  // ACoS dumbbell data (BID_ADJUST only — always both directions for context)
  let acosData: PanelAcosData | undefined = undefined
  if (recType === 'BID_ADJUST') {
    const { cuts, raises } = parseBidAcosPoints(rawRows, horizon, market)
    acosData = {
      cut:   { beforeMedian: medianOfNonNull(cuts.map(c => c.before)),   afterMedian: medianOfNonNull(cuts.map(c => c.after)),   n: cuts.length   },
      raise: { beforeMedian: medianOfNonNull(raises.map(r => r.before)), afterMedian: medianOfNonNull(raises.map(r => r.after)), n: raises.length },
    }
  }

  return {
    key: panelKey, label, recType, counts, n: totalN, dn,
    medianEurosStopped,
    acosData,
    perRec:         perRecEntries.length > 0 ? perRecEntries : undefined,
    adaptationNote: ADAPTATIONS[recType] ?? undefined,
  }
}

// ── Page ───────────────────────────────────────────────────────────────────────
export default async function ScorecardPage({
  searchParams,
}: {
  searchParams: Promise<{ horizon?: string }>
}) {
  const sp      = await searchParams
  const horizon = sp.horizon ?? 'all'

  const sql = neon(process.env.DATABASE_URL!)

  const rawRows = (await sql`
    SELECT
      r.id::text,
      r.rec_type,
      r.target_text,
      r.campaign_id::text,
      r.evidence,
      p.country_code,
      p.currency_code,
      o.horizon,
      o.metrics,
      o.captured_at::text
    FROM recommendations   r
    JOIN rec_outcomes      o ON o.rec_id     = r.id
    JOIN amazon_profiles   p ON p.profile_id = r.profile_id
    WHERE r.status = 'PUSHED'
    ORDER BY r.rec_type, o.horizon, p.country_code, r.id
  `) as unknown as RawRow[]

  const { sections, hero } = computeScorecard(rawRows)
  const matureMap           = buildMatureMap(rawRows)

  // ── Tiles ──────────────────────────────────────────────────────────────────
  const tiles: TilePayload[] = TILE_DEFS.map(def => {
    const panelKey = `tile:${def.key}`
    const section  = sections.find(s => s.recType === def.recType)
    if (!section) return { ...def, winPct: null, dn: 0, usedHorizon: null, matureDate: null, panelKey }
    const { winPct, dn, usedHorizon } = getTileStats(section, horizon, def.direction)
    const matureDate = usedHorizon && horizon !== 'all'
      ? matureDateLabel(matureMap, def.recType, usedHorizon, horizon) : null
    return { ...def, winPct, dn, usedHorizon, matureDate, panelKey }
  })

  // ── Matrix ─────────────────────────────────────────────────────────────────
  const matrixMarkets = getMatrixMarkets(sections, horizon)
  const matrixRows: MatrixRow[] = MATRIX_ROWS.map(r => ({ key: r.key, label: r.label }))

  const matrixCells: Record<string, MatrixCellData> = {}
  for (const row of MATRIX_ROWS) {
    for (const mkt of matrixMarkets) {
      const cellKey  = `${row.key}:${mkt}`
      const panelKey = `cell:${row.key}:${mkt}`
      const { dn, winPct } = getMatrixCell(sections, row.recType, row.direction, mkt, horizon)
      matrixCells[cellKey] = { dn, winPct, panelKey }
    }
  }

  // ── Panel data map ─────────────────────────────────────────────────────────
  const panelDataMap: Record<string, PanelData> = {}

  // Tile panels (all markets)
  for (const def of TILE_DEFS) {
    const panelKey = `tile:${def.key}`
    panelDataMap[panelKey] = buildPanelData(sections, rawRows, def.recType, def.direction, undefined, horizon, def.label, panelKey)
  }
  // Matrix cell panels (per market)
  for (const row of MATRIX_ROWS) {
    for (const mkt of matrixMarkets) {
      const panelKey = `cell:${row.key}:${mkt}`
      panelDataMap[panelKey] = buildPanelData(sections, rawRows, row.recType, row.direction, mkt, horizon, `${row.label} · ${mkt}`, panelKey)
    }
  }

  // ── Small cohorts ──────────────────────────────────────────────────────────
  const smallCohorts: SmallCohortEntry[] = SMALL_COHORT_TYPES.flatMap(rt => {
    const sec = sections.find(s => s.recType === rt)
    if (!sec) return []
    const hGroups = horizon === 'all' ? sec.horizons : sec.horizons.filter(h => h.horizon === horizon)
    if (hGroups.length === 0) return []
    let n = 0, win = 0, partial = 0, leak = 0, nodata = 0
    for (const hg of hGroups) { n += hg.n; win += hg.counts.WIN; partial += hg.counts.PARTIAL; leak += hg.counts.LEAK; nodata += hg.counts['NO-DATA'] }
    if (n === 0) return []
    const parts = [win > 0 ? `${win} WIN` : '', partial > 0 ? `${partial} PARTIAL` : '', leak > 0 ? `${leak} LEAK` : '', nodata > 0 ? `${nodata} NO-DATA` : ''].filter(Boolean)
    return [{ rt, n, summary: parts.join(' · ') || '—' }]
  })

  return (
    <div>
      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h1 style={{ marginBottom: 0 }}>Scorecard</h1>
        <span style={{ fontSize: '0.8rem', color: 'var(--cdl-muted)' }}>
          {rawRows.length} stamps · {hero.totalGraded} graded
        </span>
      </div>

      {/* ── Horizon toggle ── */}
      <HorizonFilter current={horizon} />

      {/* ── Interactive layer (client) ── */}
      <ScorecardClient
        tiles={tiles}
        matrixRows={matrixRows}
        matrixMarkets={matrixMarkets}
        matrixCells={matrixCells}
        panelDataMap={panelDataMap}
        smallCohorts={smallCohorts}
      />

      {rawRows.length === 0 && (
        <p style={{ color: 'var(--cdl-muted)' }}>No graded outcomes yet for horizon: {horizon}.</p>
      )}
    </div>
  )
}
