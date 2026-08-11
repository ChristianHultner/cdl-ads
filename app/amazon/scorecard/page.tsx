export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { computeScorecard, ADAPTATIONS } from '@/app/lib/scorecard'
import type {
  HorizonGroup,
  BidDirectionGroup,
  VerdictCounts,
  MarketCounts,
} from '@/app/lib/scorecard'
import { HorizonFilter } from './HorizonFilter'

// ── DB row shape ───────────────────────────────────────────────────────────────
interface RawRow {
  id:           string
  rec_type:     string
  target_text:  string
  campaign_id:  string | null
  evidence:     unknown
  country_code: string
  currency_code: string
  horizon:      string
  metrics:      unknown
  captured_at:  string
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function pct(n: number, total: number): string {
  if (total === 0) return '—'
  return (n / total * 100).toFixed(1) + '%'
}

function fmtPct(v: number | null): string {
  return v === null ? '—' : v.toFixed(1) + '%'
}

// ── Stacked bar component ──────────────────────────────────────────────────────
function StackedBar({ counts, dn, n }: { counts: VerdictCounts; dn: number; n: number }) {
  if (dn === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
        <div style={{
          flex: 1, height: '10px', borderRadius: '4px',
          background: 'rgba(138,151,165,0.25)',
        }} />
        <span style={{ fontSize: '0.75rem', color: 'var(--cdl-muted)', whiteSpace: 'nowrap' }}>
          all NO-DATA ({n})
        </span>
      </div>
    )
  }
  const wPct   = counts.WIN     / dn * 100
  const paPct  = counts.PARTIAL / dn * 100
  const lPct   = counts.LEAK    / dn * 100
  const ndPct  = counts['NO-DATA'] > 0 ? counts['NO-DATA'] / n * 100 : 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
      <div style={{ display: 'flex', height: '10px', borderRadius: '4px', overflow: 'hidden', background: 'rgba(138,151,165,0.2)' }}>
        {wPct  > 0 && <div style={{ width: `${wPct}%`,  background: 'var(--cdl-ok)',   flexShrink: 0 }} title={`WIN ${pct(counts.WIN, dn)}`} />}
        {paPct > 0 && <div style={{ width: `${paPct}%`, background: '#e6a817',          flexShrink: 0 }} title={`PARTIAL ${pct(counts.PARTIAL, dn)}`} />}
        {lPct  > 0 && <div style={{ width: `${lPct}%`,  background: 'var(--cdl-warn)', flexShrink: 0 }} title={`LEAK ${pct(counts.LEAK, dn)}`} />}
        {ndPct > 0 && <div style={{ width: `${ndPct}%`, background: 'rgba(138,151,165,0.4)', flexShrink: 0 }} title={`NO-DATA ${counts['NO-DATA']}`} />}
      </div>
      <div style={{ display: 'flex', gap: '0.75rem', fontSize: '0.73rem', flexWrap: 'wrap' }}>
        {counts.WIN     > 0 && <span style={{ color: 'var(--cdl-ok)' }}>WIN {pct(counts.WIN, dn)}</span>}
        {counts.PARTIAL > 0 && <span style={{ color: '#a07010' }}>PARTIAL {pct(counts.PARTIAL, dn)}</span>}
        {counts.LEAK    > 0 && <span style={{ color: 'var(--cdl-warn)' }}>LEAK {pct(counts.LEAK, dn)}</span>}
        {counts['NO-DATA'] > 0 && <span style={{ color: 'var(--cdl-muted)' }}>NO-DATA {counts['NO-DATA']}</span>}
        <span style={{ color: 'var(--cdl-muted)', marginLeft: 'auto' }}>n={n}</span>
      </div>
    </div>
  )
}

// ── Market rows under a section ────────────────────────────────────────────────
function MarketRows({ markets }: { markets: MarketCounts[] }) {
  if (markets.length === 0) return null
  return (
    <div style={{ marginTop: '0.5rem', paddingLeft: '1rem', borderLeft: '2px solid #eef4f8' }}>
      {markets.map(m => (
        <div key={m.market} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.35rem' }}>
          <span style={{ fontWeight: 700, fontSize: '0.78rem', color: 'var(--cdl-muted)', width: '2.2rem', flexShrink: 0 }}>
            {m.market}
          </span>
          <div style={{ flex: 1 }}>
            <StackedBar counts={m.counts} dn={m.dn} n={m.n} />
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Honesty note ───────────────────────────────────────────────────────────────
function HonestyNote({ text }: { text: string }) {
  return (
    <p style={{
      fontSize: '0.73rem',
      color: 'var(--cdl-muted)',
      fontStyle: 'italic',
      marginTop: '0.65rem',
      lineHeight: 1.5,
      borderTop: '1px solid #eef4f8',
      paddingTop: '0.5rem',
    }}>
      ⚠ {text}
    </p>
  )
}

// ── Horizon group renderer ─────────────────────────────────────────────────────
function HorizonSection({ hg, recType }: { hg: HorizonGroup; recType: string }) {
  // Per-rec small-cohort
  if (hg.perRec) {
    return (
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--cdl-muted)', marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {hg.horizon.toUpperCase()} — n={hg.n} (per-rec; too small for rates)
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {hg.perRec.map((r, i) => {
            const color = r.verdict === 'WIN' ? 'var(--cdl-ok)' : r.verdict === 'PARTIAL' ? '#a07010' : r.verdict === 'LEAK' ? 'var(--cdl-warn)' : 'var(--cdl-muted)'
            return (
              <div key={i} style={{ fontSize: '0.8rem', display: 'flex', gap: '0.5rem' }}>
                <span style={{ color: 'var(--cdl-muted)', fontVariantNumeric: 'tabular-nums' }}>#{r.id}</span>
                <span style={{ fontWeight: 600, color: 'var(--cdl-muted)' }}>[{r.market}]</span>
                {r.direction && <span style={{ color: 'var(--cdl-blue)' }}>[{r.direction}]</span>}
                <span style={{ fontWeight: 700, color }}>{r.verdict}</span>
                {r.note && <span style={{ color: 'var(--cdl-muted)', fontStyle: 'italic' }}>{r.note}</span>}
              </div>
            )
          })}
        </div>
      </div>
    )
  }

  // BID_ADJUST split
  if (hg.bidSplit) {
    return (
      <div style={{ marginBottom: '0.75rem' }}>
        <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--cdl-muted)', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {hg.horizon.toUpperCase()} — n={hg.n}
        </div>
        {hg.bidSplit.map((split: BidDirectionGroup) => (
          <div key={split.direction} style={{ marginBottom: '0.85rem' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.35rem' }}>
              <span style={{
                display: 'inline-block', padding: '1px 8px', borderRadius: '4px', fontSize: '0.72rem', fontWeight: 700,
                background: split.direction === 'RAISE' ? 'rgba(26,127,78,0.13)' : 'rgba(192,57,43,0.12)',
                color: split.direction === 'RAISE' ? 'var(--cdl-ok)' : 'var(--cdl-warn)',
              }}>
                {split.direction}
              </span>
              <span style={{ fontSize: '0.78rem', color: 'var(--cdl-muted)' }}>n={split.n}</span>
              {split.medianAcosDelta !== null && (
                <span style={{ fontSize: '0.75rem', color: 'var(--cdl-muted)' }}>
                  median ACoS Δ: {(split.medianAcosDelta * 100).toFixed(1)}pp (neg=improvement)
                </span>
              )}
            </div>
            <StackedBar counts={split.counts} dn={split.dn} n={split.n} />
            <MarketRows markets={split.byMarket} />
          </div>
        ))}
      </div>
    )
  }

  // Standard
  return (
    <div style={{ marginBottom: '0.75rem' }}>
      <div style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--cdl-muted)', marginBottom: '0.35rem', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {hg.horizon.toUpperCase()} — n={hg.n}
        {hg.medianEurosStopped != null && (
          <span style={{ fontWeight: 400, marginLeft: '0.75rem' }}>
            median stopped: €{hg.medianEurosStopped.toFixed(2)}
          </span>
        )}
      </div>
      <StackedBar counts={hg.counts} dn={hg.dn} n={hg.n} />
      <MarketRows markets={hg.byMarket} />
    </div>
  )
}

// ── Type label map ─────────────────────────────────────────────────────────────
const TYPE_LABEL: Record<string, string> = {
  REPLACE_PRODUCT_AD: 'REPLACE',
  PROMOTE_TERM:       'PROMOTE_TERM',
  NEGATE_TERM:        'NEGATE_TERM',
  NEGATE_TARGET:      'NEGATE_TARGET',
  BID_ADJUST:         'BID_ADJUST',
  CREATIVE_KEYWORD:   'CREATIVE_KEYWORD',
  PROMOTE_ASIN:       'PROMOTE_ASIN',
  CREATIVE_TARGET:    'CREATIVE_TARGET',
  PAUSE_CAMPAIGN:     'PAUSE_CAMPAIGN',
  BUDGET_ADJUST:      'BUDGET_ADJUST',
  CREATE_STRUCTURE:   'CREATE_STRUCTURE',
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

  const hClause = horizon === 'all' ? sql`` : sql`AND o.horizon = ${horizon}`

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
    ${hClause}
    ORDER BY r.rec_type, o.horizon, p.country_code, r.id
  `) as unknown as RawRow[]

  const result = computeScorecard(rawRows)
  const { hero, sections } = result

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '1.25rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h1 style={{ marginBottom: 0 }}>Scorecard</h1>
        <span style={{ fontSize: '0.8rem', color: 'var(--cdl-muted)' }}>
          {rawRows.length} stamps · {hero.totalGraded} graded
        </span>
      </div>

      {/* ── Horizon toggle ── */}
      <HorizonFilter current={horizon} />

      {/* ── HERO strip ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: '1rem',
        marginBottom: '2rem',
      }}>
        <HeroCard
          label="REPLACE WIN"
          value={fmtPct(hero.replaceWinPct)}
          sub="B0 dark + HC serving"
          color="var(--cdl-ok)"
        />
        <HeroCard
          label="PROMOTE_TERM SERVING"
          value={fmtPct(hero.promoteTermServingPct)}
          sub="clicks > 0 proxy"
          color="var(--cdl-blue)"
        />
        <HeroCard
          label="NEGATE MEDIAN €"
          value={hero.negateMedianEurosStopped !== null
            ? `€${hero.negateMedianEurosStopped.toFixed(0)}`
            : '—'}
          sub="spend stopped"
          color="var(--cdl-ok)"
        />
        <HeroCard
          label="RAISE WIN"
          value={fmtPct(hero.raiseWinPct)}
          sub={`CUT WIN ${fmtPct(hero.cutWinPct)} ← inversion`}
          color="var(--cdl-ok)"
          subColor="var(--cdl-warn)"
        />
      </div>

      {/* ── Per-type sections ── */}
      {sections.map(sec => {
        const adaptation = ADAPTATIONS[sec.recType]
        return (
          <div key={sec.recType} className="table-card" style={{ padding: '1rem 1.25rem', marginBottom: '1.25rem' }}>
            <h2 style={{ marginBottom: '0.85rem' }}>
              {TYPE_LABEL[sec.recType] ?? sec.recType}
              {sec.isSmallCohort && (
                <span style={{ fontWeight: 400, fontSize: '0.78rem', color: 'var(--cdl-muted)', marginLeft: '0.5rem' }}>
                  small cohort
                </span>
              )}
            </h2>
            {sec.horizons.map(hg => (
              <HorizonSection key={hg.horizon} hg={hg} recType={sec.recType} />
            ))}
            {adaptation && <HonestyNote text={adaptation} />}
          </div>
        )
      })}

      {rawRows.length === 0 && (
        <p style={{ color: 'var(--cdl-muted)' }}>No graded outcomes yet for horizon: {horizon}.</p>
      )}
    </div>
  )
}

// ── Hero card sub-component ────────────────────────────────────────────────────
function HeroCard({
  label,
  value,
  sub,
  color,
  subColor,
}: {
  label:     string
  value:     string
  sub:       string
  color:     string
  subColor?: string
}) {
  return (
    <div style={{
      border: '1px solid #c8dfe9',
      borderRadius: '8px',
      padding: '0.85rem 1rem',
      background: '#fff',
      boxShadow: '0 1px 4px rgba(0,0,0,.06)',
    }}>
      <div style={{
        fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
        letterSpacing: '0.06em', color: 'var(--cdl-muted)', marginBottom: '0.3rem',
      }}>
        {label}
      </div>
      <div style={{ fontSize: '1.8rem', fontWeight: 800, color, lineHeight: 1, marginBottom: '0.25rem', fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </div>
      <div style={{ fontSize: '0.72rem', color: subColor ?? 'var(--cdl-muted)' }}>
        {sub}
      </div>
    </div>
  )
}
