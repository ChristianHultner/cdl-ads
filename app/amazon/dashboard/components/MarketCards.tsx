import MarginGauge, { formatMoney } from './MarginGauge'
import styles from './DashboardZoneOne.module.css'

export interface MarketCardRow {
  profileId: string
  country: string
  currency: string
  gpPerOrder: number | null
  spend: number
  sales: number
  orders: number
}

const COUNTRY_NAMES: Record<string, string> = {
  CA: 'Canada',
  DE: 'Germany',
  ES: 'Spain',
  FR: 'France',
  IT: 'Italy',
  MX: 'Mexico',
  UK: 'United Kingdom',
  US: 'United States',
}

export default function MarketCards({ rows }: { rows: MarketCardRow[] }) {
  return (
    <div className={styles.cards}>
      {rows.map(row => {
        const unitBasis = row.gpPerOrder != null
        const gp = unitBasis
          ? row.orders * row.gpPerOrder! - row.spend
          : row.sales - row.spend

        return (
          <article className={styles.marketCard} key={row.profileId}>
            <div className={styles.marketHeading}>
              <span className={styles.marketName}>{COUNTRY_NAMES[row.country] ?? row.country}</span>
              <a className={styles.detailLink} href="#trends-90-days">90-day detail →</a>
            </div>
            <div className={styles.basis}>
              {unitBasis
                ? `margin ${formatMoney(row.gpPerOrder!, row.currency, 2)} / order`
                : 'no margin ruled — revenue basis'}
            </div>

            <div className={`${styles.gp} ${unitBasis ? (gp >= 0 ? styles.gpPositive : styles.gpNegative) : styles.gpUnavailable}`}>
              {formatMoney(gp, row.currency, 0, true)}
            </div>
            <div className={styles.gpSub}>
              {unitBasis
                ? 'Ad GP, 30 days'
                : <>revenue − spend, 30 days <em>(pre-COGS)</em></>}
            </div>

            <MarginGauge
              currency={row.currency}
              gpPerOrder={row.gpPerOrder}
              spend={row.spend}
              orders={row.orders}
            />

            <div className={styles.smallRow}>
              <span>spend <b>{formatMoney(row.spend, row.currency)}</b></span>
              <span>sales <b>{formatMoney(row.sales, row.currency)}</b></span>
              <span>orders <b>{Math.round(row.orders).toLocaleString('en-US')}</b></span>
            </div>
          </article>
        )
      })}
    </div>
  )
}
