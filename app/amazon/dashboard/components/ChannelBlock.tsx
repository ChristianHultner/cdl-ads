import { formatMoney } from './MarginGauge'
import styles from './DashboardZoneOne.module.css'

export interface ChannelVendorRow {
  market: string
  year: number
  month: number
  units: number
}

export interface ChannelConsoleRow {
  market: string
  year: number
  month: number
  spend: number
  orders: number
}

interface ChannelBlockProps {
  market: string
  currency: string
  gpPerOrder: number | null
  vendorRows: ChannelVendorRow[]
  consoleRows: ChannelConsoleRow[]
}

export default function ChannelBlock({
  market,
  currency,
  gpPerOrder,
  vendorRows,
  consoleRows,
}: ChannelBlockProps) {
  if (gpPerOrder == null) return null

  const marketVendorRows = vendorRows.filter(row => row.market === market)
  const marketConsoleRows = consoleRows.filter(row => row.market === market)
  const consoleByMonth = new Map(
    marketConsoleRows.map(row => [monthKey(row), row]),
  )
  const window = latestConsecutiveQuarter(
    marketVendorRows.filter(row => consoleByMonth.has(monthKey(row))),
  )
  if (!window) return null

  const matchingConsole = window.map(row => consoleByMonth.get(monthKey(row)))
  const consoleWindow = matchingConsole as ChannelConsoleRow[]
  const vendorUnits = window.reduce((sum, row) => sum + row.units, 0)
  const consoleSpend = consoleWindow.reduce((sum, row) => sum + row.spend, 0)
  const consoleOrders = consoleWindow.reduce((sum, row) => sum + row.orders, 0)
  const channelGp = vendorUnits * gpPerOrder - consoleSpend
  const attributionShare = vendorUnits > 0 ? consoleOrders / vendorUnits * 100 : null
  const latestVendor = latestMonth(marketVendorRows)
  const latestConsole = latestMonth(marketConsoleRows)
  const freshness = latestVendor && latestConsole && monthKey(latestVendor) !== monthKey(latestConsole)
    ? `vendor through ${formatMonth(latestVendor)}, console through ${formatMonth(latestConsole)}`
    : null

  return (
    <div className={styles.channelBlock}>
      <div className={styles.channelTitle}>
        Whole Amazon channel · {formatWindow(window)} (sell-in)
      </div>
      {freshness && <div className={styles.channelFreshness}>{freshness}</div>}
      <div className={styles.channelMetrics}>
        <div>
          <span className={styles.channelLabel}>units/mo</span>
          <b className={styles.mono}>{Math.round(vendorUnits / 3).toLocaleString('en-US')}</b>
        </div>
        <div>
          <span className={styles.channelLabel}>channel GP · quarter</span>
          <b className={`${styles.mono} ${channelGp >= 0 ? styles.channelPositive : styles.channelNegative}`}>
            {formatMoney(channelGp, currency, 0, true)}
          </b>
        </div>
        <div>
          <span className={styles.channelLabel}>attribution share</span>
          <b className={styles.mono}>{attributionShare == null ? '—' : `${attributionShare.toFixed(1)}%`}</b>
        </div>
      </div>
    </div>
  )
}

function latestConsecutiveQuarter(rows: ChannelVendorRow[]) {
  const sorted = [...rows].sort((a, b) => monthNumber(a) - monthNumber(b))
  for (let i = sorted.length - 1; i >= 2; i--) {
    const window = sorted.slice(i - 2, i + 1)
    if (
      monthNumber(window[1]) === monthNumber(window[0]) + 1
      && monthNumber(window[2]) === monthNumber(window[1]) + 1
    ) {
      return window
    }
  }
  return null
}

function formatWindow(rows: ChannelVendorRow[]) {
  if (rows[0].year === rows[2].year) {
    return `${formatMonth(rows[0])}–${formatMonth(rows[2])} ${rows[2].year}`
  }
  return `${formatMonth(rows[0])} ${rows[0].year}–${formatMonth(rows[2])} ${rows[2].year}`
}

function formatMonth(row: { year: number; month: number }) {
  return new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(row.year, row.month - 1, 1)))
}

function monthKey(row: { year: number; month: number }) {
  return `${row.year}-${String(row.month).padStart(2, '0')}`
}

function monthNumber(row: { year: number; month: number }) {
  return row.year * 12 + row.month
}

function latestMonth<T extends { year: number; month: number }>(rows: T[]) {
  return rows.reduce<T | null>((latest, row) => (
    latest == null || monthNumber(row) > monthNumber(latest) ? row : latest
  ), null)
}
