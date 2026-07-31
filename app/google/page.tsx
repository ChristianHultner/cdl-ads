export const dynamic = 'force-dynamic'

import Link from 'next/link'
import { getGoogleDb } from '@/lib/google/db'

interface Stats {
  camp_total:   number
  camp_enabled: number
  kw_total:     number
  st_rows:      number
  cd_min:       string | null
  cd_max:       string | null
  last_synced:  string | null
}

interface SyncRun {
  run_date:       string
  step_total:     number
  step_ok:        number
  total_rows:     string | null
  all_ok:         boolean
  failed_steps:   string[] | null
  failed_details: string[] | null
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  // date-only strings (YYYY-MM-DD) need explicit UTC parse to avoid DST shift
  const d = new Date(iso.length === 10 ? iso + 'T00:00:00Z' : iso)
  return d.toLocaleDateString('en-GB', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-GB', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default async function GooglePage() {
  const sql = getGoogleDb()

  const [stats] = (await sql`
    SELECT
      (SELECT count(*)::int          FROM google_campaigns)                              AS camp_total,
      (SELECT count(*)::int          FROM google_campaigns WHERE status = 'ENABLED')     AS camp_enabled,
      (SELECT count(*)::int          FROM google_keywords)                               AS kw_total,
      (SELECT count(*)::int          FROM google_search_term_daily)                      AS st_rows,
      (SELECT min(date)::text        FROM google_campaign_daily)                         AS cd_min,
      (SELECT max(date)::text        FROM google_campaign_daily)                         AS cd_max,
      (SELECT max(last_synced_at)::text FROM google_campaigns)                           AS last_synced
  `) as unknown as [Stats]

  const syncRuns = (await sql`
    SELECT
      (run_started_at AT TIME ZONE 'Europe/Madrid')::date::text        AS run_date,
      count(*)::int                                                     AS step_total,
      (count(*) FILTER (WHERE ok = true))::int                         AS step_ok,
      coalesce(sum(rows_reported), 0)::text                            AS total_rows,
      (count(*) FILTER (WHERE ok = false)) = 0                         AS all_ok,
      array_agg(step   ORDER BY id) FILTER (WHERE ok = false)          AS failed_steps,
      array_agg(detail ORDER BY id) FILTER (WHERE ok = false)          AS failed_details
    FROM google_sync_log
    WHERE run_started_at >= now() - interval '7 days'
    GROUP BY 1
    ORDER BY 1 DESC
  `) as unknown as SyncRun[]

  return (
    <div>
      <h1>Google Ads</h1>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <StatCard
          label="Campaigns"
          value={String(stats.camp_total)}
          sub={`${stats.camp_enabled} enabled`}
        />
        <StatCard
          label="Keywords"
          value={stats.kw_total.toLocaleString('en-GB')}
        />
        <StatCard
          label="Search Term Rows"
          value={stats.st_rows.toLocaleString('en-GB')}
        />
        <StatCard
          label="Daily Data Span"
          value={`${fmtDate(stats.cd_min)} – ${fmtDate(stats.cd_max)}`}
          mono
        />
        <StatCard
          label="Last Synced"
          value={fmtDateTime(stats.last_synced)}
          mono
        />
      </div>

      <Link
        href="/google/campaigns"
        style={{
          display: 'inline-block',
          padding: '0.5rem 1.25rem',
          background: 'var(--cdl-blue)',
          color: '#fff',
          borderRadius: '6px',
          fontWeight: 700,
          fontSize: '0.9rem',
        }}
      >
        View Campaigns →
      </Link>

      <p
        style={{
          marginTop: '2rem',
          fontSize: '0.8rem',
          color: 'var(--cdl-muted)',
          fontStyle: 'italic',
        }}
      >
        Account signal-dead since 2026-04-30 (epoch). Sole target account: 2199803274.
      </p>

      {/* ── Nightly Sync ─────────────────────────────────────────────── */}
      <h2
        style={{
          marginTop: '2.5rem',
          marginBottom: '1rem',
          fontSize: '1rem',
          fontWeight: 700,
          color: 'var(--cdl-ink)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        Nightly Sync
      </h2>

      {syncRuns.length === 0 ? (
        <p
          style={{
            color: 'var(--cdl-muted)',
            fontStyle: 'italic',
            fontSize: '0.9rem',
          }}
        >
          No sync runs yet.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {syncRuns.map((run) => (
            <div
              key={run.run_date}
              style={{
                border: `1px solid ${run.all_ok ? '#c8dfe9' : '#f5a0a0'}`,
                borderRadius: '8px',
                padding: '0.75rem 1.25rem',
                background: run.all_ok ? 'var(--cdl-sky)' : '#fff0f0',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1.5rem',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontWeight: 700,
                    color: 'var(--cdl-ink)',
                    fontSize: '0.9rem',
                    minWidth: '7rem',
                  }}
                >
                  {fmtDate(run.run_date)}
                </span>
                <span
                  style={{
                    fontSize: '0.85rem',
                    color: run.all_ok ? 'var(--cdl-muted)' : '#c00',
                    fontWeight: run.all_ok ? 400 : 700,
                  }}
                >
                  {run.step_ok}/{run.step_total} steps ok
                </span>
                <span
                  style={{
                    fontSize: '0.85rem',
                    color: 'var(--cdl-muted)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {Number(run.total_rows ?? 0).toLocaleString('en-GB')} rows
                </span>
                {!run.all_ok && (
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontWeight: 700,
                      color: '#c00',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                    }}
                  >
                    FAILED
                  </span>
                )}
              </div>

              {!run.all_ok &&
                run.failed_steps != null &&
                run.failed_steps.length > 0 && (
                  <div
                    style={{
                      marginTop: '0.5rem',
                      fontSize: '0.78rem',
                      color: '#c00',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '0.2rem',
                    }}
                  >
                    {run.failed_steps.map((step, i) => (
                      <div key={step}>
                        <strong>{step}</strong>
                        {run.failed_details?.[i]
                          ? `: ${run.failed_details[i]}`
                          : ''}
                      </div>
                    ))}
                  </div>
                )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  mono,
}: {
  label: string
  value: string
  sub?: string
  mono?: boolean
}) {
  return (
    <div
      style={{
        border: '1px solid #c8dfe9',
        borderRadius: '8px',
        padding: '1rem 1.25rem',
        background: 'var(--cdl-sky)',
      }}
    >
      <div
        style={{
          fontSize: '0.72rem',
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--cdl-muted)',
          marginBottom: '0.35rem',
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: mono ? '0.85rem' : '1.45rem',
          fontWeight: 700,
          color: 'var(--cdl-ink)',
          fontFamily: mono ? 'monospace' : undefined,
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.2,
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: '0.78rem',
            color: 'var(--cdl-muted)',
            marginTop: '0.25rem',
          }}
        >
          {sub}
        </div>
      )}
    </div>
  )
}
