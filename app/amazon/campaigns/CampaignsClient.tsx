'use client'

import { useState } from 'react'

// ── Shared types (also imported by page.tsx) ─────────────────────────────────
export interface MarketRow {
  profile_id: string
  country_code: string
  currency_code: string
  target_acos: string
  spend_30d: string
  sales_30d: string
  acos: string | null
}

export interface CampaignRow {
  profile_id: string
  campaign_id: string
  campaign_name: string
  state: string
  spend_30d: string
  sales_30d: string
  acos: string | null
  budget_amount: string | null
  budget_type: string | null
}

export interface CampaignsClientProps {
  markets: MarketRow[]
  campsByProfile: Record<string, CampaignRow[]>
  countMap: Record<string, string>
  recMap: Record<string, number>
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function stateBadgeCls(state: string): string {
  const s = state.toUpperCase()
  if (s === 'ENABLED')  return 'badge badge-ok'
  if (s === 'ARCHIVED') return 'badge badge-dim'
  return 'badge badge-muted' // PAUSED + others
}

function fmt(v: string): string {
  return parseFloat(v).toFixed(2)
}

function computeAcos(spend: string, sales: string): string | null {
  const sa = parseFloat(sales)
  if (!sa) return null
  return ((parseFloat(spend) / sa) * 100).toFixed(1)
}

type FilterKey = 'all' | 'enabled' | 'paused'

const FILTER_OPTIONS: { key: FilterKey; label: string }[] = [
  { key: 'all',     label: 'All'     },
  { key: 'enabled', label: 'Enabled' },
  { key: 'paused',  label: 'Paused'  },
]

// ── Root client component ─────────────────────────────────────────────────────
export function CampaignsClient({
  markets,
  campsByProfile,
  countMap,
  recMap,
}: CampaignsClientProps) {
  const [filter, setFilter] = useState<FilterKey>('all')

  function applyFilter(camps: CampaignRow[]): CampaignRow[] {
    if (filter === 'enabled') return camps.filter(c => c.state.toUpperCase() === 'ENABLED')
    if (filter === 'paused')  return camps.filter(c => c.state.toUpperCase() === 'PAUSED')
    return camps
  }

  return (
    <div>
      <h1>Campaigns</h1>

      {/* ── Filter bar (pure client-side) ── */}
      <div className="filter-bar">
        {FILTER_OPTIONS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`filter-link${filter === key ? ' active' : ''}`}
            style={{ cursor: 'pointer' }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── One section per market ── */}
      {markets.map(m => {
        const target     = parseFloat(m.target_acos)
        const allCamps   = campsByProfile[m.profile_id] ?? []
        const camps      = applyFilter(allCamps)
        const totalCamps = countMap[m.profile_id] ?? '0'

        const mSpend  = parseFloat(m.spend_30d)
        const mAcosNum = m.acos != null ? parseFloat(m.acos) * 100 : null
        const mAcosStr = mAcosNum != null ? mAcosNum.toFixed(1) + '%' : '—'
        const mAcosBadge = mAcosNum != null
          ? (mAcosNum <= target * 100 ? 'badge badge-ok' : 'badge badge-warn')
          : ''

        return (
          <section
            key={m.profile_id}
            id={`p-${m.profile_id}`}
            style={{ marginBottom: '3rem' }}
          >
            {/* Market header */}
            <div style={{
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: '0.75rem',
              marginBottom: '0.75rem',
            }}>
              <h2 style={{ marginBottom: 0 }}>
                {m.country_code} ({m.currency_code})
              </h2>
              <span style={{ fontSize: '0.85rem', color: 'var(--cdl-muted)' }}>
                {totalCamps} campaigns &middot; {mSpend.toFixed(2)} {m.currency_code} 30d
              </span>
              {mAcosStr !== '—' && (
                <span className={mAcosBadge}>{mAcosStr}</span>
              )}
              <span style={{ fontSize: '0.78rem', color: 'var(--cdl-muted)' }}>
                tgt {(target * 100).toFixed(0)}%
              </span>
            </div>

            {/* Campaign table */}
            {camps.length === 0 ? (
              <p style={{ color: 'var(--cdl-muted)', fontSize: '0.85rem' }}>
                No {filter === 'all' ? '' : filter + ' '}campaigns.
              </p>
            ) : (
              <div className="table-card">
                <div className="table-scroll">
                  <table className="data-table" style={{ tableLayout: 'fixed' }}>
                    <colgroup>
                      <col style={{ width: '400px' }} />
                      <col style={{ width: '90px' }} />
                      <col style={{ width: '130px' }} />
                      <col style={{ width: '130px' }} />
                      <col style={{ width: '130px' }} />
                      <col style={{ width: '110px' }} />
                      <col style={{ width: '70px' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Campaign</th>
                        <th>State</th>
                        <th className="num">Spend 30d</th>
                        <th className="num">Budget</th>
                        <th className="num">Sales 30d</th>
                        <th className="num">ACOS 30d</th>
                        <th style={{ textAlign: 'center' }}>Recs</th>
                      </tr>
                    </thead>
                    <tbody>
                      {camps.map(c => {
                        const acosStr  = computeAcos(c.spend_30d, c.sales_30d)
                        const acosNum  = acosStr != null ? parseFloat(acosStr) : null
                        const acosBadge = acosNum != null
                          ? (acosNum <= target * 100 ? 'badge badge-ok' : 'badge badge-warn')
                          : ''
                        const recCount = recMap[`${m.profile_id}:${c.campaign_id}`] ?? 0
                        return (
                          <tr key={c.campaign_id}>
                            <td style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              <a
                                href={`/amazon/campaigns/${m.profile_id}/${encodeURIComponent(c.campaign_id)}`}
                                style={{ color: 'var(--cdl-blue)', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                                title={c.campaign_name}
                              >
                                {c.campaign_name}
                              </a>
                            </td>
                            <td>
                              <span className={stateBadgeCls(c.state)}>
                                {c.state}
                              </span>
                            </td>
                            <td className="num">
                              {fmt(c.spend_30d)} {m.currency_code}
                            </td>
                            <td className="num">
                              {c.budget_amount != null
                                ? `${parseFloat(c.budget_amount).toFixed(2)} ${m.currency_code}/day`
                                : '—'}
                            </td>
                            <td className="num">
                              {fmt(c.sales_30d)} {m.currency_code}
                            </td>
                            <td className="num">
                              {acosStr != null
                                ? <span className={acosBadge}>{acosStr}%</span>
                                : '—'}
                            </td>
                            <td style={{ textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}>
                              {recCount > 0
                                ? <a
                                    href={`/amazon/campaigns/${m.profile_id}/${encodeURIComponent(c.campaign_id)}#recs`}
                                    style={{ textDecoration: 'none' }}
                                  >
                                    <span className="badge badge-blue">{recCount}</span>
                                  </a>
                                : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
