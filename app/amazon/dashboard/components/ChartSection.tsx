'use client'

// Client wrapper — manages the shared activeTab state for both charts.
// SalesSpendChart and AcosChart are pure render functions (no server-only APIs),
// so they can be imported and called from this client component.

import { useState } from 'react'
import SalesSpendChart, { type ChartPoint } from './SalesSpendChart'
import AcosChart from './AcosChart'

export interface MarketChartData {
  country:    string
  currency:   string
  targetAcos: number
  gpPerOrder: number | null
  points:     ChartPoint[]
}

const TAB_ORDER = ['ES', 'US', 'MX', 'UK', 'CA', 'DE', 'FR', 'IT']

export default function ChartSection({ markets }: { markets: MarketChartData[] }) {
  // Only show markets that have actual spend or sales data
  const active = TAB_ORDER
    .map(cc => markets.find(m => m.country === cc))
    .filter((m): m is MarketChartData =>
      !!m && m.points.some(p => p.sales > 0 || p.spend > 0)
    )

  const [tab, setTab]             = useState(active[0]?.country ?? 'ES')
  const [showDaily, setShowDaily]  = useState(false)
  const market = active.find(m => m.country === tab) ?? active[0]

  if (!market) return null

  return (
    <div style={{ marginBottom: '1.5rem' }}>
      {/* Tab bar + daily toggle */}
      <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #c8dfe9', marginBottom: '0.75rem' }}>
        {active.map(m => {
          const isActive = m.country === tab
          return (
            <button
              key={m.country}
              onClick={() => setTab(m.country)}
              style={{
                padding: '0.3rem 0.9rem',
                fontSize: '0.78rem',
                fontWeight: isActive ? 700 : 400,
                color: isActive ? 'var(--cdl-blue)' : 'var(--cdl-ink)',
                background: 'none',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--cdl-blue)' : '2px solid transparent',
                cursor: 'pointer',
                outline: 'none',
                marginBottom: -1,
              }}
            >
              {m.country}
            </button>
          )
        })}
        <label style={{
          marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: '0.3rem',
          fontSize: '0.68rem', color: 'var(--cdl-muted)', cursor: 'pointer',
          paddingRight: '0.5rem', paddingBottom: '0.1rem',
        }}>
          <input
            type="checkbox"
            checked={showDaily}
            onChange={e => setShowDaily(e.target.checked)}
            style={{ cursor: 'pointer', accentColor: 'var(--cdl-blue)' }}
          />
          daily
        </label>
      </div>

      {/* Sales + Spend chart */}
      <div style={{
        border: '1px solid #c8dfe9', borderRadius: 8,
        padding: '0.75rem 0.75rem 0.4rem', marginBottom: '0.75rem', overflow: 'hidden',
      }}>
        <div style={{
          fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.07em', color: 'var(--cdl-muted)', marginBottom: '0.4rem',
        }}>
          Sales &amp; Spend · 90 days · {market.currency}
        </div>
        <SalesSpendChart points={market.points} currency={market.currency} showDaily={showDaily} gpPerOrder={market.gpPerOrder} />
      </div>

      {/* ACoS chart */}
      <div style={{
        border: '1px solid #c8dfe9', borderRadius: 8,
        padding: '0.75rem 0.75rem 0.4rem', overflow: 'hidden',
      }}>
        <div style={{
          fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase',
          letterSpacing: '0.07em', color: 'var(--cdl-muted)', marginBottom: '0.4rem',
        }}>
          ACoS · 90 days · target {(market.targetAcos * 100).toFixed(0)}%
        </div>
        <AcosChart points={market.points} targetAcos={market.targetAcos} showDaily={showDaily} />
      </div>
    </div>
  )
}
