// Plain-language wording for engine recommendations on the Decisions page.
// Display only: the rows, their evidence and the push scripts are unchanged.

export interface DecisionEvidence {
  spend?: number
  clicks?: number
  orders?: number
  sales?: number
  window_start?: string
  window_end?: string
  current_bid?: number
  proposed_bid?: number
  approved_bid?: number
  budget_amount?: number
  proposed_budget?: number
  rule_track_record?: { win_rate: number | null; n: number } | null
}

export interface DecisionInput {
  recType: string
  targetText: string
  proposal: string
  campaignName: string | null
  evidence: DecisionEvidence
  // Formatting comes from the caller (lib/amazon/yardstick) so this file has no imports.
  money: (v: number) => string
  count: (v: number) => string
}

export interface DecisionView {
  kind: string
  title: string
  why: string
  stats: { k: string; v: string }[]
  track: string
  takesBid: boolean
  needsAsin: boolean
}

// Group headings, in the order the page shows them.
export const KIND_ORDER = [
  'Stop a search', 'Stop a product target', 'Change a bid', 'Add a keyword', 'Target a product',
  'Change a budget', 'Pause a campaign', 'Swap an edition', 'New campaign', 'Targeting idea', 'December rule', 'Other',
]

const KIND: Record<string, string> = {
  NEGATE_TERM: 'Stop a search',
  NEGATE_TARGET: 'Stop a product target',
  BID_ADJUST: 'Change a bid',
  PROMOTE_TERM: 'Add a keyword',
  PROMOTE_ASIN: 'Target a product',
  BUDGET_ADJUST: 'Change a budget',
  PAUSE_CAMPAIGN: 'Pause a campaign',
  REPLACE_PRODUCT_AD: 'Swap an edition',
  CREATE_STRUCTURE: 'New campaign',
  CREATIVE_KEYWORD: 'Targeting idea',
  CREATIVE_TARGET: 'Targeting idea',
  SEASONAL_BUDGET_RULE: 'December rule',
}

const BID_TYPES = new Set(['BID_ADJUST', 'PROMOTE_ASIN', 'PROMOTE_TERM'])

function n(v: unknown): number | null {
  const x = typeof v === 'string' ? Number(v) : v
  return typeof x === 'number' && Number.isFinite(x) ? x : null
}

function q(text: string): string {
  return `“${text.replace(/^\[REVIEW\]\s*/i, '').trim()}”`
}

function days(ev: DecisionEvidence): number | null {
  if (!ev.window_start || !ev.window_end) return null
  const a = Date.parse(ev.window_start.slice(0, 10))
  const b = Date.parse(ev.window_end.slice(0, 10))
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  return Math.round((b - a) / 86400000) + 1
}

// The proposal minus its leading "Verb 'thing':" head, so the why-line does not repeat the title.
function whyFrom(proposal: string): string {
  const i = proposal.indexOf(': ')
  const body = i > 0 && i < 120 ? proposal.slice(i + 2) : proposal
  const t = body.trim()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : ''
}

export function describe(d: DecisionInput): DecisionView {
  const ev = d.evidence ?? {}
  const m = (v: number | null) => (v == null ? '—' : d.money(v))
  const count = d.count
  const where = d.campaignName ? ` in ${d.campaignName}` : ''
  const curBid = n(ev.current_bid)
  const propBid = n(ev.approved_bid) ?? n(ev.proposed_bid)
  const budget = n(ev.budget_amount)
  const propBudget = n(ev.proposed_budget)

  let title: string
  switch (d.recType) {
    case 'NEGATE_TERM':
      title = `Stop showing ads for ${q(d.targetText)}${where}`
      break
    case 'NEGATE_TARGET':
      title = `Stop showing ads on product ${d.targetText.toUpperCase()}${where}`
      break
    case 'BID_ADJUST': {
      const dir = curBid != null && propBid != null && propBid > curBid ? 'Raise' : 'Lower'
      title = curBid != null && propBid != null
        ? `${dir} the bid on ${q(d.targetText)} from ${m(curBid)} to ${m(propBid)}`
        : `${dir} the bid on ${q(d.targetText)}`
      break
    }
    case 'PROMOTE_TERM':
      title = `Add ${q(d.targetText)} as a keyword${propBid != null ? ` at ${m(propBid)}` : ''}`
      break
    case 'PROMOTE_ASIN':
      title = `Target product ${d.targetText.toUpperCase()}${propBid != null ? ` at ${m(propBid)}` : ''}`
      break
    case 'BUDGET_ADJUST':
      title = budget != null && propBudget != null
        ? `${propBudget > budget ? 'Raise' : 'Lower'} the daily budget${where} from ${m(budget)} to ${m(propBudget)}`
        : `Change the daily budget${where}`
      break
    case 'PAUSE_CAMPAIGN':
      title = `Pause ${d.campaignName ?? 'this campaign'}`
      break
    case 'REPLACE_PRODUCT_AD':
      title = `Swap the advertised edition${where}`
      break
    case 'CREATE_STRUCTURE':
      title = `Set up a new campaign for ${q(d.targetText)}`
      break
    case 'CREATIVE_KEYWORD':
    case 'CREATIVE_TARGET':
      title = `New targeting idea: ${q(d.targetText)}`
      break
    case 'SEASONAL_BUDGET_RULE':
      title = `December budget rule${where}`
      break
    default:
      title = d.proposal || d.targetText
  }

  const spend = n(ev.spend)
  const clicks = n(ev.clicks)
  const orders = n(ev.orders)
  const span = days(ev)
  const stats = [
    { k: span ? `Spend · ${span} days` : 'Spend', v: m(spend) },
    { k: 'Clicks', v: clicks == null ? '—' : count(clicks) },
    { k: 'Orders', v: orders == null ? '—' : count(orders) },
    { k: 'Per order', v: spend != null && orders != null && orders > 0 ? m(spend / orders) : '—' },
  ]

  const tr = ev.rule_track_record
  let track = 'No track record for this kind of change yet'
  if (tr && typeof tr.n === 'number' && tr.n > 0) {
    const rate = tr.win_rate == null ? null : tr.win_rate <= 1 ? tr.win_rate * 100 : tr.win_rate
    track = tr.n < 10 || rate == null
      ? `Too few judged to say (${count(tr.n)} so far)`
      : `Changes like this worked ${Math.round(rate)}% of the time (${count(tr.n)} judged)`
  }

  return {
    kind: KIND[d.recType] ?? 'Other',
    title,
    why: whyFrom(d.proposal),
    stats,
    track,
    takesBid: BID_TYPES.has(d.recType),
    needsAsin: d.recType === 'CREATIVE_TARGET',
  }
}
