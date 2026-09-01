'use client'

// Long-term display layer for the already-shaped rolling-12 console and vendor series.
// The values toggle intentionally labels endpoints only; complete monthly detail stays in the tooltip.

import { useState } from 'react'
import {
  Area,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type LabelProps,
  type TooltipContentProps,
} from 'recharts'
import { profileGP } from '../../../lib/scorecard'
import styles from './DashboardZoneOne.module.css'

export interface LongTermPoint {
  label:   string
  spend12: number
  sales12: number
  orders12: number
}

export interface LongTermMarket {
  country:    string
  currency:   string
  gpPerOrder: number | null
  points:     LongTermPoint[]
}

export interface VendorLongTermPoint {
  label:     string
  revenue12: number
  units12:   number
}

export interface VendorLongTermMarket {
  country:  string
  currency: string
  points:   VendorLongTermPoint[]
}

const TAB_ORDER = ['ES', 'US', 'MX', 'UK', 'CA', 'DE', 'FR', 'IT']
const COUNTRY_NAMES: Record<string, string> = {
  CA: 'Canada', DE: 'Germany', ES: 'Spain', FR: 'France',
  IT: 'Italy', MX: 'Mexico', UK: 'United Kingdom', US: 'United States',
}

type ChartValue = number | null | undefined

interface TooltipSeries {
  key: string
  name: string
  color: string
}

function formatMonth(label: string): string {
  const [year, month] = label.split('-').map(Number)
  if (!year || !month) return label
  return `${new Intl.DateTimeFormat('en-US', { month: 'short' }).format(new Date(2000, month - 1, 1))} ${String(year).slice(-2)}`
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
  const formatted = Math.round(Math.abs(value)).toLocaleString('en-US')
  return `${value < 0 ? '−' : ''}${currency} ${formatted}`
}

function formatUnits(value: number): string {
  return Math.round(value).toLocaleString('en-US')
}

function endpointIndexes<T>(data: readonly T[], value: (datum: T) => ChartValue): Set<number> {
  const indexes = data.flatMap((datum, index) => typeof value(datum) === 'number' ? [index] : [])
  if (indexes.length === 0) return new Set()
  return new Set([indexes[0], indexes[indexes.length - 1]])
}

function endpointLabel({
  indexes,
  color,
  offset,
  formatter,
}: {
  indexes: Set<number>
  color: string
  offset: number
  formatter: (value: number) => string
}) {
  const first = Math.min(...indexes)
  const last = Math.max(...indexes)

  return function EndpointLabel({ x, y, value, index }: LabelProps) {
    if (index == null || !indexes.has(index) || x == null || y == null || value == null) return null

    const anchor = first === last ? 'middle' : index === first ? 'start' : 'end'
    return (
      <text
        x={Number(x)}
        y={Number(y) + offset}
        fill={color}
        fontFamily="var(--font-ibm-plex-mono), monospace"
        fontSize={10}
        textAnchor={anchor}
      >
        {formatter(Number(value))}
      </text>
    )
  }
}

function ChartTooltip({
  active,
  label,
  payload,
  series,
  valueFormatter,
}: TooltipContentProps & {
  series: TooltipSeries[]
  valueFormatter: (value: number) => string
}) {
  if (!active || !payload?.length) return null

  const datum = payload[0]?.payload as Record<string, unknown> | undefined
  if (!datum) return null

  return (
    <div className={styles.chartTooltip}>
      <div className={styles.tooltipMonth}>{formatMonth(String(label ?? ''))}</div>
      {series.map(item => {
        const value = datum[item.key]
        return (
          <div className={styles.tooltipRow} key={item.key}>
            <span className={styles.tooltipSwatch} style={{ backgroundColor: item.color }} />
            <span className={styles.tooltipName}>{item.name}</span>
            <span className={styles.tooltipValue}>
              {typeof value === 'number' ? valueFormatter(value) : '—'}
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
  fontSize: 10,
}

const legendStyle = {
  color: 'var(--ink)',
  fontFamily: 'var(--font-nunito-sans), sans-serif',
  fontSize: 12,
  paddingBottom: 8,
}

function RollingChart({
  market,
  vendor,
  showValues,
}: {
  market: LongTermMarket
  vendor?: VendorLongTermMarket
  showValues: boolean
}) {
  if (market.points.length === 0) {
    return <div className={styles.chartEmpty}>No rolling-12 data (need 12 consecutive months)</div>
  }

  const vendorRevenue = vendor?.currency === market.currency
    ? new Map(vendor.points.map(point => [point.label, point.revenue12]))
    : new Map<string, number>()
  const gpLabel = market.gpPerOrder != null ? 'Rolling-12 GP' : 'Rolling-12 GP (rev)'
  const data = market.points.map(point => ({
    label: point.label,
    sales12: point.sales12,
    spend12: point.spend12,
    gp12: profileGP(market.gpPerOrder, point.orders12, point.sales12, point.spend12),
    vendorRevenue12: vendorRevenue.get(point.label),
  }))
  const hasVendorRevenue = data.some(point => typeof point.vendorRevenue12 === 'number')
  const series: TooltipSeries[] = [
    { key: 'sales12', name: 'Rolling-12 Sales', color: 'var(--blue)' },
    { key: 'spend12', name: 'Rolling-12 Spend', color: 'var(--neg)' },
    { key: 'gp12', name: gpLabel, color: 'var(--pos)' },
    ...(hasVendorRevenue
      ? [{ key: 'vendorRevenue12', name: 'Rolling-12 Vendor Revenue (sell-in)', color: '#8A5BB8' }]
      : []),
  ]
  const plottedValues = data.flatMap(point => [
    point.sales12,
    point.spend12,
    point.gp12,
    ...(typeof point.vendorRevenue12 === 'number' ? [point.vendorRevenue12] : []),
  ])
  const crossesZero = Math.min(...plottedValues) < 0 && Math.max(...plottedValues) > 0
  const money = (value: number) => formatMoney(value, market.currency)

  return (
    <div className={styles.longTermChart}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 8 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--line)" strokeWidth={1} />
          <XAxis
            dataKey="label"
            axisLine={{ stroke: 'var(--line)', strokeWidth: 1 }}
            tickLine={false}
            tick={axisTick}
            tickFormatter={formatMonth}
            tickMargin={9}
            minTickGap={24}
            interval="preserveStartEnd"
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={axisTick}
            tickFormatter={value => formatAxisMoney(Number(value), market.currency)}
            width={76}
          />
          <Tooltip
            shared
            cursor={{ stroke: 'var(--line)', strokeWidth: 1 }}
            content={props => <ChartTooltip {...props} series={series} valueFormatter={money} />}
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
          <Line
            dataKey="sales12"
            name="Rolling-12 Sales"
            stroke="var(--blue)"
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
            label={showValues ? endpointLabel({
              indexes: endpointIndexes(data, point => point.sales12),
              color: 'var(--blue)',
              offset: -8,
              formatter: money,
            }) : false}
          />
          <Line
            dataKey="spend12"
            name="Rolling-12 Spend"
            stroke="var(--neg)"
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
            label={showValues ? endpointLabel({
              indexes: endpointIndexes(data, point => point.spend12),
              color: 'var(--neg)',
              offset: 14,
              formatter: money,
            }) : false}
          />
          <Line
            dataKey="gp12"
            name={gpLabel}
            stroke="var(--pos)"
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
            label={showValues ? endpointLabel({
              indexes: endpointIndexes(data, point => point.gp12),
              color: 'var(--pos)',
              offset: 14,
              formatter: money,
            }) : false}
          />
          {hasVendorRevenue && (
            <Line
              dataKey="vendorRevenue12"
              name="Rolling-12 Vendor Revenue (sell-in)"
              stroke="#8A5BB8"
              strokeWidth={1.75}
              strokeDasharray="6 4"
              connectNulls
              dot={false}
              activeDot={{ r: 3, strokeWidth: 0 }}
              isAnimationActive={false}
              label={showValues ? endpointLabel({
                indexes: endpointIndexes(data, point => point.vendorRevenue12),
                color: '#8A5BB8',
                offset: -8,
                formatter: money,
              }) : false}
            />
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function UnitsPanel({
  market,
  vendor,
  showValues,
}: {
  market: LongTermMarket
  vendor: VendorLongTermMarket
  showValues: boolean
}) {
  const vendorPoints = new Map(vendor.points.map(point => [point.label, point]))
  const data = market.points.map(point => {
    const vendorPoint = vendorPoints.get(point.label)
    if (!vendorPoint) {
      return {
        label: point.label,
        vendorUnits: undefined,
        attributedUnits: undefined,
        gapBand: undefined,
      }
    }
    const gapBand: [number, number] = [
      Math.min(vendorPoint.units12, point.orders12),
      Math.max(vendorPoint.units12, point.orders12),
    ]
    return {
      label: point.label,
      vendorUnits: vendorPoint.units12,
      attributedUnits: point.orders12,
      gapBand,
    }
  })

  if (!data.some(point => typeof point.vendorUnits === 'number')) return null

  const series: TooltipSeries[] = [
    { key: 'vendorUnits', name: 'Vendor units (sell-in)', color: '#8A5BB8' },
    { key: 'attributedUnits', name: 'Attributed orders', color: 'var(--blue)' },
  ]

  return (
    <div className={styles.unitsChart}>
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <LineChart data={data} margin={{ top: 6, right: 10, bottom: 0, left: 8 }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke="var(--line)" strokeWidth={1} />
          <XAxis
            dataKey="label"
            axisLine={{ stroke: 'var(--line)', strokeWidth: 1 }}
            tickLine={false}
            tick={axisTick}
            tickFormatter={formatMonth}
            tickMargin={9}
            minTickGap={24}
            interval="preserveStartEnd"
          />
          <YAxis
            axisLine={false}
            tickLine={false}
            tick={axisTick}
            tickFormatter={value => compactNumber(Number(value))}
            allowDecimals={false}
            width={76}
          />
          <Tooltip
            shared
            cursor={{ stroke: 'var(--line)', strokeWidth: 1 }}
            content={props => <ChartTooltip {...props} series={series} valueFormatter={formatUnits} />}
          />
          <Legend
            position="top"
            iconType="plainline"
            iconSize={18}
            itemSorter={null}
            wrapperStyle={legendStyle}
            labelStyle={{ color: 'var(--ink)' }}
          />
          <Area
            dataKey="gapBand"
            name="Gap"
            fill="#8A5BB8"
            fillOpacity={0.06}
            stroke="none"
            dot={false}
            activeDot={false}
            legendType="none"
            tooltipType="none"
            isAnimationActive={false}
          />
          <Line
            dataKey="vendorUnits"
            name="Vendor units (sell-in)"
            stroke="#8A5BB8"
            strokeWidth={1.75}
            strokeDasharray="6 4"
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
            label={showValues ? endpointLabel({
              indexes: endpointIndexes(data, point => point.vendorUnits),
              color: '#8A5BB8',
              offset: -8,
              formatter: formatUnits,
            }) : false}
          />
          <Line
            dataKey="attributedUnits"
            name="Attributed orders"
            stroke="var(--blue)"
            strokeWidth={1.75}
            dot={false}
            activeDot={{ r: 3, strokeWidth: 0 }}
            isAnimationActive={false}
            label={showValues ? endpointLabel({
              indexes: endpointIndexes(data, point => point.attributedUnits),
              color: 'var(--blue)',
              offset: 14,
              formatter: formatUnits,
            }) : false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function LongTermSection({
  markets,
  vendorMarkets,
}: {
  markets: LongTermMarket[]
  vendorMarkets: VendorLongTermMarket[]
}) {
  const active = TAB_ORDER
    .map(country => markets.find(market => market.country === country))
    .filter((market): market is LongTermMarket => !!market && market.points.length > 0)

  const [tab, setTab] = useState(active[0]?.country ?? 'ES')
  const [showValues, setShowValues] = useState(false)
  const current = active.find(market => market.country === tab) ?? active[0]
  const currentVendor = vendorMarkets.find(market => market.country === current?.country)

  if (!current) return null

  const latestVendorPoint = currentVendor?.points.at(-1)
  const latestConsolePoint = latestVendorPoint
    ? current.points.find(point => point.label === latestVendorPoint.label)
    : undefined
  const unitsCaption = latestVendorPoint && latestConsolePoint
    ? `Amazon bought ${Math.round(latestVendorPoint.units12).toLocaleString('en-US')} books; ads claim ${Math.round(latestConsolePoint.orders12).toLocaleString('en-US')} orders. The gap is the rest of your business.`
    : 'Amazon sell-in and attributed orders, shown separately. The gap is the rest of your business.'

  return (
    <div className={styles.chartSection}>
      <div className={styles.chartTabs}>
        {active.map(market => {
          const isActive = market.country === tab
          return (
            <button
              key={market.country}
              onClick={() => setTab(market.country)}
              className={`${styles.chartTab} ${isActive ? styles.chartTabActive : ''}`}
            >
              {market.country}
            </button>
          )
        })}
        <label className={styles.chartToggle}>
          <input
            type="checkbox"
            checked={showValues}
            onChange={event => setShowValues(event.target.checked)}
            className={styles.chartCheckbox}
          />
          values
        </label>
      </div>

      <div className={styles.chartPanel}>
        <h3 className={styles.panelTitle}>{COUNTRY_NAMES[current.country] ?? current.country}, rolling 12 months</h3>
        <div className={styles.panelCaption}>Each point is a full year ending that month — seasonality removed.</div>
        <RollingChart market={current} vendor={currentVendor} showValues={showValues} />
        <div className={styles.panelSource}>sources: console exports (all ad types){currentVendor ? ' · vendor invoices (sell-in)' : ''}</div>
      </div>
      {currentVendor && (
        <div className={styles.chartPanel}>
          <h3 className={styles.panelTitle}>What ads can&apos;t see · {COUNTRY_NAMES[current.country] ?? current.country}</h3>
          <div className={styles.panelCaption}>{unitsCaption}</div>
          <UnitsPanel market={current} vendor={currentVendor} showValues={showValues} />
          <div className={styles.panelSource}>sources: vendor invoices (sell-in) · console exports (all ad types) · read quarterly</div>
        </div>
      )}
    </div>
  )
}
