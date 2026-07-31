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
