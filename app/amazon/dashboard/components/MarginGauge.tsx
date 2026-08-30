import styles from './DashboardZoneOne.module.css'

interface MarginGaugeProps {
  currency: string
  gpPerOrder: number | null
  spend: number
  orders: number
}

export default function MarginGauge({ currency, gpPerOrder, spend, orders }: MarginGaugeProps) {
  if (gpPerOrder == null) {
    return (
      <div className={styles.gauge}>
        <div className={styles.gaugeLabels}><span>earning</span><span>losing</span></div>
        <div className={`${styles.track} ${styles.trackDisabled}`} aria-label="Margin gauge unavailable">
          <span className={`${styles.tick} ${styles.tickDisabled}`} />
        </div>
        <div className={`${styles.gaugeRead} ${styles.gaugeReadDisabled}`}>
          gauge unavailable — rule a {currency} margin to enable
        </div>
      </div>
    )
  }

  const costPerOrder = orders > 0 ? spend / orders : null
  const markerPosition = costPerOrder == null || gpPerOrder <= 0
    ? 97
    : clamp(costPerOrder / (2 * gpPerOrder) * 100, 3, 97)
  const isEarning = costPerOrder != null && costPerOrder <= gpPerOrder

  return (
    <div className={styles.gauge}>
      <div className={styles.gaugeLabels}><span>earning</span><span>losing</span></div>
      <div
        className={styles.track}
        aria-label={`Cost per order ${costPerOrder == null ? 'unavailable' : formatMoney(costPerOrder, currency, 2)}; margin ${formatMoney(gpPerOrder, currency, 2)}`}
      >
        <span className={styles.tick} />
        <span
          className={`${styles.marker} ${isEarning ? styles.markerPositive : styles.markerNegative}`}
          style={{ left: `${markerPosition}%` }}
        />
      </div>
      <div className={styles.gaugeRead}>
        each order costs{' '}
        <span className={styles.mono}>{costPerOrder == null ? '—' : formatMoney(costPerOrder, currency, 2)}</span>
        {' '}vs <span className={styles.mono}>{formatMoney(gpPerOrder, currency, 2)}</span> margin
      </div>
    </div>
  )
}

export function formatMoney(value: number, currency: string, digits = 0, showSign = false) {
  const symbols: Record<string, string> = {
    EUR: '€',
    USD: '$',
    MXN: 'MX$',
    GBP: '£',
    CAD: 'CA$',
  }
  const sign = showSign ? (value < 0 ? '−' : value > 0 ? '+' : '') : value < 0 ? '−' : ''
  const amount = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
  return `${sign}${symbols[currency] ?? `${currency} `}${amount}`
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}
