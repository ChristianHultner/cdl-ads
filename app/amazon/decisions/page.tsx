export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { neon } from '@neondatabase/serverless'
import { describe, KIND_ORDER, type DecisionEvidence } from '@/lib/amazon/decisions'
import { money, count, marketName, dayLabel } from '@/lib/amazon/yardstick'
import { PushAllButton, type ProfileMeta } from '../recommendations/PushAllButton'
import { approveDecision, rejectDecision, approveMany, undoApproval } from './actions'
import s from '../ui.module.css'

type Row = {
  id: number; rec_type: string; target_text: string; proposal: string; status: string
  created_at: string; pushed_at: string | null; country_code: string; currency_code: string
  profile_id: string; evidence: DecisionEvidence | null; campaign_name: string | null
  campaign_id: string | null
}

const TABS = [
  { key: 'waiting', label: 'Waiting', status: 'DRAFT' },
  { key: 'approved', label: 'Approved, not sent', status: 'APPROVED' },
  { key: 'sent', label: 'Sent · 30 days', status: 'PUSHED' },
] as const

export default async function DecisionsPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const sp = await searchParams
  const tabKey = typeof sp.tab === 'string' && TABS.some(t => t.key === sp.tab) ? sp.tab : 'waiting'
  const tab = TABS.find(t => t.key === tabKey) ?? TABS[0]
  const market = typeof sp.market === 'string' && /^[A-Z]{2}$/.test(sp.market) ? sp.market : 'all'

  const sql = neon(process.env.DATABASE_URL!)
  const [rows, expRows, seasonRows] = (await Promise.all([
    sql`
      SELECT r.id, r.rec_type, r.target_text, r.proposal, r.status, r.created_at::text, r.pushed_at::text,
        p.country_code, p.currency_code, r.profile_id::text, r.evidence,
        c.name AS campaign_name, c.campaign_id::text AS campaign_id
      FROM recommendations r
      JOIN amazon_profiles p ON p.profile_id = r.profile_id
      LEFT JOIN amazon_ad_groups ag
        ON ag.ad_group_id::text = (r.evidence->>'destination_ad_group_id') AND ag.profile_id = r.profile_id
      LEFT JOIN amazon_campaigns c
        ON c.profile_id = r.profile_id
       AND c.campaign_id::text = COALESCE(
             r.campaign_id::text,
             r.evidence->>'campaign_id',
             r.evidence->'resolved_destination'->>'campaign_id',
             ag.campaign_id::text,
             CASE WHEN r.rec_type IN ('PAUSE_CAMPAIGN', 'BUDGET_ADJUST') THEN r.target_text END)
      WHERE r.status IN ('DRAFT', 'APPROVED')
         OR (r.status = 'PUSHED' AND r.pushed_at >= now() - interval '30 days')
      ORDER BY r.created_at DESC, r.id DESC
    `,
    sql`
      SELECT name, market, (started_at + make_interval(days => horizon_days))::date::text AS verdict_at
      FROM experiments WHERE status = 'LIVE' AND started_at IS NOT NULL
      ORDER BY started_at + make_interval(days => horizon_days)
    `,
    sql`SELECT count(*)::int AS n FROM recommendations WHERE rec_type = 'SEASONAL_BUDGET_RULE' AND status = 'PUSHED'`,
  ])) as unknown as [Row[], { name: string; market: string | null; verdict_at: string | null }[], { n: number }[]]

  const inTab = (r: Row, status: string) => r.status === status
  const counts = Object.fromEntries(TABS.map(t => [t.key, rows.filter(r => inTab(r, t.status)).length]))
  const tabRows = rows.filter(r => inTab(r, tab.status))
  const marketsHere = [...new Set(tabRows.map(r => r.country_code))]
  const shown = tabRows.filter(r => market === 'all' || r.country_code === market)

  // Push button: everything approved, per profile (same data the old page passed).
  const approved = rows.filter(r => r.status === 'APPROVED')
  const byProfile = new Map<string, { count: number; country: string }>()
  for (const r of approved) {
    const e = byProfile.get(r.profile_id) ?? { count: 0, country: r.country_code }
    e.count++
    byProfile.set(r.profile_id, e)
  }
  const profiles: ProfileMeta[] = [...byProfile.entries()].map(([profileId, v]) => ({ profileId, label: v.country, count: v.count }))
  const approvedByType: Record<string, number> = {}
  for (const r of approved) approvedByType[r.rec_type] = (approvedByType[r.rec_type] ?? 0) + 1

  const href = (t: string, m: string) => `/amazon/decisions?tab=${t}${m !== 'all' ? `&market=${m}` : ''}`
  const backHref = href(tab.key, market)

  const items = shown.map(r => {
    const view = describe({
      recType: r.rec_type, targetText: r.target_text ?? '', proposal: r.proposal ?? '',
      campaignName: r.campaign_name, evidence: r.evidence ?? {},
      money: (v: number) => money(v, r.currency_code, { decimals: 2 }), count,
    })
    return { r, view }
  })
  const groups = KIND_ORDER.map(kind => ({ kind, items: items.filter(x => x.view.kind === kind) })).filter(g => g.items.length > 0)

  return (
    <main className={s.main}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16 }}>
        <div>
          <div className={s.eyebrow}>Amazon ads</div>
          <h1 className={s.h1}>Decisions</h1>
          <div className={s.lede}>Every change the engine proposes, in one queue. Nothing reaches Amazon until you approve it and press Send.</div>
        </div>
      </div>

      <nav aria-label="Decision status" className={s.tabs}>
        {TABS.map(t => (
          <Link key={t.key} href={href(t.key, 'all')} aria-current={t.key === tab.key ? 'page' : undefined}
                className={t.key === tab.key ? s.tabOn : s.tab}>
            {t.label} <span className={s.tn}>{count(counts[t.key] ?? 0)}</span>
          </Link>
        ))}
      </nav>

      {marketsHere.length > 1 ? (
        <div role="group" aria-label="Market" className={s.toggle} style={{ alignSelf: 'flex-start' }}>
          <Link href={href(tab.key, 'all')} className={market === 'all' ? s.toggleOn : s.toggleBtn} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
            All {count(tabRows.length)}
          </Link>
          {marketsHere.map(m => (
            <Link key={m} href={href(tab.key, m)} className={market === m ? s.toggleOn : s.toggleBtn} style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
              {marketName(m)} {count(tabRows.filter(r => r.country_code === m).length)}
            </Link>
          ))}
        </div>
      ) : null}

      <div className={s.row} style={{ alignItems: 'flex-start' }}>
        <div className={s.grow} style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
          {groups.length === 0 ? (
            <section className={s.card}>{tab.key === 'waiting' ? 'Nothing waiting. The engine drafts new changes each morning.' : tab.key === 'approved' ? 'Nothing approved and unsent.' : 'Nothing sent in the last 30 days.'}</section>
          ) : null}
          {groups.map(g => {
            const bulkIds = g.items.filter(x => !x.view.needsAsin).map(x => x.r.id)
            return (
              <section key={g.kind} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className={s.cardHead} style={{ marginBottom: 0 }}>
                  <h2 className={s.h2} style={{ fontSize: 21 }}>{g.kind} <span className={`${s.note} ${s.tn}`} style={{ fontSize: 15 }}>· {count(g.items.length)}</span></h2>
                  {tab.key === 'waiting' && bulkIds.length > 1 ? (
                    <form action={approveMany}>
                      <input type="hidden" name="ids" value={bulkIds.join(',')} />
                      <input type="hidden" name="back" value={backHref} />
                      <button type="submit" className={s.btnGhost}>Approve all {count(bulkIds.length)} as proposed</button>
                    </form>
                  ) : null}
                </div>
                {g.items.map(({ r, view }) => (
                  <article key={r.id} className={r.status === 'APPROVED' ? s.decisionApproved : s.decision}>
                    <div className={s.decisionBody}>
                      <div className={s.eyebrow} style={{ fontSize: 12 }}>{marketName(r.country_code)} · drafted {dayLabel(r.created_at)}</div>
                      <div className={s.decisionTitle}>{view.title}</div>
                      {view.why ? <div style={{ fontSize: 14, color: '#33434D' }}>{view.why}</div> : null}
                      <div className={s.stats4}>
                        {view.stats.map(st => (
                          <div key={st.k}><div className={s.statK}>{st.k}</div><div className={`${s.statV} ${s.tn}`}>{st.v}</div></div>
                        ))}
                      </div>
                      <div className={s.note}>
                        {view.track}
                        {r.campaign_name && r.campaign_id ? (
                          <> · <Link href={`/amazon/campaigns/${r.profile_id}/${r.campaign_id}`} style={{ fontWeight: 700 }}>{r.campaign_name}</Link></>
                        ) : null}
                      </div>
                    </div>
                    <div className={s.decisionActions}>
                      {r.status === 'DRAFT' ? (
                        <>
                          <form action={approveDecision} className={s.decisionForm}>
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="back" value={backHref} />
                            {view.takesBid ? (
                              <label className={s.fieldLabel}>Bid
                                <input name="approved_bid" inputMode="decimal" className={s.field}
                                       defaultValue={r.evidence?.proposed_bid != null ? String(r.evidence.proposed_bid) : ''} />
                              </label>
                            ) : null}
                            {view.needsAsin ? (
                              <label className={s.fieldLabel}>Checked ASIN
                                <input name="asin" required pattern="[0-9]{9}[0-9Xx]|[Bb]0[A-Za-z0-9]{8}" className={s.field} />
                              </label>
                            ) : null}
                            <button type="submit" className={s.btnPrimary}>Approve</button>
                          </form>
                          <form action={rejectDecision} className={s.decisionForm}>
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="back" value={backHref} />
                            <button type="submit" className={s.btnGhost}>Reject</button>
                          </form>
                        </>
                      ) : r.status === 'APPROVED' ? (
                        <>
                          <span className={`${s.chip} ${s.pay}`} style={{ justifyContent: 'center', padding: '10px 14px' }}>Approved · goes with the next send</span>
                          <form action={undoApproval} className={s.decisionForm}>
                            <input type="hidden" name="id" value={r.id} />
                            <input type="hidden" name="back" value={backHref} />
                            <button type="submit" className={s.btnLink}>Undo</button>
                          </form>
                        </>
                      ) : (
                        <span className={`${s.chip} ${s.off}`} style={{ justifyContent: 'center', padding: '10px 14px' }}>Sent {r.pushed_at ? dayLabel(r.pushed_at) : ''}</span>
                      )}
                    </div>
                  </article>
                ))}
              </section>
            )
          })}
        </div>

        <aside className={s.side} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section className={s.sideDark}>
            <div className={s.needsLabel}>Ready to send</div>
            <div className={s.tn} style={{ fontFamily: 'var(--ads-display), Fraunces, Georgia, serif', fontSize: 40, fontWeight: 600, lineHeight: 1 }}>{count(approved.length)}</div>
            <div style={{ fontSize: 14, color: '#D4E4EC' }}>approved changes go to Amazon together, with a receipt for each</div>
            <div className={s.pushBox}>
              <PushAllButton totalApproved={approved.length} profiles={profiles} recTypeCounts={approvedByType} />
            </div>
          </section>

          {expRows.length > 0 ? (
            <section className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <h2 className={s.h2} style={{ fontSize: 21 }}>Tests running</h2>
              {expRows.map(e => (
                <div key={e.name} style={{ borderTop: '1px solid #E3F1F8', paddingTop: 10 }}>
                  <div style={{ fontWeight: 800 }}>{e.name}</div>
                  <div className={s.note}>{e.market ? `${marketName(e.market)} · ` : ''}verdict {e.verdict_at ? dayLabel(e.verdict_at) : 'pending'} · the engine leaves it alone until then</div>
                </div>
              ))}
            </section>
          ) : null}

          {(seasonRows[0]?.n ?? 0) > 0 ? (
            <section className={s.card} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <h2 className={s.h2} style={{ fontSize: 21 }}>December</h2>
              <div style={{ fontSize: 14, color: '#33434D' }}>{count(seasonRows[0].n)} budget rules booked on Amazon. They revert on their own.</div>
            </section>
          ) : null}
        </aside>
      </div>

      <div className={s.foot}>Approve and Reject change only the status here, exactly as before. Send runs the existing push scripts for every approved change.</div>
    </main>
  )
}
