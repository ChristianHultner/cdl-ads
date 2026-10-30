export const dynamic = 'force-dynamic'

import { neon } from '@neondatabase/serverless'
import { money, count, marketName, dayLabel, monthLabel } from '@/lib/amazon/yardstick'
import s from '../ui.module.css'

type StepRow = { step: string; at: string; ok: boolean | null; rows_reported: number | null; detail: string | null }
type CoverRow = { country_code: string; kind: string; last: string | null }
type MonthRow = { market: string; year: number; month: number; source?: string }
type ProfileRow = {
  profile_id: string; country_code: string; currency_code: string; region: string; is_active: boolean
  gp_per_order: number | null; target_acos: number | null; enabled: number; total: number
}
type ReqRow = { report_type: string; country_code: string; status: string; requested_at: string; error: string | null }

const STEP: Record<string, [string, string]> = {
  'request-reports': ['Ask Amazon for reports', 'Yesterday’s figures, all ad types, every active market'],
  'structure': ['Campaign list', 'New, paused and changed campaigns'],
  'sweep': ['Clean-up', 'Marks campaigns Amazon has archived'],
  'ingest-reports': ['Collect reports', 'Downloads the reports once Amazon has them'],
  'rollup': ['Daily totals', 'Builds the per-market day figures the pages read'],
  'stamp': ['Outcomes', 'Grades changes that reached 7, 14 and 30 days'],
}
const STEP_ORDER = ['request-reports', 'structure', 'sweep', 'ingest-reports', 'rollup', 'stamp']
const KIND_COLS = [['SP', 'Products'], ['SB', 'Brands'], ['SB_LEGACY', 'Brands (old)'], ['SD', 'Display']] as const

function madrid(ts: string): string {
  return new Date(ts).toLocaleString('en-GB', { timeZone: 'Europe/Madrid', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

// Plain words for what went wrong; the raw text stays in the technical detail.
function explain(detail: string | null): string {
  const d = detail ?? ''
  if (/\b429\b/.test(d)) return 'Amazon asked us to slow down for one report; the next nights ask for those days again.'
  if (/timeout|PARTIAL/i.test(d)) return 'The step ran out of time; the next run picks up the rest.'
  return 'See the technical detail below.'
}

export default async function HealthPage() {
  const sql = neon(process.env.DATABASE_URL!)
  const [steps, cover, consoleMax, vendorMax, profiles, requests] = (await Promise.all([
    sql`
      SELECT DISTINCT ON (step) step, run_started_at::text AS at, ok, rows_reported, left(coalesce(detail, ''), 300) AS detail
      FROM amazon_sync_log
      WHERE run_started_at >= now() - interval '30 hours'
      ORDER BY step, run_started_at DESC
    `,
    sql`
      SELECT p.country_code, 'SP' AS kind, max(d.date)::text AS last
      FROM amazon_campaign_daily d JOIN amazon_profiles p ON p.profile_id = d.profile_id
      WHERE p.is_active GROUP BY p.country_code
      UNION ALL
      SELECT p.country_code, o.ad_product AS kind, max(o.date)::text AS last
      FROM amazon_campaign_daily_other o JOIN amazon_profiles p ON p.profile_id = o.profile_id
      WHERE p.is_active GROUP BY p.country_code, o.ad_product
    `,
    sql`
      SELECT DISTINCT ON (market) market, year, month, source
      FROM console_history ORDER BY market, year DESC, month DESC
    `,
    sql`
      SELECT DISTINCT ON (market) market, year, month
      FROM vendor_history ORDER BY market, year DESC, month DESC
    `,
    sql`
      SELECT p.profile_id::text, p.country_code, p.currency_code, p.region, p.is_active,
        p.gp_per_order::float AS gp_per_order, p.target_acos::float AS target_acos,
        (SELECT count(*)::int FROM amazon_campaigns c WHERE c.profile_id = p.profile_id AND c.state = 'ENABLED') AS enabled,
        (SELECT count(*)::int FROM amazon_campaigns c WHERE c.profile_id = p.profile_id) AS total
      FROM amazon_profiles p
      ORDER BY p.is_active DESC, coalesce(array_position(ARRAY['ES','US','MX','UK','CA'], p.country_code), 99), p.country_code
    `,
    sql`
      SELECT r.report_type, p.country_code, r.status, r.requested_at::text, left(coalesce(r.error, ''), 160) AS error
      FROM amazon_report_requests r JOIN amazon_profiles p ON p.profile_id = r.profile_id
      ORDER BY r.requested_at DESC
      LIMIT 25
    `,
  ])) as unknown as [StepRow[], CoverRow[], MonthRow[], MonthRow[], ProfileRow[], ReqRow[]]

  const ordered = STEP_ORDER.map(k => steps.find(r => r.step === k)).filter((r): r is StepRow => !!r)
    .concat(steps.filter(r => !STEP_ORDER.includes(r.step)))
  const bad = ordered.filter(r => r.ok === false)
  const missing = STEP_ORDER.filter(k => !steps.some(r => r.step === k))
  const allGood = bad.length === 0 && missing.length === 0

  const active = profiles.filter(p => p.is_active)
  const countries = [...new Set(active.map(p => p.country_code))]
  const coverOf = (c: string, k: string) => cover.find(r => r.country_code === c && r.kind === k)?.last ?? null
  const latestSp = cover.filter(r => r.kind === 'SP').map(r => r.last).filter(Boolean).sort().pop() ?? null

  return (
    <main className={s.main}>
      <div>
        <div className={s.eyebrow}>Amazon ads</div>
        <h1 className={s.h1}>Data health</h1>
        <div className={s.lede}>Can the numbers on the other pages be trusted today?</div>
      </div>

      <section className={allGood ? s.healthOk : s.healthWarn}>
        <div className={s.healthTitle}>{allGood ? 'All good' : bad.length > 0 ? `${count(bad.length)} step${bad.length === 1 ? '' : 's'} had a problem last night` : 'Some steps did not run'}</div>
        <div>
          {allGood
            ? `Last night’s ${count(ordered.length)} steps all ran. Ad data runs to ${latestSp ? dayLabel(latestSp) : '—'}.`
            : bad.length > 0
              ? bad.map(b => `${STEP[b.step]?.[0] ?? b.step}: ${explain(b.detail)}`).join(' ')
              : `No run in the last 30 hours for: ${missing.map(m => STEP[m]?.[0] ?? m).join(', ')}.`}
        </div>
      </section>

      <section className={s.card}>
        <h2 className={s.h2} style={{ marginBottom: 12 }}>Last night</h2>
        <div className={s.tableBox}>
          <div style={{ minWidth: 720 }}>
            <div className={s.thead} style={{ gridTemplateColumns: '200px minmax(0,1fr) 130px 140px' }}>
              <span>Step</span><span>What it does</span><span>Ran (Madrid)</span><span className={s.right}>Result</span>
            </div>
            {ordered.map(r => (
              <div key={r.step} className={s.trow} style={{ gridTemplateColumns: '200px minmax(0,1fr) 130px 140px' }}>
                <span className={s.strong}>{STEP[r.step]?.[0] ?? r.step}</span>
                <span className={s.note} style={{ fontSize: 14 }}>{STEP[r.step]?.[1] ?? ''}</span>
                <span className={s.tn}>{madrid(r.at)}</span>
                <span className={s.right}><span className={`${s.chip} ${r.ok === false ? s.lose : r.ok ? s.pay : s.off}`}>{r.ok === false ? 'Problem' : r.ok ? (r.rows_reported != null ? `ok · ${count(r.rows_reported)}` : 'ok') : 'Running'}</span></span>
              </div>
            ))}
            {missing.map(k => (
              <div key={k} className={s.trow} style={{ gridTemplateColumns: '200px minmax(0,1fr) 130px 140px' }}>
                <span className={s.strong}>{STEP[k][0]}</span><span className={s.note} style={{ fontSize: 14 }}>{STEP[k][1]}</span><span>—</span>
                <span className={s.right}><span className={`${s.chip} ${s.even}`}>Not run</span></span>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className={s.card}>
        <h2 className={s.h2} style={{ marginBottom: 4 }}>Data complete to</h2>
        <div className={s.note} style={{ marginBottom: 12 }}>Latest day held for each market and ad type. A dash means that market runs none of that type.</div>
        <div className={s.tableBox}>
          <div style={{ minWidth: 760 }}>
            <div className={s.thead} style={{ gridTemplateColumns: '140px repeat(4, minmax(0,1fr)) 150px 150px' }}>
              <span>Market</span>{KIND_COLS.map(([, l]) => <span key={l}>{l}</span>)}<span>Monthly ad history</span><span>Amazon’s purchases</span>
            </div>
            {countries.map(c => {
              const ch = consoleMax.find(r => r.market === c)
              const vh = vendorMax.find(r => r.market === c)
              return (
                <div key={c} className={s.trow} style={{ gridTemplateColumns: '140px repeat(4, minmax(0,1fr)) 150px 150px' }}>
                  <span className={s.strong}>{marketName(c)}</span>
                  {KIND_COLS.map(([k]) => { const d = coverOf(c, k); return <span key={k} className={s.tn}>{d ? dayLabel(d) : '—'}</span> })}
                  <span className={s.tn}>{ch ? monthLabel(ch.year, ch.month) : '—'}</span>
                  <span className={s.tn}>{vh ? monthLabel(vh.year, vh.month) : '—'}</span>
                </div>
              )
            })}
          </div>
        </div>
        <div className={s.foot} style={{ marginTop: 10 }}>“Brands (old)” are the campaigns Amazon still reports through its older interface. Monthly ad history is written on the 2nd for the month before. Amazon’s purchases come from vendor invoices (Spain) and Ingram (US).</div>
      </section>

      <section className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h2 className={s.h2}>Markets</h2>
        {profiles.map(p => (
          <div key={p.profile_id} style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, borderTop: '1px solid #E3F1F8', paddingTop: 10 }}>
            <span style={{ fontWeight: 700 }}>{marketName(p.country_code)}</span>
            <span className={s.note} style={{ fontSize: 14 }}>
              {p.is_active
                ? `active · ${count(p.enabled)} of ${count(p.total)} campaigns on · ${p.gp_per_order != null ? `margin ${money(p.gp_per_order, p.currency_code, { decimals: 2 })} per order` : p.target_acos != null ? `judged on ACoS, target ${Math.round(p.target_acos * 100)}%` : 'no target set'}`
                : 'parked'}
            </span>
          </div>
        ))}
      </section>

      <section className={s.card} style={{ paddingTop: 8, paddingBottom: 8 }}>
        <details>
          <summary style={{ cursor: 'pointer', padding: '16px 0', fontWeight: 800, minHeight: 44 }}>Technical detail: step messages, latest report requests, profile IDs</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 18, fontSize: 13 }}>
            <div>
              <div className={s.label}>Step messages (last 30 hours)</div>
              {ordered.map(r => <div key={r.step} className={s.tn} style={{ overflowWrap: 'anywhere' }}><b>{r.step}</b> · {madrid(r.at)} · {r.detail || '—'}</div>)}
            </div>
            <div>
              <div className={s.label}>Latest report requests</div>
              {requests.map((r, i) => <div key={i} className={s.tn} style={{ overflowWrap: 'anywhere' }}>{madrid(r.requested_at)} · {r.country_code} · {r.report_type} · {r.status}{r.error ? ` · ${r.error}` : ''}</div>)}
            </div>
            <div>
              <div className={s.label}>Profiles</div>
              {profiles.map(p => <div key={p.profile_id} className={s.tn}>{p.profile_id} · {p.country_code} · {p.currency_code} · {p.region} · {p.is_active ? 'active' : 'parked'}</div>)}
            </div>
          </div>
        </details>
      </section>
    </main>
  )
}
