export const dynamic = 'force-dynamic'

import { getGoogleDb } from '@/lib/google/db'

interface CampaignRow {
  campaign_id:             string
  name:                   string
  status:                 string
  advertising_channel_type: string
  bidding_strategy_type:  string
  budget_eur:             string
  clicks_30d:             string
  cost_eur_30d:           string
  conversions_30d:        string
}

function statusBadgeCls(status: string): string {
  const s = status.toUpperCase()
  if (s === 'ENABLED')  return 'badge badge-ok'
  if (s === 'REMOVED')  return 'badge badge-warn'
  return 'badge badge-muted' // PAUSED + others
}

function fmt2(v: string | number): string {
  return parseFloat(String(v)).toFixed(2)
}

export default async function GoogleCampaignsPage() {
  const sql = getGoogleDb()

  const campaigns = (await sql`
    SELECT
      c.campaign_id::text,
      c.name,
      c.status,
      coalesce(c.advertising_channel_type, '—') AS advertising_channel_type,
      coalesce(c.bidding_strategy_type,    '—') AS bidding_strategy_type,
      coalesce((c.budget_micros::numeric / 1000000), 0)::text    AS budget_eur,
      coalesce(sum(d.clicks),                         0)::text   AS clicks_30d,
      coalesce(sum(d.cost_micros)::numeric / 1000000, 0)::text   AS cost_eur_30d,
      coalesce(sum(d.conversions),                    0)::text   AS conversions_30d
    FROM google_campaigns c
    LEFT JOIN google_campaign_daily d
      ON  d.campaign_id = c.campaign_id
      AND d.customer_id = c.customer_id
      AND d.date >= CURRENT_DATE - INTERVAL '30 days'
    GROUP BY
      c.campaign_id,
      c.name,
      c.status,
      c.advertising_channel_type,
      c.bidding_strategy_type,
      c.budget_micros
    ORDER BY
      CASE WHEN c.status = 'ENABLED' THEN 0 ELSE 1 END,
      coalesce(sum(d.cost_micros), 0) DESC
  `) as unknown as CampaignRow[]

  return (
    <div>
      <h1>Google Campaigns</h1>

      <div className="table-card">
        <div className="table-scroll">
          <table className="data-table" style={{ tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '320px' }} />
              <col style={{ width: '90px' }} />
              <col style={{ width: '120px' }} />
              <col style={{ width: '165px' }} />
              <col style={{ width: '110px' }} />
              <col style={{ width: '95px' }} />
              <col style={{ width: '105px' }} />
              <col style={{ width: '100px' }} />
            </colgroup>
            <thead>
              <tr>
                <th>Campaign</th>
                <th>Status</th>
                <th>Channel</th>
                <th>Bidding</th>
                <th className="num">Budget / day</th>
                <th className="num">Clicks 30d</th>
                <th className="num">Cost 30d</th>
                <th className="num">Conv. 30d</th>
              </tr>
            </thead>
            <tbody>
              {campaigns.map(c => (
                <tr key={c.campaign_id}>
                  <td
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={c.name}
                  >
                    {c.name}
                  </td>
                  <td>
                    <span className={statusBadgeCls(c.status)}>
                      {c.status}
                    </span>
                  </td>
                  <td
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--cdl-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.advertising_channel_type}
                  </td>
                  <td
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--cdl-muted)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.bidding_strategy_type}
                  </td>
                  <td className="num">{fmt2(c.budget_eur)} €</td>
                  <td className="num">
                    {parseInt(c.clicks_30d, 10).toLocaleString('en-GB')}
                  </td>
                  <td className="num">{fmt2(c.cost_eur_30d)} €</td>
                  <td className="num">
                    {parseFloat(c.conversions_30d).toFixed(1)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <p
        style={{
          fontSize: '0.8rem',
          color: 'var(--cdl-muted)',
          fontStyle: 'italic',
          marginTop: '-0.5rem',
        }}
      >
        Conversions pre-2026-04-30 include misconfigured legacy signals; account
        signal-dead since 2026-04-30 pending T1.
      </p>
    </div>
  )
}
