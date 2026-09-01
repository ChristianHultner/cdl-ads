'use client'

// Rolling ACoS remains rolling spend / rolling sales (ratio of sums, never an average of ratios).
// The daily toggle adds the unchanged daily ACoS series behind the rolling line.

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
import type { ChartPoint } from './SalesSpendChart'
import styles from './DashboardZoneOne.module.css'

const PLOT_DAYS = 90
const ROLL_WIN = 30

interface TooltipSeries {
  key: string
  name: string
  color: string
}

function rollingAcosArr(points: ChartPoint[], window: number): (number | null)[] {
  return points.map((_, index) => {
    const start = Math.max(0, index - window + 1)
    const slice = points.slice(start, index + 1)
    const spend = slice.reduce((sum, point) => sum + point.spend, 0)
    const sales = slice.reduce((sum, point) => sum + point.sales, 0)
    return sales > 0 ? spend / sales : null
  })
}

function formatDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function percentScale(peak: number): { max: number; ticks: number[] } {
  const rawMax = Math.min(peak * 1.3, 2.5)
  const desiredStep = rawMax / 4
  const step = [0.05, 0.1, 0.25, 0.5].find(candidate => candidate >= desiredStep) ?? 0.5
  const max = Math.min(2.5, Math.max(step, Math.ceil(rawMax / step) * step))
  const intervals = Math.round(max / step)
  const ticks = Array.from({ length: intervals + 1 }, (_, index) => Number((index * step).toFixed(10)))
  return { max, ticks }
}

function AcosTooltip({
  active,
  label,
  payload,
  series,
}: TooltipContentProps & {
  series: TooltipSeries[]
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
              {typeof value === 'number' ? formatPercent(value) : '—'}
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

export default function AcosChart({
  points,
  targetAcos,
  showDaily,
}: {
  points: ChartPoint[]
  targetAcos: number
  showDaily: boolean
}) {
  if (points.length === 0) {
    return <div className={styles.acosEmpty}>No ACoS data</div>
  }

  const rolling = rollingAcosArr(points, ROLL_WIN)
  const plot = points.slice(-PLOT_DAYS)
  const rollingPlot = rolling.slice(-PLOT_DAYS)
  const validRolling = rollingPlot.filter((value): value is number => value !== null)
  if (validRolling.length === 0) {
    return <div className={styles.acosEmpty}>No ACoS data</div>
  }

  const data = plot.map((point, index) => ({
    date: point.date,
    dailyAcos: point.acos,
    rollingAcos: rollingPlot[index],
  }))
  const { max, ticks } = percentScale(Math.max(...validRolling, targetAcos))
  const weeklyTicks = data.filter((_, index) => index % 7 === 0).map(point => point.date)
  const series: TooltipSeries[] = [
    ...(showDaily ? [{ key: 'dailyAcos', name: 'Daily ACoS', color: 'var(--blue)' }] : []),
    { key: 'rollingAcos', name: 'ACoS (30d)', color: 'var(--blue)' },
  ]

  return (
    <ResponsiveContainer width="100%" height={220} minWidth={0}>
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
          domain={[0, max]}
          ticks={ticks}
          allowDataOverflow
          axisLine={false}
          tickLine={false}
          tick={axisTick}
          tickFormatter={value => `${Math.round(Number(value) * 100)}%`}
          width={58}
        />
        <Tooltip
          shared
          cursor={{ stroke: 'var(--line)', strokeWidth: 1 }}
          content={props => <AcosTooltip {...props} series={series} />}
        />
        <Legend
          position="top"
          iconType="plainline"
          iconSize={18}
          itemSorter={null}
          wrapperStyle={legendStyle}
          labelStyle={{ color: 'var(--ink)' }}
        />
        <ReferenceLine
          y={targetAcos}
          stroke="var(--ink)"
          strokeWidth={1.25}
          strokeDasharray="5 3"
          label={{
            value: `target ${Math.round(targetAcos * 100)}%`,
            position: 'insideTopRight',
            fill: 'var(--muted)',
            fontFamily: 'var(--font-ibm-plex-mono), monospace',
            fontSize: 10.5,
          }}
        />
        {showDaily && (
          <Line
            dataKey="dailyAcos"
            name="Daily ACoS"
            stroke="var(--blue)"
            strokeWidth={1}
            strokeOpacity={0.25}
            connectNulls={false}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            legendType="none"
            isAnimationActive={false}
          />
        )}
        <Line
          dataKey="rollingAcos"
          name="ACoS (30d)"
          stroke="var(--blue)"
          strokeWidth={1.75}
          connectNulls={false}
          dot={false}
          activeDot={{ r: 3, strokeWidth: 0 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
