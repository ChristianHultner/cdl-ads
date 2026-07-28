// Server-compatible: no 'use client'. Safe to render from any RSC or page.

import { approveRecommendation, rejectRecommendation } from '@/app/recommendations/actions'
import { CreativeTargetApproveForm } from '@/app/recommendations/CreativeTargetApproveForm'

// ── Constants ──────────────────────────────────────────────────────────────
const CURRENCY_SYMBOL: Record<string, string> = {
  EUR: '€', USD: '$', GBP: '£', CAD: 'CA$', MXN: 'MX$',
}
const COUNTRY_TLD: Record<string, string> = {
  ES: 'es', US: 'com', MX: 'com.mx', CA: 'ca', UK: 'co.uk', GB: 'co.uk',
}
const ASIN_RE = /^([0-9]{9}[0-9xX]|b0[a-z0-9]{8})$/i
const BID_INPUT_TYPES = new Set(['BID_ADJUST', 'PROMOTE_ASIN', 'PROMOTE_TERM'])

// ── Interfaces ─────────────────────────────────────────────────────────────
export interface Placement {
  campaign_id: string
  ad_group_id: string
  spend: number
  clicks: number
  orders: number
  sales: number
}

export interface ChosenTarget {
  target_id: string
  ad_group_id: string
  campaign_id: string
  current_bid: number | null
}

export interface ExistingTarget {
  target_id?: string
  ad_group_id: string
  campaign_id: string
  bid: number | null
}

export interface ResolvedDestination {
  ad_group_id: string
  ad_group_name: string
  campaign_id: string
  tier: 'exact-kw' | 'kw-holding' | null
}

export interface Evidence {
  spend?: number
  clicks?: number
  orders?: number
  sales?: number
  acos?: number | null
  window_start?: string
  window_end?: string
  params_used?: { target_acos?: number }
  campaign_ids?: string[]
  /** Direct campaign attribution stored in evidence JSON */
  campaign_id?: string
  /** Direct ad-group attribution stored in evidence JSON */
  ad_group_id?: string
  /** Fallback: destination ad-group id, resolved to campaign via amazon_ad_groups */
  destination_ad_group_id?: string
  placements?: Placement[]
  primary_placement?: Placement
  existing_targets?: ExistingTarget[]
  chosen_target?: ChosenTarget
  chosen_target_share?: { spend: number; clicks: number; orders: number; sales: number }
  proposed_bid?: number
  observed_cpc?: number
  approved_bid?: number
  pushed_keyword_ids?: string[]
  pushed_target_ids?: string[]
  resolved_destination?: ResolvedDestination | null
}

export interface RecRow {
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

export interface DestTargetRow {
  target_id: string
  ad_group_id: string
  profile_id: string
  state: string
  expression_type: string | null
  resolved_asin: string | null
  bid: string | null
}

/** Lookup maps resolved by the host page and passed into each card. */
export interface RecCardContext {
  adGroupMap: Map<string, string>
  campMap: Map<string, { name: string; state: string }>
  bidAdjStateMap: Map<string, string>
  destTargetsMap: Map<string, DestTargetRow[]>
}

// ── Pure helpers ───────────────────────────────────────────────────────────
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

// ── RecCard ────────────────────────────────────────────────────────────────
/**
 * Renders a single recommendation card.
 * DRAFT → Approve / Reject actions (server actions + CreativeTargetApproveForm).
 * Non-DRAFT → ruled view (status badge only).
 * Server-compatible: no client-side state except where delegated to
 * CreativeTargetApproveForm.
 */
export function RecCard({ rec: r, ctx }: { rec: RecRow; ctx: RecCardContext }) {
  const { adGroupMap, campMap, bidAdjStateMap, destTargetsMap } = ctx

  // ── Sub-components (closures over ctx maps) ──────────────────────────────

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

  // BID_ADJUST: proposal IS the why — returns null for it
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

  // BID_ADJUST "Chosen target" destination panel
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
          <div style={{ fontWeight: 600 }}>
            <a
              href={`/campaigns/${profileId}/${encodeURIComponent(ct.campaign_id)}#ag-${ct.ad_group_id}`}
              style={{ color: 'var(--cdl-blue)' }}
            >{agName}</a>
          </div>
          <div>
            bid:{' '}
            <span style={{ color: 'var(--cdl-ink)' }}>{curFmt}</span>
            {' → '}
            <span style={{ color: 'var(--cdl-ok)', fontWeight: 700 }}>{propFmt}</span>
          </div>
          <span className={stateBadgeCls(state)}>{state}</span>
        </div>
        {ev.chosen_target_share && (
          <div style={{ fontSize: '0.82rem', color: 'var(--cdl-muted)', marginTop: '0.4rem' }}>
            This target&apos;s own share of the evidence:{' '}
            {sym}{ev.chosen_target_share.spend.toFixed(2)} spend,{' '}
            {ev.chosen_target_share.orders} orders
          </div>
        )}
      </div>
    )
  }

  // PROMOTE_ASIN "Destination ad group" panel
  function PromoteAsinDestPanel({ ev, profileId, currency }: {
    ev: Evidence; profileId: string; currency: string
  }) {
    const pp = ev.primary_placement
    if (!pp) return null
    const agName  = adGroupMap.get(`${profileId}:${pp.ad_group_id}`) ?? pp.ad_group_id
    const allTgts = destTargetsMap.get(`${profileId}:${pp.ad_group_id}`) ?? []
    const sym     = CURRENCY_SYMBOL[currency] ?? `${currency} `
    const bids    = allTgts.map(t => (t.bid != null ? parseFloat(t.bid) : null)).filter((b): b is number => b != null)
    const bidMin  = bids.length > 0 ? `${sym}${Math.min(...bids).toFixed(2)}` : '—'
    const bidMax  = bids.length > 0 ? `${sym}${Math.max(...bids).toFixed(2)}` : '—'
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
        <div style={{ fontSize: '0.85rem', color: 'var(--cdl-ink)', marginBottom: '0.4rem' }}>
          {allTgts.length} existing target{allTgts.length !== 1 ? 's' : ''}{' '}
          · bids {bidMin}–{bidMax}{' '}
          ·{' '}
          <a
            href={`/campaigns/${profileId}/${encodeURIComponent(pp.campaign_id)}#ag-${pp.ad_group_id}`}
            style={{ color: 'var(--cdl-blue)' }}
          >{agName}</a>
        </div>
        <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
          This ASIN&apos;s traffic currently reaches this group via auto/expanded matching — an explicit target takes bid control at your chosen price.
        </p>
      </div>
    )
  }

  // PROMOTE_TERM "Will be added as EXACT to" destination panel
  // Older drafts without evidence.resolved_destination fall back gracefully.
  function PromoteTermDestPanel({ ev, profileId }: {
    ev: Evidence; profileId: string
  }) {
    const rd = ev.resolved_destination
    if (rd === undefined) return null
    return (
      <div style={{
        border: '1px solid #c8dfe9', borderRadius: '6px',
        padding: '0.65rem 0.9rem', marginBottom: '0.85rem', background: '#f7fbfd',
      }}>
        <div style={{
          fontSize: '0.72rem', fontWeight: 700, textTransform: 'uppercase' as const,
          letterSpacing: '0.05em', color: 'var(--cdl-muted)', marginBottom: '0.35rem',
        }}>
          Destination
        </div>
        {rd === null ? (
          <p style={{ margin: 0, fontSize: '0.88rem', color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
            No eligible destination — will await a structure room.
          </p>
        ) : (
          <>
            <div style={{ fontSize: '0.88rem', color: 'var(--cdl-ink)', marginBottom: '0.25rem' }}>
              Will be added as EXACT to:{' '}
              <a
                href={`/campaigns/${profileId}/${encodeURIComponent(rd.campaign_id)}#ag-${rd.ad_group_id}`}
                style={{ color: 'var(--cdl-blue)', fontWeight: 600 }}
              >{adGroupMap.get(`${profileId}:${rd.ad_group_id}`) ?? rd.ad_group_name}</a>
            </div>
            <p style={{ margin: 0, fontSize: '0.82rem', color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
              (chosen from this term&apos;s placements — holds exact keywords, highest spend)
            </p>
          </>
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
                  <th className="num">Spend</th>
                  <th className="num">Clicks</th>
                  <th className="num">Orders</th>
                  <th className="num">Sales</th>
                </tr>
              </thead>
              <tbody>
                {placements.map(p => {
                  const camp   = campMap.get(`${profileId}:${p.campaign_id}`)
                  const agName = adGroupMap.get(`${profileId}:${p.ad_group_id}`)
                  return (
                    <tr key={`${p.campaign_id}:${p.ad_group_id}`}>
                      <td>
                        {agName
                          ? <a
                              href={`/campaigns/${profileId}/${encodeURIComponent(p.campaign_id)}#ag-${p.ad_group_id}`}
                              style={{ color: 'var(--cdl-blue)' }}
                            >{agName}</a>
                          : <span style={{ color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
                              {p.ad_group_id} (not in sync)
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

  function CardBody({ r: rec }: { r: RecRow }) {
    return (
      <div className="rec-card-body">
        {/* 1. Full proposal — always first, untruncated */}
        <FullProposal proposal={rec.proposal} />
        {/* 2. Why-line (BID_ADJUST returns null — proposal IS the why) */}
        <WhyLine recType={rec.rec_type} ev={rec.evidence} term={rec.target_text} currency={rec.currency_code} />
        {/* 3. Destination panels */}
        {rec.rec_type === 'BID_ADJUST' && (
          <BidAdjDestPanel ev={rec.evidence} profileId={rec.profile_id} currency={rec.currency_code} />
        )}
        {rec.rec_type === 'PROMOTE_ASIN' && (
          <PromoteAsinDestPanel ev={rec.evidence} profileId={rec.profile_id} currency={rec.currency_code} />
        )}
        {rec.rec_type === 'PROMOTE_TERM' && (
          <PromoteTermDestPanel ev={rec.evidence} profileId={rec.profile_id} />
        )}
        {/* Existing targets note for PROMOTE_ASIN */}
        {rec.rec_type === 'PROMOTE_ASIN' && (
          <ExistingTargetsLine ev={rec.evidence} profileId={rec.profile_id} currency={rec.currency_code} />
        )}
        {/* Stats + evidence table */}
        <EvStats ev={rec.evidence} currency={rec.currency_code} />
        <AppliesTo ev={rec.evidence} profileId={rec.profile_id} currency={rec.currency_code} />
        {rec.rec_type === 'NEGATE_TERM' && <PushReceipts ev={rec.evidence} />}
      </div>
    )
  }

  // DRAFT card — with Approve / Reject actions
  function DraftCard({ r: rec }: { r: RecRow }) {
    const url         = amazonLink(rec.target_text, rec.country_code)
    const hasBidInput = BID_INPUT_TYPES.has(rec.rec_type)
    const proposedBid = rec.evidence.proposed_bid
    return (
      <details className="rec-card">
        <summary>
          <span className={recTypeBadge(rec.rec_type)}>{rec.rec_type}</span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>
            {url
              ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--cdl-blue)' }}>
                  {rec.target_text}
                </a>
              : rec.target_text}
          </span>
          <span style={{
            color: 'var(--cdl-muted)', flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {rec.proposal}
          </span>
          <span style={{ color: 'var(--cdl-muted)', fontSize: '0.82rem', flexShrink: 0 }}>
            {rec.country_code}
          </span>
          {/* Approve form — CREATIVE_TARGET: client form with ASIN gate; others: server action */}
          {rec.rec_type === 'CREATIVE_TARGET' ? (
            <CreativeTargetApproveForm id={rec.id} proposedBid={proposedBid} />
          ) : (
            <form
              action={approveRecommendation}
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}
            >
              <input type="hidden" name="id" value={rec.id} />
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
          )}
          <form action={rejectRecommendation} style={{ display: 'inline', flexShrink: 0 }}>
            <input type="hidden" name="id" value={rec.id} />
            <button type="submit" className="btn-reject">Reject</button>
          </form>
        </summary>
        <CardBody r={rec} />
      </details>
    )
  }

  // Ruled card — status badge only, no action buttons
  function RuledCard({ r: rec }: { r: RecRow }) {
    const url = amazonLink(rec.target_text, rec.country_code)
    return (
      <details className="rec-card">
        <summary>
          <span className={recTypeBadge(rec.rec_type)}>{rec.rec_type}</span>
          <span style={{ fontWeight: 600, flexShrink: 0 }}>
            {url
              ? <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--cdl-blue)' }}>
                  {rec.target_text}
                </a>
              : rec.target_text}
          </span>
          <span style={{
            color: 'var(--cdl-muted)', flex: 1, minWidth: 0,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {rec.proposal}
          </span>
          <span style={{ color: 'var(--cdl-muted)', fontSize: '0.82rem', flexShrink: 0 }}>
            {rec.country_code}
          </span>
          <span className={statusBadgeCls(rec.status)}>{rec.status}</span>
        </summary>
        <CardBody r={rec} />
      </details>
    )
  }

  return r.status === 'DRAFT' ? <DraftCard r={r} /> : <RuledCard r={r} />
}
