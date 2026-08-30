'use client'

// Client wrapper — manages the shared activeTab state for both charts.
// SalesSpendChart and AcosChart are pure render functions (no server-only APIs),
// so they can be imported and called from this client component.

import { useState } from 'react'
import SalesSpendChart, { type ChartPoint } from './SalesSpendChart'
import AcosChart from './AcosChart'
import styles from './DashboardZoneOne.module.css'

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
    <div className={styles.chartSection}>
      {/* Tab bar + daily toggle */}
      <div className={styles.chartTabs}>
        {active.map(m => {
          const isActive = m.country === tab
          return (
            <button
              key={m.country}
              onClick={() => setTab(m.country)}
              className={`${styles.chartTab} ${isActive ? styles.chartTabActive : ''}`}
            >
              {m.country}
            </button>
          )
        })}
        <label className={styles.chartToggle}>
          <input
            type="checkbox"
            checked={showDaily}
            onChange={e => setShowDaily(e.target.checked)}
            className={styles.chartCheckbox}
          />
          daily
        </label>
      </div>

      {/* Sales + Spend chart */}
      <div className={styles.chartPanel}>
        <h3 className={styles.panelTitle}>Sales, spend &amp; Ad GP · {market.country}</h3>
        <div className={styles.panelCaption}>Daily averages, last 90 days — the ad slice only.</div>
        <SalesSpendChart points={market.points} currency={market.currency} showDaily={showDaily} gpPerOrder={market.gpPerOrder} />
        <div className={styles.panelSource}>source: Amazon Ads API · sponsored products + sponsored brands</div>
      </div>

      {/* ACoS chart */}
      <div className={styles.chartPanel}>
        <h3 className={styles.panelTitle}>Advertising cost of sales · {market.country}</h3>
        <div className={styles.panelCaption}>Spend as a share of attributed sales, against the {(market.targetAcos * 100).toFixed(0)}% target.</div>
        <AcosChart points={market.points} targetAcos={market.targetAcos} showDaily={showDaily} />
        <div className={styles.panelSource}>source: Amazon Ads API · 30-day rolling ACoS</div>
      </div>
    </div>
  )
}
