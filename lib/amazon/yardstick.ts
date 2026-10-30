// One yardstick for every Amazon page (Christian, 30 Oct 2026).
// Unit-basis markets (gp_per_order set) are judged on cost per order against the
// margin per order; profit after ads = orders × margin − spend.
// Revenue-basis markets (no margin set yet) are judged on ACoS against target_acos.
// Display only: nothing here feeds the engine.

export type Tone = 'pay' | 'even' | 'lose' | 'off'

export interface Judgement {
  basis: 'unit' | 'revenue'
  tone: Tone
  label: string
  costPerOrder: number | null
  acos: number | null
  profitAfterAds: number | null
  ratio: number | null
}

export interface JudgeInput {
  spend: number
  sales: number
  orders: number
  gpPerOrder: number | null
  targetAcos: number | null
}

// Below this spend a verdict is noise.
export const THIN_SPEND = 10
// Within ±5% of the margin (or the ACoS target) counts as break-even.
export const EVEN_BAND = 0.05

export function judge(input: JudgeInput): Judgement {
  const spend = Number(input.spend) || 0
  const sales = Number(input.sales) || 0
  const orders = Number(input.orders) || 0
  const costPerOrder = orders > 0 ? spend / orders : null
  const acos = sales > 0 ? spend / sales : null
  const gp = input.gpPerOrder

  if (gp != null && gp > 0) {
    const profitAfterAds = orders * gp - spend
    const ratio = costPerOrder != null ? costPerOrder / gp : null
    const base = { basis: 'unit' as const, costPerOrder, acos, profitAfterAds, ratio }
    if (spend <= 0) return { ...base, tone: 'off', label: 'No spend' }
    if (orders === 0) {
      return spend >= THIN_SPEND
        ? { ...base, tone: 'lose', label: 'No orders' }
        : { ...base, tone: 'off', label: 'Too little data' }
    }
    if (spend < THIN_SPEND || ratio == null) return { ...base, tone: 'off', label: 'Too little data' }
    if (ratio <= 1 - EVEN_BAND) return { ...base, tone: 'pay', label: 'Paying' }
    if (ratio <= 1 + EVEN_BAND) return { ...base, tone: 'even', label: 'Break-even' }
    return { ...base, tone: 'lose', label: 'Losing' }
  }

  const target = input.targetAcos
  const ratio = acos != null && target != null && target > 0 ? acos / target : null
  const base = { basis: 'revenue' as const, costPerOrder, acos, profitAfterAds: null, ratio }
  if (spend <= 0) return { ...base, tone: 'off', label: 'No spend' }
  if (sales <= 0) {
    return spend >= THIN_SPEND
      ? { ...base, tone: 'lose', label: 'No sales' }
      : { ...base, tone: 'off', label: 'Too little data' }
  }
  if (target == null || target <= 0) return { ...base, tone: 'off', label: 'No target set' }
  if (spend < THIN_SPEND || ratio == null) return { ...base, tone: 'off', label: 'Too little data' }
  if (ratio <= 1 - EVEN_BAND) return { ...base, tone: 'pay', label: 'On target' }
  if (ratio <= 1 + EVEN_BAND) return { ...base, tone: 'even', label: 'Near target' }
  return { ...base, tone: 'lose', label: 'Over target' }
}

const SYMBOL: Record<string, string> = { EUR: '€', USD: 'US$', MXN: 'MX$', CAD: 'CA$', GBP: '£' }

export function currencySymbol(currency: string): string {
  return SYMBOL[currency] ?? currency
}

function num(v: number, decimals: number): string {
  return Math.abs(v).toLocaleString('de-DE', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

// Money in one market's currency, European style: "2.890 €", "6,52 US$", "−356 US$".
// Currencies are never added together.
export function money(v: number, currency: string, opts: { decimals?: number; sign?: boolean } = {}): string {
  const d = opts.decimals ?? (Math.abs(v) >= 100 ? 0 : 2)
  const rounded = Number(v.toFixed(d))
  const s = rounded < 0 ? '−' : opts.sign && rounded > 0 ? '+' : ''
  return `${s}${num(rounded, d)} ${currencySymbol(currency)}`
}

// Compact money for chart labels: "95k €", "−10,9k €", "820 €".
export function moneyK(v: number, currency: string, opts: { sign?: boolean } = {}): string {
  const a = Math.abs(v)
  const s = v < 0 ? '−' : opts.sign && v > 0 ? '+' : ''
  if (a < 1000) return `${s}${num(Math.round(a), 0)} ${currencySymbol(currency)}`
  const k = a / 1000
  return `${s}${k.toLocaleString('de-DE', { maximumFractionDigits: k >= 100 ? 0 : 1 })}k ${currencySymbol(currency)}`
}

export function pct(v: number, decimals = 1): string {
  return `${num(v * 100, decimals)}%`
}

export function count(v: number): string {
  return num(Math.round(v), 0)
}

const MARKET_NAME: Record<string, string> = {
  ES: 'Spain', US: 'US', MX: 'Mexico', CA: 'Canada', UK: 'UK', GB: 'UK', DE: 'Germany', FR: 'France', IT: 'Italy',
}

export function marketName(country: string): string {
  return MARKET_NAME[country] ?? country
}

const TYPE_NAME: Record<string, string> = { SP: 'Products', SB: 'Brands', SBV: 'Brand video', SD: 'Display' }

export function adTypeName(label: string): string {
  return TYPE_NAME[label] ?? label
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "Sep 26" for year 2026, month 9.
export function monthLabel(year: number, month: number): string {
  return `${MONTHS[month - 1]} ${String(year).slice(2)}`
}

// "29 Oct" from "2026-10-29".
export function dayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number)
  if (!y || !m || !d) return isoDate
  return `${d} ${MONTHS[m - 1]}`
}
