export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { approveRecommendation, rejectRecommendation } from './actions'

// ── Constants ─────────────────────────────────────────────────────────────────
const CURRENCY_SYMBOL: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CAD: 'CA$', MXN: 'MX$',
}
const COUNTRY_TLD: Record<string, string> = {
  ES: 'es', US: 'com', MX: 'com.mx', CA: 'ca', UK: 'co.uk', GB: 'co.uk',
}
const ASIN_RE = /^([0-9]{9}[0-9xX]|b0[a-z0-9]{8})$/i

// ── Interfaces ────────────────────────────────────────────────────────────────
interface Placement {
  campaign_id: string
  ad_group_id: string
  spend: number
  clicks: number
  orders: number
  sales: number
}

interface ChosenTarget {
  target_id: string
  ad_group_id: string
  campaign_id: string
  current_bid: number | null
}

interface ExistingTarget {
  target_id?: string
  ad_group_id: string
  campaign_id: string
  bid: number | null
}

interface Evidence {
  spend?: number
  clicks?: number
  orders?: number
  sales?: number
  acos?: number | null
  window_start?: string
  window_end?: string
  params_used?: { target_acos?: number }
  campaign_ids?: string[]
  placements?: Placement[]
  primary_placement?: Placement
  existing_targets?: ExistingTarget[]
  chosen_target?: ChosenTarget
  proposed_bid?: number
  observed_cpc?: number
  approved_bid?: number
  pushed_keyword_ids?: string[]
  pushed_target_ids?: string[]
}

interface RecRow {
  id: number
  rec_type: string
  target_text: string
  proposal: string
  status: string
  created_at: string
  country_code: string
  profile_id: string
  currency_code: string
  evidence: Evidence
}

interface CampaignInfo {
  profile_id: string
  campaign_id: string
  name: string
  state: string
}

interface AdGroupInfo {
  profile_id: string
  ad_group_id: string
  name: string
}

interface DailyAgg {
  profile_id: string
  campaign_id: string
  spend_30d: string
  sales_30d: string
  acos: string | null
}

interface DestTargetRow {
  target_id: string
  ad_group_id: string
  profile_id: string
  state: string
  expression_type: string | null
  resolved_asin: string | null
  bid: string | null
}

interface TargetAcosRow {
  profile_id: string
  ad_group_id: string
  search_term_lower: string
  spend: string
  orders: string
  sales: string
}

interface BidAdjStateRow {
  target_id: string
  state: string
}

// ── Pure helpers ──────────────────────────────────────────────────────────────
function amazonLink(target: string, country: string): string | null {
  if (!ASIN_RE.test(target)) return null
  const tld = COUNTRY_TLD[country.toUpperCase()] ?? 'com'
  return `https://www.amazon.${tld}/dp/${target.toUpperCase()}`
}

function recTypeBadge(rt: string): string {
  if (rt === 'PROMOTE_TERM' || rt === 'PROMOTE_ASIN') return 'badge badge-ok'
  if (rt === 'BID_ADJUST')  return 'badge badge-blue'
  if (rt === 'NEGATE_TERM') return 'badge badge-warn'
  return 'badge badge-muted'
}

function stateBadgeCls(state: string): string {
  const s = state.toUpperCase()
  if (s === 'ENABLED')  return 'badge badge-ok'
  if (s === 'ARCHIVED') return 'badge badge-dim'
  return 'badge badge-muted'
}

function statusBadgeCls(status: string): string {
  if (status === 'APPROVED' || status === 'PUSHED') return 'badge badge-ok'
  if (status === 'REJECTED') return 'badge badge-warn'
  return 'badge badge-muted'
}

function fmtN(v: number | undefined | null): string {
  if (v == null) return '—'
  return v.toFixed(2)
}

const BID_INPUT_TYPES = new Set(['BID_ADJUST', 'PROMOTE_ASIN', 'PROMOTE_TERM'])

// ── Page ──────────────────────────────────────────────────────────────────────
export default async function RecommendationsPage() {
  const sql = neon(process.env.DATABASE_URL!)

  // ── Main queries ───────────────────────────────────────────────────────────
  const [rows, allCampaigns, dailyAgg, allAdGroups] = (await Promise.all([
    sql`
      SELECT
        r.id,
        r.rec_type,
        r.target_text,
        r.proposal,
        r.status,
        r.created_at::text,
        p.country_code,
        p.profile_id::text,
        p.currency_code,
        r.evidence
      FROM recommendations r
      JOIN amazon_profiles p USING (profile_id)
      ORDER BY
        CASE r.status WHEN 'DRAFT' THEN 0 ELSE 1 END,
        r.rec_type,
        r.id
    `,
    sql`SELECT profile_id::text, campaign_id, name, state FROM amazon_campaigns`,
    sql`
      SELECT
        profile_id::text,
        campaign_id,
        sum(cost)::text       AS spend_30d,
        sum(sales_14d)::text  AS sales_30d,
        (sum(cost) / nullif(sum(sales_14d), 0))::text AS acos
      FROM amazon_campaign_daily
      WHERE date >= CURRENT_DATE - INTERVAL '30 days'
      GROUP BY profile_id, campaign_id
    `,
    sql`SELECT profile_id::text, ad_group_id, name FROM amazon_ad_groups`,
  ])) as unknown as [RecRow[], CampaignInfo[], DailyAgg[], AdGroupInfo[]]

  // ── Primary lookup maps ────────────────────────────────────────────────────
  const campMap = new Map<string, { name: string; state: string }>()
  for (const c of allCampaigns) {
    campMap.set(`${c.profile_id}:${c.campaign_id}`, { name: c.name, state: c.state })
  }

  const adGroupMap = new Map<string, string>()
  for (const ag of allAdGroups) {
    adGroupMap.set(`${ag.profile_id}:${ag.ad_group_id}`, ag.name)
  }

  // ── Collect IDs for supplemental queries ───────────────────────────────────
  const promoteAsinRecs = rows.filter(r => r.rec_type === 'PROMOTE_ASIN')
  const bidAdjRecs      = rows.filter(r => r.rec_type === 'BID_ADJUST')

  const destAgProfileIds = [...new Set(promoteAsinRecs.map(r => r.profile_id))]
  const destAgIds        = [
    ...new Set(
      promoteAsinRecs
        .map(r => r.evidence.primary_placement?.ad_group_id)
        .filter((x): x is string => x != null),
    ),
  ]
  const bidAdjTargetIds  = [
    ...new Set(
      bidAdjRecs
        .map(r => r.evidence.chosen_target?.target_id)
        .filter((x): x is string => x != null),
    ),
  ]
  const bidAdjProfileIds = [...new Set(bidAdjRecs.map(r => r.profile_id))]

  // ── Supplemental queries ───────────────────────────────────────────────────
  let destTargetRows:   DestTargetRow[]   = []
  let targetAcosRows:   TargetAcosRow[]   = []
  let bidAdjStateRows:  BidAdjStateRow[]  = []

  if (destAgIds.length > 0) {
    ;[destTargetRows, targetAcosRows] = (await Promise.all([
      // All targets currently in PROMOTE_ASIN destination ad groups
      sql`
        SELECT
          target_id,
          ad_group_id,
          profile_id::text AS profile_id,
          state,
          expression_type,
          resolved_asin,
          bid::text
        FROM amazon_targets
        WHERE profile_id::text = ANY(${destAgProfileIds})
          AND ad_group_id      = ANY(${destAgIds})
        ORDER BY ad_group_id, resolved_asin NULLS LAST
      `,
      // Per-target ACOS in those ad groups (60d search-term data)
      sql`
        SELECT
          profile_id::text,
          ad_group_id,
          lower(search_term) AS search_term_lower,
          sum(cost)::text          AS spend,
          sum(purchases_14d)::text AS orders,
          sum(sales_14d)::text     AS sales
        FROM amazon_search_term_daily
        WHERE profile_id::text = ANY(${destAgProfileIds})
          AND ad_group_id      = ANY(${destAgIds})
          AND date >= CURRENT_DATE - INTERVAL '60 days'
        GROUP BY profile_id, ad_group_id, lower(search_term)
      `,
    ])) as unknown as [DestTargetRow[], TargetAcosRow[]]
  }

  if (bidAdjTargetIds.length > 0) {
    bidAdjStateRows = (await sql`
      SELECT target_id, state
      FROM amazon_targets
      WHERE target_id    = ANY(${bidAdjTargetIds})
        AND profile_id::text = ANY(${bidAdjProfileIds})
    `) as unknown as BidAdjStateRow[]
  }

  // ── Supplemental maps ──────────────────────────────────────────────────────
  const destTargetsMap = new Map<string, DestTargetRow[]>()
  for (const t of destTargetRows) {
    const key = `${t.profile_id}:${t.ad_group_id}`
    if (!destTargetsMap.has(key)) destTargetsMap.set(key, [])
    destTargetsMap.get(key)!.push(t)
  }

  const targetAcosMap = new Map<string, { spend: string; orders: string; sales: string }>()
  for (const row of targetAcosRows) {
    targetAcosMap.set(
      `${row.profile_id}:${row.ad_group_id}:${row.search_term_lower}`,
      { spend: row.spend, orders: row.orders, sales: row.sales },
    )
  }

  const bidAdjStateMap = new Map<string, string>()
  for (const row of bidAdjStateRows) {
    bidAdjStateMap.set(row.target_id, row.state)
  }

  // ── Group DRAFTs ───────────────────────────────────────────────────────────
  const draftRows    = rows.filter(r => r.status === 'DRAFT')
  const nonDraftRows = rows.filter(r => r.status !== 'DRAFT')

  const draftByType = new Map<string, RecRow[]>()
  for (const row of draftRows) {
    if (!draftByType.has(row.rec_type)) draftByType.set(row.rec_type, [])
    draftByType.get(row.rec_type)!.push(row)
  }
  for (const group of draftByType.values()) {
    group.sort((a, b) => (b.evidence.spend ?? 0) - (a.evidence.spend ?? 0))
  }

  const nonDraftCounts = new Map<string, number>()
  for (const row of nonDraftRows) {
    nonDraftCounts.set(row.status, (nonDraftCounts.get(row.status) ?? 0) + 1)
  }

  // ── Sub-components ─────────────────────────────────────────────────────────

  function EvStats({ ev, currency }: { ev: Evidence; currency: string }) {
    const acosRatio = ev.acos ?? (ev.spend && ev.sales ? ev.spend / ev.sales : null)
    const acosPct   = acosRatio != null ? acosRatio * 100 : null
    const tgtPct    = (ev.params_used?.target_acos ?? 0.30) * 100
    return (
      <div className="ev-stats">
        <div>
          <div className="ev-stat-label">Spend</div>
          <div>{fmtN(ev.spend)} {currency}</div>
        </div>
        <div>
          <div className="ev-stat-label">Clicks</div>
          <div>{ev.clicks ?? '—'}</div>
        </div>
        <div>
          <div className="ev-stat-label">Orders</div>
          <div>{ev.orders ?? '—'}</div>
        </div>
        <div>
          <div className="ev-stat-label">Sales</div>
          <div>{fmtN(ev.sales)} {currency}</div>
        </div>
        <div>
          <div className="ev-stat-label">ACOS</div>
          <div>
            {acosPct != null
              ? <span className={acosPct <= tgtPct ? 'badge badge-ok' : 'badge badge-warn'}>
                  {acosPct.toFixed(1)}%
                </span>
              : '—'}
            {' '}
            <span style={{ color: 'var(--cdl-muted)', fontSize: '0.8em' }}>
              tgt {tgtPct.toFixed(0)}%
            </span>
          </div>
        </div>
        <div>
          <div className="ev-stat-label">Window</div>
          <div style={{ fontSize: '0.85em', whiteSpace: 'nowrap' }}>
            {ev.window_start ?? '—'} → {ev.window_end ?? '—'}
          </div>
        </div>
      </div>
    )
  }

  // ── 1. Full proposal (untruncated, first inside expanded card) ─────────────
  function FullProposal({ proposal }: { proposal: string }) {
    return (
      <p style={{
        margin: '0 0 0.75rem 0',
        fontSize: '0.9rem',
        color: 'var(--cdl-ink)',
        lineHeight: 1.55,
        fontStyle: 'italic',
      }}>
        {proposal}
      </p>
    )
  }

  // BID_ADJUST: proposal IS the why — WhyLine returns null for it
  function WhyLine({ recType, ev, term, currency }: {
    recType: string; ev: Evidence; term: string; currency: string
  }) {
    if (recType === 'BID_ADJUST') return null
    const orders    = ev.orders ?? 0
    const spend     = fmtN(ev.spend)
    const clicks    = ev.clicks ?? 0
    const acosRatio = ev.acos ?? (ev.spend && ev.sales ? ev.spend / ev.sales : null)
    const acosPct   = acosRatio != null ? (acosRatio * 100).toFixed(1) : '—'
    const tgtPct    = ((ev.params_used?.target_acos ?? 0.30) * 100).toFixed(0)
    let sentence: string
    if (recType === 'PROMOTE_ASIN') {
      sentence = `Your ads shown on this book's product page produced ${orders} orders at ${acosPct}% ACOS (${spend} ${currency} spend) — below your ${tgtPct}% target. Proposal: add it as an explicit product target.`
    } else if (recType === 'PROMOTE_TERM') {
      sentence = `Shoppers searching '${term}' bought ${orders} times at ${acosPct}% ACOS — below your ${tgtPct}% target. Proposal: add it as an exact-match keyword.`
    } else if (recType === 'NEGATE_TERM') {
      sentence = `This term spent ${spend} ${currency} over ${clicks} clicks with zero orders. It was negated to stop the spend.`
    } else {
      return null
    }
    return (
      <p style={{ margin: '0 0 0.6rem 0', fontSize: '0.88rem', color: 'var(--cdl-fg)', lineHeight: 1.5 }}>
        {sentence}
      </p>
    )
  }

  // ── 3a. BID_ADJUST "Chosen target" destination panel ──────────────────────
  function BidAdjDestPanel({ ev, profileId, currency }: {
    ev: Evidence; profileId: string; currency: string
  }) {
    const ct = ev.chosen_target
    if (!ct) return null
    const agName  = adGroupMap.get(`${profileId}:${ct.ad_group_id}`) ?? ct.ad_group_id
    const state   = bidAdjStateMap.get(ct.target_id) ?? 'ENABLED'
    const sym     = CURRENCY_SYMBOL[currency] ?? `${currency} `
    const curFmt  = ct.current_bid  != null ? `${sym}${ct.current_bid.toFixed(2)}`  : '—'
    const propFmt = ev.proposed_bid != null ? `${sym}${ev.proposed_bid.toFixed(2)}` : '—'
    return (
      <div style={{
        border: '1px solid #c8dfe9', borderRadius: '6px',
        padding: '0.65rem 0.9rem', marginBottom: '0.85rem', background: '#f7fbfd',
      }}>
        <div style={{
          fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase' as const,
          letterSpacing: '0.05em', color: 'var(--cdl-muted)', marginBottom: '0.35rem',
        }}>
          Chosen Target
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap' as const, gap: '1rem', alignItems: 'baseline', fontSize: '0.88rem' }}>
          <div style={{ fontWeight: 600 }}>{agName}</div>
          <div>
            bid:{' '}
            <span style={{ color: 'var(--cdl-ink)' }}>{curFmt}</span>
            {' → '}
            <span style={{ color: 'var(--cdl-ok)', fontWeight: 700 }}>{propFmt}</span>
          </div>
          <span className={stateBadgeCls(state)}>{state}</span>
        </div>
      </div>
    )
  }

  // ── 3b. PROMOTE_ASIN "Destination ad group" panel ─────────────────────────
  function PromoteAsinDestPanel({ ev, profileId, currency }: {
    ev: Evidence; profileId: string; currency: string
  }) {
    const pp = ev.primary_placement
    if (!pp) return null
    const agName      = adGroupMap.get(`${profileId}:${pp.ad_group_id}`) ?? pp.ad_group_id
    const allTgts     = destTargetsMap.get(`${profileId}:${pp.ad_group_id}`) ?? []
    const sym         = CURRENCY_SYMBOL[currency] ?? `${currency} `
    const displayTgts = allTgts.slice(0, 10)
    const extraCount  = allTgts.length - displayTgts.length
    return (
      <div style={{
        border: '1px solid #c8dfe9', borderRadius: '6px',
        padding: '0.65rem 0.9rem', marginBottom: '0.85rem', background: '#f7fbfd',
      }}>
        <div style={{
          fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase' as const,
          letterSpacing: '0.05em', color: 'var(--cdl-muted)', marginBottom: '0.35rem',
        }}>
          Destination Ad Group
        </div>
        <div style={{ fontWeight: 600, fontSize: '0.88rem', marginBottom: allTgts.length > 0 ? '0.55rem' : 0 }}>
          {agName}
        </div>
        {allTgts.length === 0 ? (
          <p style={{ color: 'var(--cdl-muted)', fontSize: '0.82rem', margin: 0 }}>
            No existing targets in this group yet.
          </p>
        ) : (
          <div className="table-card" style={{ marginBottom: 0 }}>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>State</th>
                    <th>Bid</th>
                    <th>ACOS 60d</th>
                  </tr>
                </thead>
                <tbody>
                  {displayTgts.map(t => {
                    const acosKey  = `${profileId}:${t.ad_group_id}:${(t.resolved_asin ?? '').toLowerCase()}`
                    const acosData = t.resolved_asin ? targetAcosMap.get(acosKey) : undefined
                    const acosStr  = (() => {
                      if (!acosData) return '—'
                      const sales = parseFloat(acosData.sales)
                      if (!sales) return '—'
                      return (parseFloat(acosData.spend) / sales * 100).toFixed(1) + '%'
                    })()
                    return (
                      <tr key={t.target_id}>
                        <td style={{ fontFamily: 'monospace', fontSize: '0.85em' }}>
                          {t.resolved_asin?.toUpperCase() ?? t.expression_type ?? '—'}
                        </td>
                        <td><span className={stateBadgeCls(t.state)}>{t.state}</span></td>
                        <td className="num">
                          {t.bid != null ? `${sym}${parseFloat(t.bid).toFixed(2)}` : '—'}
                        </td>
                        <td className="num">{acosStr}</td>
                      </tr>
                    )
                  })}
                  {extraCount > 0 && (
                    <tr>
                      <td colSpan={4} style={{
                        color: 'var(--cdl-muted)', fontStyle: 'italic',
                        textAlign: 'center' as const, padding: '6px',
                      }}>
                        +{extraCount} more
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    )
  }

  function ExistingTargetsLine({ ev, profileId, currency }: {
    ev: Evidence; profileId: string; currency: string
  }) {
    const targets = ev.existing_targets
    if (!targets || targets.length === 0) return null
    const sym  = CURRENCY_SYMBOL[currency] ?? `${currency} `
    const seen = new Set<string>()
    const unique = targets.filter(t => {
      if (seen.has(t.ad_group_id)) return false
      seen.add(t.ad_group_id)
      return true
    })
    const parts = unique.map(t => {
      const name   = adGroupMap.get(`${profileId}:${t.ad_group_id}`) ?? t.ad_group_id
      const bidStr = t.bid != null ? `${sym}${t.bid.toFixed(2)}` : '—'
      return `${name} (bid ${bidStr})`
    })
    return (
      <p style={{ margin: '0.4rem 0 0.6rem 0', fontSize: '0.85rem', color: 'var(--cdl-muted)', lineHeight: 1.5 }}>
        Already explicitly targeted in {unique.length} ad group{unique.length !== 1 ? 's' : ''}:{' '}
        {parts.join(', ')}.
      </p>
    )
  }

  function AppliesTo({ ev, profileId, currency }: {
    ev: Evidence; profileId: string; currency: string
  }) {
    const placements = (ev.placements ?? []).slice().sort((a, b) => b.spend - a.spend)
    if (placements.length === 0) return null
    const primaryId = ev.primary_placement?.ad_group_id
    return (
      <div style={{ marginTop: '0.85rem' }}>
        <div style={{
          fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase' as const,
          letterSpacing: '0.05em', color: 'var(--cdl-muted)', marginBottom: '0.4rem',
        }}>
          Where this happened (evidence)
        </div>
        <div className="table-card" style={{ marginBottom: 0 }}>
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Ad Group</th>
                  <th>Campaign</th>
                  <th>State</th>
                  <th>Spend</th>
                  <th>Clicks</th>
                  <th>Orders</th>
                  <th>Sales</th>
                </tr>
              </thead>
              <tbody>
                {placements.map(p => {
                  const camp      = campMap.get(`${profileId}:${p.campaign_id}`)
                  const agName    = adGroupMap.get(`${profileId}:${p.ad_group_id}`)
                  const isPrimary = p.ad_group_id === primaryId
                  const primaryPill = isPrimary ? (
                    <span style={{
                      marginLeft: '0.4em', fontSize: '0.72rem', fontWeight: 700,
                      background: 'var(--cdl-blue)', color: '#fff',
                      borderRadius: '0.3em', padding: '0.1em 0.4em', whiteSpace: 'nowrap',
                    }}>
                      → will be added here if approved
                    </span>
                  ) : null
                  return (
                    <tr key={`${p.campaign_id}:${p.ad_group_id}`}>
                      <td>
                        {agName
                          ? <span>{agName}{primaryPill}</span>
                          : <span style={{ color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
                              {p.ad_group_id} (not in sync){primaryPill}
                            </span>}
                      </td>
                      <td style={{ maxWidth: '16em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {camp
                          ? <a
                              href={`/campaigns/${profileId}/${encodeURIComponent(p.campaign_id)}`}
                              style={{ color: 'var(--cdl-blue)' }}
                              title={camp.name}
                            >
                              {camp.name}
                            </a>
                          : <span style={{ color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
                              {p.campaign_id} (not in sync)
                            </span>}
                      </td>
                      <td>
                        {camp ? <span className={stateBadgeCls(camp.state)}>{camp.state}</span> : '—'}
                      </td>
                      <td className="num">{p.spend.toFixed(2)} {currency}</td>
                      <td className="num">{p.clicks}</td>
                      <td className="num">{p.orders}</td>
                      <td className="num">{p.sales.toFixed(2)} {currency}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    )
  }

  function PushReceipts({ ev }: { ev: Evidence }) {
    const kw  = ev.pushed_keyword_ids ?? []
    const tgt = ev.pushed_target_ids  ?? []
    if (kw.length === 0 && tgt.length === 0) return null
    return (
      <div style={{ marginTop: '0.75rem', fontSize: '0.8rem', color: 'var(--cdl-muted)', lineHeight: 1.6 }}>
        {kw.length > 0 && (
          <div><span style={{ fontWeight: 700 }}>Keyword IDs pushed: </span>{kw.join(', ')}</div>
        )}
        {tgt.length > 0 && (
          <div><span style={{ fontWeight: 700 }}>Target IDs pushed: </span>{tgt.join(', ')}</div>
        )}
      </div>
    )
  }

  // ── Card body (shared between draft and ruled) ─────────────────────────────
  function CardBody({ r }: { r: RecRow }) {
    return (
      <div className="rec-card-body">
        {/* 1. Full proposal — always first, untruncated */}
        <FullProposal proposal={r.proposal} />
        {/* 2. Why-line (BID_ADJUST returns null — proposal IS the why) */}
        <WhyLine recType={r.rec_type} ev={r.evidence} term={r.target_text} currency={r.currency_code} />
        {/* 3. Destination panels */}
        {r.rec_type === 'BID_ADJUST' && (
          <BidAdjDestPanel ev={r.evidence} profileId={r.profile_id} currency={r.currency_code} />
        )}
        {r.rec_type === 'PROMOTE_ASIN' && (
          <PromoteAsinDestPanel ev={r.evidence} profileId={r.profile_id} currency={r.currency_code} />
        )}
        {/* Existing targets note for PROMOTE_ASIN */}
        {r.rec_type === 'PROMOTE_ASIN' && (
          <ExistingTargetsLine ev={r.evidence} profileId={r.profile_id} currency={r.currency_code} />
        )}
        {/* Stats + evidence table */}
        <EvStats ev={r.evidence} currency={r.currency_code} />
        <AppliesTo ev={r.evidence} profileId={r.profile_id} currency={r.currency_code} />
        {r.rec_type === 'NEGATE_TERM' && <PushReceipts ev={r.evidence} />}
      </div>
    )
  }

  // ── DRAFT card ─────────────────────────────────────────────────────────────
  function DraftCard({ r }: { r: RecRow }) {
    const url         = amazonLink(r.target_text, r.country_code)
    const hasBidInput = BID_INPUT_TYPES.has(r.rec_type)
    const proposedBid = r.evidence.proposed_bid
    return (
      <details className="rec-card">
        <summary>
          <span className={recTypeBadge(r.rec_type)}>{r.rec_type}</span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>
            {url
              ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--cdl-blue)' }}>
                  {r.target_text}
                </a>
              : r.target_text}
          </span>
          <span style={{
            color: 'var(--cdl-muted)', flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {r.proposal}
          </span>
          <span style={{ color: 'var(--cdl-muted)', fontSize: '0.82rem', flexShrink: 0 }}>
            {r.country_code}
          </span>
          {/* 2. Approve form with optional bid input */}
          <form
            action={approveRecommendation}
            style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}
          >
            <input type="hidden" name="id" value={r.id} />
            {hasBidInput && (
              <input
                type="number"
                name="approved_bid"
                step="0.01"
                min="0.02"
                defaultValue={proposedBid}
                placeholder="bid"
                style={{
                  width: '5.2rem',
                  padding: '3px 6px',
                  fontSize: '0.82rem',
                  border: '1px solid #c8dfe9',
                  borderRadius: '4px',
                  fontFamily: 'inherit',
                  textAlign: 'right' as const,
                }}
              />
            )}
            <button type="submit" className="btn-approve">Approve</button>
          </form>
          <form action={rejectRecommendation} style={{ display: 'inline', flexShrink: 0 }}>
            <input type="hidden" name="id" value={r.id} />
            <button type="submit" className="btn-reject">Reject</button>
          </form>
        </summary>
        <CardBody r={r} />
      </details>
    )
  }

  // ── Ruled card (no action buttons) ────────────────────────────────────────
  function RuledCard({ r }: { r: RecRow }) {
    const url = amazonLink(r.target_text, r.country_code)
    return (
      <details className="rec-card">
        <summary>
          <span className={recTypeBadge(r.rec_type)}>{r.rec_type}</span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>
            {url
              ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--cdl-blue)' }}>
                  {r.target_text}
                </a>
              : r.target_text}
          </span>
          <span style={{
            color: 'var(--cdl-muted)', flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {r.proposal}
          </span>
          <span style={{ color: 'var(--cdl-muted)', fontSize: '0.82rem', flexShrink: 0 }}>
            {r.country_code}
          </span>
          <span className={statusBadgeCls(r.status)}>{r.status}</span>
        </summary>
        <CardBody r={r} />
      </details>
    )
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div>
      <h1>Recommendations</h1>

      {rows.length === 0 ? (
        <p style={{ color: 'var(--cdl-muted)' }}>No recommendations yet.</p>
      ) : (
        <>
          {/* ── DRAFT groups ── */}
          {draftRows.length === 0 ? (
            <p style={{ color: 'var(--cdl-muted)', marginBottom: '1.5rem' }}>
              No DRAFT recommendations.
            </p>
          ) : (
            Array.from(draftByType.entries()).map(([recType, typeRows]) => (
              <div key={recType} style={{ marginBottom: '2.5rem' }}>
                <h2>
                  {recType}{' '}
                  <span style={{
                    color: 'var(--cdl-muted)', fontWeight: 400,
                    fontFamily: 'inherit', fontSize: '0.9rem',
                  }}>
                    — {typeRows.length} draft{typeRows.length !== 1 ? 's' : ''}
                  </span>
                </h2>
                {typeRows.map(r => <DraftCard key={r.id} r={r} />)}
              </div>
            ))
          )}

          {/* ── Ruled section — collapsed ── */}
          {nonDraftRows.length > 0 && (
            <details style={{ marginTop: '0.5rem' }}>
              <summary style={{
                cursor: 'pointer',
                fontFamily: 'var(--font-fraunces, Fraunces, Georgia, serif)',
                fontSize: '1.1rem', fontWeight: 700, color: 'var(--cdl-muted)',
                padding: '0.5rem 0',
              }}>
                Ruled ({nonDraftRows.length}){' '}
                <span style={{ fontWeight: 400, fontSize: '0.82rem' }}>
                  — {(['APPROVED', 'REJECTED', 'PUSHED'] as const)
                    .map(s => `${s} ${nonDraftCounts.get(s) ?? 0}`)
                    .join(' · ')}
                </span>
              </summary>
              <div style={{ marginTop: '0.75rem' }}>
                {nonDraftRows.map(r => <RuledCard key={r.id} r={r} />)}
              </div>
            </details>
          )}
        </>
      )}
    </div>
  )
}
