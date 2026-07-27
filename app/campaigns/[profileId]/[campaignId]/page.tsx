export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { notFound } from 'next/navigation'

// ── TLD by country code ──────────────────────────────────────────────────────
const TLD: Record<string, string> = {
  ES: 'es',
  US: 'com',
  MX: 'com.mx',
  CA: 'ca',
  UK: 'co.uk',
  GB: 'co.uk',
  DE: 'de',
  IT: 'it',
  FR: 'fr',
}

function asinUrl(asin: string, countryCode: string): string {
  const tld = TLD[countryCode] ?? 'com'
  return `https://www.amazon.${tld}/dp/${asin.toUpperCase()}`
}

function stateBadgeCls(state: string): string {
  const s = state.toUpperCase()
  if (s === 'ENABLED')  return 'badge badge-ok'
  if (s === 'ARCHIVED') return 'badge badge-dim'
  return 'badge badge-muted'
}

function fmt(v: string | number | null | undefined): string {
  if (v == null) return '—'
  const n = parseFloat(String(v))
  if (isNaN(n)) return '—'
  return n.toFixed(2)
}

function computeAcos(spend: string | number, sales: string | number): string | null {
  const sa = parseFloat(String(sales))
  if (!sa) return null
  return ((parseFloat(String(spend)) / sa) * 100).toFixed(1)
}

// ── Interfaces ───────────────────────────────────────────────────────────────
interface ProfileRow {
  country_code: string
  currency_code: string
}

interface CampaignRow {
  campaign_name: string
  state: string
}

interface TotalsRow {
  spend_30d: string
  sales_30d: string
  orders_30d: string
}

interface AcosParam {
  scope: string
  value: string
}

interface AdGroup {
  ad_group_id: string
  name: string
  state: string
  default_bid: string | null
}

interface ProductAd {
  ad_id: string
  ad_group_id: string
  asin: string | null
  state: string
}

interface AdPerfRow {
  ad_id: string
  spend: string
  orders: string
  sales: string
}

interface Target {
  target_id: string
  ad_group_id: string
  state: string
  expression_type: string | null
  expression_subtype: string | null
  expression_subvalue: string | null
  resolved_asin: string | null
  bid: string | null
}

interface StRow {
  ad_group_id: string
  search_term: string
  spend: string
  orders: string
  sales: string
}

interface Keyword {
  keyword_id: string
  ad_group_id: string
  keyword_text: string
  match_type: string
  state: string
  bid: string | null
}

// ── Stat label helper ────────────────────────────────────────────────────────
function StatLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '0.72rem',
      fontWeight: 700,
      textTransform: 'uppercase' as const,
      letterSpacing: '0.05em',
      color: 'var(--cdl-muted)',
      marginBottom: '0.2rem',
    }}>
      {children}
    </div>
  )
}

// ── Page ─────────────────────────────────────────────────────────────────────
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ profileId: string; campaignId: string }>
}) {
  const { profileId, campaignId } = await params
  const sql = neon(process.env.DATABASE_URL!)

  const [
    profileRows,
    campaignRows,
    totalsRows,
    acosRows,
    adGroups,
    productAds,
    targets,
    stTerms,
  ] = (await Promise.all([
    // Profile identity
    sql`
      SELECT country_code, currency_code
      FROM amazon_profiles
      WHERE profile_id = ${profileId}::bigint
      LIMIT 1
    `,
    // Campaign name + state
    sql`
      SELECT
        coalesce(name, ${campaignId})    AS campaign_name,
        coalesce(state, 'UNKNOWN')       AS state
      FROM amazon_campaigns
      WHERE profile_id = ${profileId}::bigint
        AND campaign_id = ${campaignId}
      LIMIT 1
    `,
    // 30d totals
    sql`
      SELECT
        coalesce(sum(cost), 0)::text          AS spend_30d,
        coalesce(sum(sales_14d), 0)::text     AS sales_30d,
        coalesce(sum(purchases_14d), 0)::text AS orders_30d
      FROM amazon_campaign_daily
      WHERE profile_id = ${profileId}::bigint
        AND campaign_id = ${campaignId}
        AND date >= CURRENT_DATE - INTERVAL '30 days'
    `,
    // target_acos params
    sql`
      SELECT scope, value::text
      FROM engine_parameters
      WHERE key = 'target_acos'
    `,
    // Ad groups sorted by name
    sql`
      SELECT
        ad_group_id,
        name,
        state,
        default_bid::text
      FROM amazon_ad_groups
      WHERE profile_id = ${profileId}::bigint
        AND campaign_id = ${campaignId}
      ORDER BY name
    `,
    // Product ads
    sql`
      SELECT
        ad_id,
        ad_group_id,
        asin,
        state
      FROM amazon_product_ads
      WHERE profile_id = ${profileId}::bigint
        AND campaign_id = ${campaignId}
      ORDER BY asin NULLS LAST
    `,
    // Targets
    sql`
      SELECT
        target_id,
        ad_group_id,
        state,
        expression_type,
        expression->0->>'type' AS expression_subtype,
        expression->0->>'value' AS expression_subvalue,
        resolved_asin,
        bid::text
      FROM amazon_targets
      WHERE profile_id = ${profileId}::bigint
        AND campaign_id = ${campaignId}
      ORDER BY ad_group_id, resolved_asin NULLS LAST
    `,
    // Search term daily — last 60d, all ad groups for this campaign
    sql`
      SELECT
        ad_group_id,
        search_term,
        sum(cost)::text          AS spend,
        sum(purchases_14d)::text AS orders,
        sum(sales_14d)::text     AS sales
      FROM amazon_search_term_daily
      WHERE profile_id = ${profileId}::bigint
        AND campaign_id = ${campaignId}
        AND date >= CURRENT_DATE - INTERVAL '60 days'
      GROUP BY ad_group_id, search_term
      ORDER BY ad_group_id, sum(cost) DESC
    `,
  ])) as unknown as [
    ProfileRow[],
    CampaignRow[],
    TotalsRow[],
    AcosParam[],
    AdGroup[],
    ProductAd[],
    Target[],
    StRow[],
  ]

  // Profile must exist
  if (profileRows.length === 0) notFound()

  const profile  = profileRows[0]
  const campaign = campaignRows[0] ?? { campaign_name: campaignId, state: 'UNKNOWN' }
  const totals   = totalsRows[0]  ?? { spend_30d: '0', sales_30d: '0', orders_30d: '0' }

  // Resolve ACOS target
  const acosMap      = new Map(acosRows.map(p => [p.scope, parseFloat(p.value)]))
  const globalTarget = acosMap.get('GLOBAL') ?? 0.30
  const targetPct    = (acosMap.get(profileId) ?? globalTarget) * 100

  const acos30d    = computeAcos(totals.spend_30d, totals.sales_30d)
  const acos30dNum = acos30d != null ? parseFloat(acos30d) : null
  const acosBadge  = acos30dNum != null
    ? (acos30dNum <= targetPct ? 'badge badge-ok' : 'badge badge-warn')
    : ''

  // Index product ads by ad_group_id
  const padsByGroup = new Map<string, ProductAd[]>()
  for (const pa of productAds) {
    const list = padsByGroup.get(pa.ad_group_id) ?? []
    list.push(pa)
    padsByGroup.set(pa.ad_group_id, list)
  }

  // Index targets by ad_group_id
  const targetsByGroup = new Map<string, Target[]>()
  for (const t of targets) {
    const list = targetsByGroup.get(t.ad_group_id) ?? []
    list.push(t)
    targetsByGroup.set(t.ad_group_id, list)
  }

  // Index search terms by ad_group_id (already sorted by spend desc)
  const stByGroup = new Map<string, StRow[]>()
  for (const st of stTerms) {
    const list = stByGroup.get(st.ad_group_id) ?? []
    list.push(st)
    stByGroup.set(st.ad_group_id, list)
  }

  // Ad-level 60d performance from amazon_advertised_product_daily
  const adPerfRows = await sql`
    SELECT
      ad_id,
      sum(cost)::text          AS spend,
      sum(purchases_14d)::text AS orders,
      sum(sales_14d)::text     AS sales
    FROM amazon_advertised_product_daily
    WHERE profile_id = ${profileId}::text
      AND campaign_id = ${campaignId}::text
      AND date >= CURRENT_DATE - INTERVAL '60 days'
    GROUP BY ad_id
  ` as unknown as AdPerfRow[]

  const adPerfMap = new Map<string, AdPerfRow>()
  for (const ap of adPerfRows) adPerfMap.set(ap.ad_id, ap)

  // Keywords for the campaign (all ad groups) — profile_id bigint per migration 007
  const keywords = await sql`
    SELECT
      keyword_id,
      ad_group_id,
      keyword_text,
      match_type,
      state,
      bid::text
    FROM amazon_keywords
    WHERE profile_id = ${profileId}::bigint
      AND campaign_id = ${campaignId}::text
    ORDER BY ad_group_id, keyword_text
  ` as unknown as Keyword[]

  const kwsByGroup = new Map<string, Keyword[]>()
  for (const kw of keywords) {
    const list = kwsByGroup.get(kw.ad_group_id) ?? []
    list.push(kw)
    kwsByGroup.set(kw.ad_group_id, list)
  }

  function stPerfFor(adGroupId: string, resolvedAsin: string): StRow | undefined {
    return (stByGroup.get(adGroupId) ?? []).find(
      r => r.search_term === resolvedAsin.toLowerCase()
    )
  }

  function top8(adGroupId: string): StRow[] {
    return (stByGroup.get(adGroupId) ?? []).slice(0, 8)
  }

  // Shared sub-label style
  const subLabel: React.CSSProperties = {
    fontSize: '0.72rem',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--cdl-muted)',
  }

  return (
    <div>
      {/* ── Back ── */}
      <div style={{ marginBottom: '1rem' }}>
        <a href="/campaigns" style={{ color: 'var(--cdl-blue)', fontSize: '0.85rem' }}>
          ← Campaigns
        </a>
      </div>

      {/* ── Header ── */}
      <div style={{ marginBottom: '2rem' }}>
        <div style={{
          display: 'flex',
          alignItems: 'baseline',
          flexWrap: 'wrap',
          gap: '0.75rem',
          marginBottom: '0.5rem',
        }}>
          <h1 style={{ marginBottom: 0 }}>{campaign.campaign_name}</h1>
          <span className={stateBadgeCls(campaign.state)}>{campaign.state}</span>
          <span style={{ fontSize: '0.85rem', color: 'var(--cdl-muted)' }}>
            {profile.country_code} · {profile.currency_code}
          </span>
        </div>

        {/* 30d stats */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '2rem', fontSize: '0.9rem', marginTop: '0.75rem' }}>
          <div>
            <StatLabel>Spend 30d</StatLabel>
            <div style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmt(totals.spend_30d)} {profile.currency_code}
            </div>
          </div>
          <div>
            <StatLabel>Sales 30d</StatLabel>
            <div style={{ fontVariantNumeric: 'tabular-nums' }}>
              {fmt(totals.sales_30d)} {profile.currency_code}
            </div>
          </div>
          <div>
            <StatLabel>ACOS 30d</StatLabel>
            <div>
              {acos30d != null ? (
                <>
                  <span className={acosBadge}>{acos30d}%</span>
                  <span style={{ fontSize: '0.78em', color: 'var(--cdl-muted)', marginLeft: '0.5em' }}>
                    tgt {targetPct.toFixed(0)}%
                  </span>
                </>
              ) : '—'}
            </div>
          </div>
          <div>
            <StatLabel>Orders 30d</StatLabel>
            <div>{totals.orders_30d}</div>
          </div>
        </div>
      </div>

      {/* ── Ad Groups ── */}
      <h2>Ad Groups</h2>

      {adGroups.length === 0 && (
        <p style={{ color: 'var(--cdl-muted)', fontSize: '0.85rem' }}>
          No ad groups found for this campaign.
        </p>
      )}

      {adGroups.map(ag => {
        const pads      = padsByGroup.get(ag.ad_group_id)     ?? []
        const tgts      = targetsByGroup.get(ag.ad_group_id)  ?? []
        const topTerms  = top8(ag.ad_group_id)
        const kws       = kwsByGroup.get(ag.ad_group_id)      ?? []
        const hasStPerf = tgts.some(t => t.resolved_asin && stPerfFor(ag.ad_group_id, t.resolved_asin))
        const hasKwPerf = kws.some(kw => !!stPerfFor(ag.ad_group_id, kw.keyword_text))

        return (
          <section
            key={ag.ad_group_id}
            id={`ag-${ag.ad_group_id}`}
            style={{
              border: '1px solid #c8dfe9',
              borderRadius: '8px',
              marginBottom: '2rem',
              overflow: 'hidden',
              boxShadow: '0 1px 5px rgba(0,0,0,.08)',
            }}
          >
            {/* Ad group title bar */}
            <div style={{
              background: 'var(--cdl-sky)',
              padding: '0.75rem 1rem',
              borderBottom: '1px solid #c8dfe9',
              display: 'flex',
              alignItems: 'baseline',
              flexWrap: 'wrap',
              gap: '0.6rem',
            }}>
              <h3 style={{ marginBottom: 0 }}>{ag.name}</h3>
              <span className={stateBadgeCls(ag.state)}>{ag.state}</span>
              {ag.default_bid != null && (
                <span style={{ fontSize: '0.82rem', color: 'var(--cdl-muted)' }}>
                  default bid: {fmt(ag.default_bid)} {profile.currency_code}
                </span>
              )}
            </div>

            <div style={{ padding: '1rem' }}>

              {/* ── b. Advertised Products ── */}
              <h4 style={{ marginBottom: '0.5rem' }}>Advertised Products</h4>
              {pads.length === 0 ? (
                <p style={{ color: 'var(--cdl-muted)', fontSize: '0.83rem', marginBottom: '1.5rem' }}>
                  No product ads in this ad group.
                </p>
              ) : (
                <div className="table-card" style={{ marginBottom: '1.5rem' }}>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>ASIN</th>
                          <th>State</th>
                          <th>Spend 60d</th>
                          <th>Orders 60d</th>
                          <th>Sales 60d</th>
                          <th>ACoS 60d</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pads.map((pa, i) => {
                          const perf      = adPerfMap.get(pa.ad_id)
                          const spend60d  = perf ? parseFloat(perf.spend).toFixed(2)  : null
                          const orders60d = perf ? Number(perf.orders)                 : null
                          const sales60d  = perf ? parseFloat(perf.sales).toFixed(2)  : null
                          const acos60d   = perf && parseFloat(perf.sales) > 0
                            ? (parseFloat(perf.spend) / parseFloat(perf.sales) * 100).toFixed(1)
                            : null
                          return (
                          <tr key={i}>
                            <td>
                              {pa.asin ? (
                                <a
                                  href={asinUrl(pa.asin, profile.country_code)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={{ color: 'var(--cdl-blue)', fontFamily: 'monospace', fontSize: '0.88em' }}
                                >
                                  {pa.asin.toUpperCase()}
                                </a>
                              ) : (
                                <span style={{ color: 'var(--cdl-muted)' }}>—</span>
                              )}
                            </td>
                            <td>
                              <span className={stateBadgeCls(pa.state)}>{pa.state}</span>
                            </td>
                            <td className="num">{spend60d  != null ? `${spend60d} ${profile.currency_code}`  : '—'}</td>
                            <td className="num">{orders60d != null ? orders60d                                : '—'}</td>
                            <td className="num">{sales60d  != null ? `${sales60d} ${profile.currency_code}`  : '—'}</td>
                            <td className="num">{acos60d   != null ? `${acos60d}%`                           : '—'}</td>
                          </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── c. Keywords ── */}
              <h4 style={{ marginBottom: '0.5rem' }}>Keywords</h4>
              {kws.length === 0 ? (
                <p style={{ color: 'var(--cdl-muted)', fontSize: '0.83rem', marginBottom: '1.5rem' }}>
                  No keywords in this ad group.
                </p>
              ) : (
                <div className="table-card" style={{ marginBottom: '1.5rem' }}>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Keyword</th>
                          <th>Match</th>
                          <th>State</th>
                          <th>Bid</th>
                          <th>Spend 60d</th>
                          <th>Orders 60d</th>
                          <th>ACOS 60d</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kws.map(kw => {
                          const perf   = stPerfFor(ag.ad_group_id, kw.keyword_text)
                          const kwAcos = perf ? computeAcos(perf.spend, perf.sales) : null
                          return (
                            <tr key={kw.keyword_id}>
                              <td>{kw.keyword_text}</td>
                              <td><span className="badge badge-muted">{kw.match_type}</span></td>
                              <td><span className={stateBadgeCls(kw.state)}>{kw.state}</span></td>
                              <td className="num">{kw.bid != null ? fmt(kw.bid) : '—'}</td>
                              <td className="num">{perf ? `${fmt(perf.spend)} ${profile.currency_code}` : '—'}</td>
                              <td className="num">{perf ? perf.orders : '—'}</td>
                              <td className="num">{kwAcos != null ? `${kwAcos}%` : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {hasKwPerf && (
                    <div style={{
                      padding: '0.3rem 0.75rem',
                      fontSize: '0.72rem',
                      color: 'var(--cdl-muted)',
                      borderTop: '1px solid #eef4f8',
                      ...subLabel,
                      textTransform: 'none',
                      letterSpacing: 0,
                    }}>
                      Spend / Orders / ACOS: via search-term data (last 60d)
                    </div>
                  )}
                </div>
              )}

              {/* ── d. Targets ── */}
              <h4 style={{ marginBottom: '0.5rem' }}>Targets</h4>
              {tgts.length === 0 ? (
                <p style={{ color: 'var(--cdl-muted)', fontSize: '0.83rem', marginBottom: '1.5rem' }}>
                  No targets in this ad group.
                </p>
              ) : (
                <div className="table-card" style={{ marginBottom: '1.5rem' }}>
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Target</th>
                          <th>State</th>
                          <th>Bid</th>
                          <th>Spend 60d</th>
                          <th>Orders 60d</th>
                          <th>ACOS 60d</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tgts.map(t => {
                          const perf  = t.resolved_asin ? stPerfFor(ag.ad_group_id, t.resolved_asin) : undefined
                          const tAcos = perf ? computeAcos(perf.spend, perf.sales) : null
                          return (
                            <tr key={t.target_id}>
                              <td>
                                {t.resolved_asin ? (
                                  <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: '0.4em' }}>
                                    <a
                                      href={asinUrl(t.resolved_asin, profile.country_code)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{ color: 'var(--cdl-blue)', fontFamily: 'monospace', fontSize: '0.88em' }}
                                    >
                                      {t.resolved_asin.toUpperCase()}
                                    </a>
                                    {t.expression_subtype === 'ASIN_EXPANDED_FROM' && (
                                      <span className="badge badge-muted">Expanded</span>
                                    )}
                                  </span>
                                ) : (
                                  <span style={{ color: 'var(--cdl-muted)', fontSize: '0.83rem' }}>
                                    {t.expression_subtype === 'ASIN_CATEGORY_SAME_AS'
                                      ? `Category: ${t.expression_subvalue ?? '—'}`
                                      : (t.expression_subtype ?? t.expression_type ?? '—')}
                                  </span>
                                )}
                              </td>
                              <td>
                                <span className={stateBadgeCls(t.state)}>{t.state}</span>
                              </td>
                              <td className="num">{t.bid != null ? fmt(t.bid) : '—'}</td>
                              {perf ? (
                                <>
                                  <td className="num">{fmt(perf.spend)}</td>
                                  <td className="num">{perf.orders}</td>
                                  <td className="num">{tAcos != null ? `${tAcos}%` : '—'}</td>
                                </>
                              ) : (
                                <>
                                  <td className="num">—</td>
                                  <td className="num">—</td>
                                  <td className="num">—</td>
                                </>
                              )}
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                  {hasStPerf && (
                    <div style={{
                      padding: '0.3rem 0.75rem',
                      fontSize: '0.72rem',
                      color: 'var(--cdl-muted)',
                      borderTop: '1px solid #eef4f8',
                      ...subLabel,
                      textTransform: 'none',
                      letterSpacing: 0,
                    }}>
                      Spend / Orders / ACOS: via search-term data (last 60d)
                    </div>
                  )}
                </div>
              )}

              {/* ── d. Top Search Terms ── */}
              <h4 style={{ marginBottom: '0.5rem' }}>
                Top Search Terms{' '}
                <span style={{ fontSize: '0.8em', fontWeight: 400, color: 'var(--cdl-muted)' }}>
                  (last 60d, top 8 by spend)
                </span>
              </h4>
              {topTerms.length === 0 ? (
                <p style={{ color: 'var(--cdl-muted)', fontSize: '0.83rem' }}>
                  No search term data for this ad group.
                </p>
              ) : (
                <div className="table-card">
                  <div className="table-scroll">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Search Term</th>
                          <th>Spend</th>
                          <th>Orders</th>
                          <th>ACOS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {topTerms.map((st, i) => {
                          const stAcos = computeAcos(st.spend, st.sales)
                          return (
                            <tr key={i}>
                              <td className="wrap">{st.search_term}</td>
                              <td className="num">
                                {fmt(st.spend)} {profile.currency_code}
                              </td>
                              <td className="num">{st.orders}</td>
                              <td className="num">{stAcos != null ? `${stAcos}%` : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

            </div>
          </section>
        )
      })}
    </div>
  )
}
