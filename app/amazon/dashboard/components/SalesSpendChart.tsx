'use client'

// Receives up to 120 days and preserves the existing 30-day rolling display series.
// The daily toggle adds the unchanged raw daily sales/spend lines behind the rolling lines.

import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts'
import styles from './DashboardZoneOne.module.css'

export interface ChartPoint {
  date:   string
  sales:  number
  spend:  number
  orders: number
  acos:   number | null
}

const PLOT_DAYS = 90
const ROLL_WIN = 30

interface TooltipSeries {
  key: string
  name: string
  color: string
}

function rollingAvg(values: number[], window: number): number[] {
  return values.map((_, index) => {
    const start = Math.max(0, index - window + 1)
    const slice = values.slice(start, index + 1)
    return slice.reduce((sum, value) => sum + value, 0) / slice.length
  })
}

function compactNumber(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000) {
    const millions = absolute / 1_000_000
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}m`
  }
  if (absolute >= 1_000) {
    const thousands = absolute / 1_000
    return `${Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`
  }
  return Math.round(absolute).toLocaleString('en-US')
}

function formatAxisMoney(value: number, currency: string): string {
  return `${value < 0 ? '−' : ''}${currency} ${compactNumber(value)}`
}

function formatMoney(value: number, currency: string): string {
  return `${value < 0 ? '−' : ''}${currency} ${Math.round(Math.abs(value)).toLocaleString('en-US')}`
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function niceStep(value: number): number {
  if (value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const factor = [1, 2, 2.5, 5, 10].find(candidate => candidate >= normalized) ?? 10
  return factor * magnitude
}

function niceDomain(values: number[]): { domain: [number, number]; ticks: number[] } {
  const rawMin = Math.min(...values)
  const rawMax = Math.max(...values)
  const lower = Math.min(0, rawMin)
  const span = Math.max(rawMax - lower, 1)
  const step = niceStep(span / 4)
  const min = lower < 0 ? Math.floor(lower / step) * step : 0
  const max = Math.max(step, Math.ceil(rawMax / step) * step)
  const ticks: number[] = []
  for (let value = min; value <= max + step / 2; value += step) ticks.push(value)
  return { domain: [min, max], ticks }
}

function SalesTooltip({
  active,
  label,
  payload,
  series,
  currency,
}: TooltipContentProps & {
  series: TooltipSeries[]
  currency: string
}) {
  if (!active || !payload?.length) return null
  const datum = payload[0]?.payload as Record<string, unknown> | undefined
  if (!datum) return null

  return (
    <div className={styles.chartTooltip}>
      <div className={styles.tooltipMonth}>{formatDate(String(label ?? ''))}</div>
      {series.map(item => {
        const value = datum[item.key]
        return (
          <div className={styles.tooltipRow} key={item.key}>
            <span className={styles.tooltipSwatch} style={{ backgroundColor: item.color }} />
            <span className={styles.tooltipName}>{item.name}</span>
            <span className={styles.tooltipValue}>
              {typeof value === 'number' ? formatMoney(value, currency) : '—'}
            </span>
          </div>
        )
      })}
    </div>
  )
}

const axisTick = {
  fill: 'var(--muted)',
  fontFamily: 'var(--font-ibm-plex-mono), monospace',
  fontSize: 11,
}

const legendStyle = {
  color: 'var(--ink)',
  fontFamily: 'var(--font-nunito-sans), sans-serif',
  fontSize: 12.5,
  paddingBottom: 8,
}

export default function SalesSpendChart({
  points,
  currency,
  showDaily,
  gpPerOrder,
}: {
  points: ChartPoint[]
  currency: string
  showDaily: boolean
  gpPerOrder: number | null
}) {
  if (points.length === 0) {
    return <div className={styles.salesSpendEmpty}>No data</div>
  }

  const rollingSales = rollingAvg(points.map(point => point.sales), ROLL_WIN)
  const rollingSpend = rollingAvg(points.map(point => point.spend), ROLL_WIN)
  const rollingOrders = rollingAvg(points.map(point => point.orders), ROLL_WIN)
  const plot = points.slice(-PLOT_DAYS)
  const salesPlot = rollingSales.slice(-PLOT_DAYS)
  const spendPlot = rollingSpend.slice(-PLOT_DAYS)
  const ordersPlot = rollingOrders.slice(-PLOT_DAYS)
  const gpPlot = gpPerOrder != null
    ? ordersPlot.map((orders, index) => gpPerOrder * orders - spendPlot[index])
    : salesPlot.map((sales, index) => sales - spendPlot[index])
  const gpLabel = gpPerOrder != null ? 'Ad GP (30d)' : 'Ad GP (30d) (rev)'
  const data = plot.map((point, index) => ({
    date: point.date,
    dailySales: point.sales,
    dailySpend: point.spend,
    rollingSales: salesPlot[index],
    rollingSpend: spendPlot[index],
    rollingGP: gpPlot[index],
  }))
  const { domain, ticks } = niceDomain([...salesPlot, ...spendPlot, ...gpPlot])
  const crossesZero = domain[0] < 0 && domain[1] > 0
  const weeklyTicks = data.filter((_, index) => index % 7 === 0).map(point => point.date)
  const series: TooltipSeries[] = [
    ...(showDaily
      ? [
          { key: 'dailySales', name: 'Daily sales', color: 'var(--blue)' },
          { key: 'dailySpend', name: 'Daily spend', color: 'var(--neg)' },
        ]
      : []),
    { key: 'rollingSales', name: 'Sales (30d avg)', color: 'var(--blue)' },
    { key: 'rollingSpend', name: 'Spend (30d avg)', color: 'var(--neg)' },
    { key: 'rollingGP', name: gpLabel, color: 'var(--pos)' },
  ]

  return (
    <ResponsiveContainer width="100%" height={360} minWidth={0}>
      <LineChart data={data} margin={{ top: 12, right: 24, bottom: 8, left: 12 }} accessibilityLayer>
        <CartesianGrid vertical={false} stroke="var(--line)" strokeWidth={1} />
        <XAxis
          dataKey="date"
          ticks={weeklyTicks}
          interval={0}
          axisLine={{ stroke: 'var(--line)', strokeWidth: 1 }}
          tickLine={false}
          tick={axisTick}
          tickFormatter={formatDate}
          tickMargin={9}
        />
        <YAxis
          domain={domain}
          ticks={ticks}
          allowDataOverflow
          axisLine={false}
          tickLine={false}
          tick={axisTick}
          tickFormatter={value => formatAxisMoney(Number(value), currency)}
          width={76}
        />
        <Tooltip
          shared
          cursor={{ stroke: 'var(--line)', strokeWidth: 1 }}
          content={props => <SalesTooltip {...props} series={series} currency={currency} />}
        />
        <Legend
          position="top"
          iconType="plainline"
          iconSize={18}
          itemSorter={null}
          wrapperStyle={legendStyle}
          labelStyle={{ color: 'var(--ink)' }}
        />
        {crossesZero && <ReferenceLine y={0} stroke="var(--ink)" strokeWidth={1.5} />}
        {showDaily && (
          <>
            <Line
              dataKey="dailySales"
              name="Daily sales"
              stroke="var(--blue)"
              strokeWidth={1}
              strokeOpacity={0.25}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
              legendType="none"
              isAnimationActive={false}
            />
            <Line
              dataKey="dailySpend"
              name="Daily spend"
              stroke="var(--neg)"
              strokeWidth={1}
              strokeOpacity={0.25}
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
              legendType="none"
              isAnimationActive={false}
            />
          </>
        )}
        <Line
          dataKey="rollingSales"
          name="Sales (30d avg)"
          stroke="var(--blue)"
          strokeWidth={1.75}
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
          isAnimationActive={false}
        />
        <Line
          dataKey="rollingSpend"
          name="Spend (30d avg)"
          stroke="var(--neg)"
          strokeWidth={1.75}
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
          isAnimationActive={false}
        />
        <Line
          dataKey="rollingGP"
          name={gpLabel}
          stroke="var(--pos)"
          strokeWidth={1.75}
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
