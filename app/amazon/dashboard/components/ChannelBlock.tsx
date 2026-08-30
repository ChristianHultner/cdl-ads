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

  const window = latestConsecutiveQuarter(vendorRows.filter(row => row.market === market))
  if (!window) return null

  const consoleByMonth = new Map(
    consoleRows
      .filter(row => row.market === market)
      .map(row => [monthKey(row), row]),
  )
  const matchingConsole = window.map(row => consoleByMonth.get(monthKey(row)))
  if (matchingConsole.some(row => row == null)) return null

  const consoleWindow = matchingConsole as ChannelConsoleRow[]
  const vendorUnits = window.reduce((sum, row) => sum + row.units, 0)
  const consoleSpend = consoleWindow.reduce((sum, row) => sum + row.spend, 0)
  const consoleOrders = consoleWindow.reduce((sum, row) => sum + row.orders, 0)
  const channelGp = vendorUnits * gpPerOrder - consoleSpend
  const attributionShare = vendorUnits > 0 ? consoleOrders / vendorUnits * 100 : null

  return (
    <div className={styles.channelBlock}>
      <div className={styles.channelTitle}>
        Whole Amazon channel · {formatWindow(window)} (sell-in)
      </div>
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
  return `${formatMonth(rows[0])}–${formatMonth(rows[2])}`
}

function formatMonth(row: ChannelVendorRow) {
  return new Intl.DateTimeFormat('en-GB', { month: 'short', timeZone: 'UTC' })
    .format(new Date(Date.UTC(row.year, row.month - 1, 1)))
}

function monthKey(row: { year: number; month: number }) {
  return `${row.year}-${String(row.month).padStart(2, '0')}`
}

function monthNumber(row: { year: number; month: number }) {
  return row.year * 12 + row.month
}
