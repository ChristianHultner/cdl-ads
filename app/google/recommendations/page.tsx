export const dynamic = 'force-dynamic'

import React from 'react'
import { getGoogleDb } from '@/lib/google/db'
import { approveRec, rejectRec } from './actions'

// ── Types ─────────────────────────────────────────────────────────────────────

interface CountRow {
  state: string
  n:     number
}

interface DraftRec {
  id:            string
  run_id:        string
  rec_type:      string
  entity_key:    string
  action:        Record<string, unknown>
  evidence:      Record<string, unknown>
  why_line:      string
  created_at:    string
  campaign_id:   string | null
  ad_group_id:   string | null
  campaign_name: string | null
  ad_group_name: string | null
}

interface ApprovedRec {
  id:           string
  rec_type:     string
  entity_key:   string
  why_line:     string
  decided_at:   string | null
  decided_note: string | null
}

// ── Label maps ────────────────────────────────────────────────────────────────

const EVIDENCE_LABELS: Record<string, string> = {
  window:       'Window',
  epochs:       'Epochs',
  clicks:       'Clicks',
  cost:         'Cost',
  conv:         'Conversions',
  posterior:    'Posterior',
  'P(below)':   'P(below target)',
  parent_rate:  'Parent rate',
  constituents: 'Constituents',
}

const ACTION_LABELS: Record<string, string> = {
  type:   'Type',
  level:  'Level',
  target: 'Target',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function humanKey(key: string, labels: Record<string, string>): string {
  return labels[key] ?? key
}

function JsonDl({
  obj,
  labels,
}: {
  obj:    Record<string, unknown>
  labels: Record<string, string>
}) {
  const entries = Object.entries(obj)
  if (entries.length === 0) {
    return (
      <p style={{ color: 'var(--cdl-muted)', fontSize: '0.82rem', margin: 0 }}>
        —
      </p>
    )
  }
  return (
    <dl
      style={{
        margin:                0,
        display:               'grid',
        gridTemplateColumns:   'auto 1fr',
        columnGap:             '1rem',
        rowGap:                '0.25rem',
      }}
    >
      {entries.map(([k, v]) => (
        <React.Fragment key={k}>
          <dt
            style={{
              fontWeight:     600,
              fontSize:       '0.75rem',
              color:          'var(--cdl-muted)',
              textTransform:  'uppercase',
              letterSpacing:  '0.05em',
              whiteSpace:     'nowrap',
              alignSelf:      'baseline',
            }}
          >
            {humanKey(k, labels)}
          </dt>
          <dd
            style={{
              margin:      0,
              fontSize:    '0.82rem',
              color:       'var(--cdl-ink)',
              fontFamily:  'monospace',
              wordBreak:   'break-all',
              alignSelf:   'baseline',
            }}
          >
            {typeof v === 'object' && v !== null
              ? JSON.stringify(v)
              : String(v ?? '—')}
          </dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Europe/Madrid',
    day:      '2-digit',
    month:    'short',
    year:     'numeric',
    hour:     '2-digit',
    minute:   '2-digit',
  })
}

function contextLine(rec: DraftRec): string {
  const parts: string[] = [rec.rec_type, rec.entity_key]
  if (rec.campaign_name)     parts.push(`campaign: ${rec.campaign_name}`)
  else if (rec.campaign_id)  parts.push(`campaign_id: ${rec.campaign_id}`)
  if (rec.ad_group_name)     parts.push(`ad group: ${rec.ad_group_name}`)
  else if (rec.ad_group_id)  parts.push(`ad_group_id: ${rec.ad_group_id}`)
  return parts.join(' · ')
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function RecommendationsPage() {
  const sql = getGoogleDb()

  // ── Counts (single grouped query) ─────────────────────────────────────────
  const countRows = (await sql`
    SELECT state, count(*)::int AS n
    FROM google_recommendations
    GROUP BY state
  `) as unknown as CountRow[]

  const cm: Record<string, number> = {}
  for (const r of countRows) cm[r.state] = r.n
  const draftN    = cm['DRAFT']    ?? 0
  const approvedN = cm['APPROVED'] ?? 0
  const rejectedN = cm['REJECTED'] ?? 0
  const pushedN   = cm['PUSHED']   ?? 0

  // ── DRAFT cards ────────────────────────────────────────────────────────────
  const drafts = (await sql`
    SELECT
      r.id::text                                            AS id,
      r.run_id,
      r.rec_type,
      r.entity_key,
      r.action,
      r.evidence,
      r.why_line,
      (r.created_at AT TIME ZONE 'Europe/Madrid')::text     AS created_at,
      r.campaign_id::text                                   AS campaign_id,
      r.ad_group_id::text                                   AS ad_group_id,
      c.name                                                AS campaign_name,
      ag.name                                               AS ad_group_name
    FROM  google_recommendations r
    LEFT  JOIN google_campaigns  c  ON c.campaign_id  = r.campaign_id::text
    LEFT  JOIN google_ad_groups  ag ON ag.ad_group_id = r.ad_group_id
    WHERE r.state = 'DRAFT'
    ORDER BY r.run_id DESC, r.id ASC
  `) as unknown as DraftRec[]

  // ── APPROVED rows ──────────────────────────────────────────────────────────
  const approved = (await sql`
    SELECT
      r.id::text                                            AS id,
      r.rec_type,
      r.entity_key,
      r.why_line,
      (r.decided_at AT TIME ZONE 'Europe/Madrid')::text     AS decided_at,
      r.decided_note
    FROM  google_recommendations r
    WHERE r.state = 'APPROVED'
    ORDER BY r.decided_at DESC NULLS LAST
  `) as unknown as ApprovedRec[]

  return (
    <div>

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <h1>Recommendations</h1>

      {/* ── Counts strip ───────────────────────────────────────────────────── */}
      <div
        style={{
          display:       'flex',
          gap:           '1.5rem',
          flexWrap:      'wrap',
          marginBottom:  '2rem',
          fontSize:      '0.85rem',
          fontWeight:    600,
          color:         'var(--cdl-muted)',
        }}
      >
        <span style={{ color: draftN > 0 ? 'var(--cdl-blue)' : undefined }}>
          DRAFT{' '}
          <strong style={{ color: 'var(--cdl-ink)' }}>{draftN}</strong>
        </span>
        <span>
          APPROVED{' '}
          <strong style={{ color: 'var(--cdl-ink)' }}>{approvedN}</strong>
        </span>
        <span>
          REJECTED{' '}
          <strong style={{ color: 'var(--cdl-ink)' }}>{rejectedN}</strong>
        </span>
        <span>
          PUSHED{' '}
          <strong style={{ color: 'var(--cdl-ink)' }}>{pushedN}</strong>
        </span>
      </div>

      {/* ── DRAFT cards ────────────────────────────────────────────────────── */}
      {drafts.length === 0 ? (
        <p
          style={{
            color:        'var(--cdl-muted)',
            fontStyle:    'italic',
            fontSize:     '0.9rem',
            padding:      '1.5rem',
            background:   'var(--cdl-sky)',
            border:       '1px solid #c8dfe9',
            borderRadius: '8px',
          }}
        >
          No draft recommendations. Engine runs weekly; it stands down until
          the campaign has 5 honest conversions.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          {drafts.map((rec) => (
            <div
              key={rec.id}
              style={{
                border:       '1px solid #c8dfe9',
                borderRadius: '8px',
                padding:      '1.25rem',
                background:   '#fff',
              }}
            >
              {/* Headline */}
              <p
                style={{
                  margin:     '0 0 0.35rem',
                  fontWeight: 700,
                  fontSize:   '1rem',
                  color:      'var(--cdl-ink)',
                  lineHeight: 1.3,
                }}
              >
                {rec.why_line}
              </p>

              {/* Context line */}
              <p
                style={{
                  margin:     '0 0 1rem',
                  fontSize:   '0.8rem',
                  color:      'var(--cdl-muted)',
                  fontFamily: 'monospace',
                }}
              >
                {contextLine(rec)}
              </p>

              {/* Evidence + Destination panels */}
              <div
                style={{
                  display:             'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap:                 '1rem',
                  marginBottom:        '1rem',
                }}
              >
                {/* EVIDENCE */}
                <div
                  style={{
                    background:   'var(--cdl-sky)',
                    border:       '1px solid #c8dfe9',
                    borderRadius: '6px',
                    padding:      '0.75rem 1rem',
                  }}
                >
                  <div
                    style={{
                      fontSize:      '0.7rem',
                      fontWeight:    700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.07em',
                      color:         'var(--cdl-muted)',
                      marginBottom:  '0.5rem',
                    }}
                  >
                    Evidence
                  </div>
                  <JsonDl obj={rec.evidence} labels={EVIDENCE_LABELS} />
                </div>

                {/* DESTINATION */}
                <div
                  style={{
                    background:   'var(--cdl-sky)',
                    border:       '1px solid #c8dfe9',
                    borderRadius: '6px',
                    padding:      '0.75rem 1rem',
                  }}
                >
                  <div
                    style={{
                      fontSize:      '0.7rem',
                      fontWeight:    700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.07em',
                      color:         'var(--cdl-muted)',
                      marginBottom:  '0.5rem',
                    }}
                  >
                    Destination
                  </div>
                  <JsonDl obj={rec.action} labels={ACTION_LABELS} />
                </div>
              </div>

              {/* Approve / Reject form */}
              <form
                style={{
                  display:    'flex',
                  alignItems: 'center',
                  gap:        '0.75rem',
                  flexWrap:   'wrap',
                }}
              >
                <input type="hidden" name="id" value={rec.id} />
                <input
                  type="text"
                  name="note"
                  placeholder="Optional note…"
                  style={{
                    flex:         '1 1 200px',
                    padding:      '0.45rem 0.75rem',
                    border:       '1px solid #c8dfe9',
                    borderRadius: '6px',
                    fontSize:     '0.85rem',
                    color:        'var(--cdl-ink)',
                    background:   '#fff',
                    outline:      'none',
                  }}
                />
                <button
                  formAction={approveRec}
                  style={{
                    padding:      '0.45rem 1.1rem',
                    background:   'var(--cdl-ok)',
                    color:        '#fff',
                    border:       'none',
                    borderRadius: '6px',
                    fontWeight:   700,
                    fontSize:     '0.85rem',
                    cursor:       'pointer',
                  }}
                >
                  Approve
                </button>
                <button
                  formAction={rejectRec}
                  style={{
                    padding:      '0.45rem 1.1rem',
                    background:   'var(--cdl-warn)',
                    color:        '#fff',
                    border:       'none',
                    borderRadius: '6px',
                    fontWeight:   700,
                    fontSize:     '0.85rem',
                    cursor:       'pointer',
                  }}
                >
                  Reject
                </button>
              </form>
            </div>
          ))}
        </div>
      )}

      {/* ── APPROVED section ───────────────────────────────────────────────── */}
      {approved.length > 0 && (
        <div style={{ marginTop: '2.5rem' }}>
          <h2
            style={{
              fontSize:      '1rem',
              fontWeight:    700,
              color:         'var(--cdl-ink)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom:  '0.75rem',
            }}
          >
            Approved — queued for push
          </h2>
          <div
            style={{
              display:       'flex',
              flexDirection: 'column',
              gap:           '0.4rem',
            }}
          >
            {approved.map((rec) => (
              <div
                key={rec.id}
                style={{
                  display:      'flex',
                  alignItems:   'baseline',
                  gap:          '1rem',
                  flexWrap:     'wrap',
                  padding:      '0.5rem 1rem',
                  background:   'var(--cdl-sky)',
                  border:       '1px solid #c8dfe9',
                  borderRadius: '6px',
                  fontSize:     '0.85rem',
                }}
              >
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontSize:   '0.75rem',
                    color:      'var(--cdl-muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {fmtDateTime(rec.decided_at)}
                </span>
                <span
                  style={{ fontWeight: 600, color: 'var(--cdl-ink)', flex: 1 }}
                >
                  {rec.why_line}
                </span>
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontSize:   '0.78rem',
                    color:      'var(--cdl-muted)',
                  }}
                >
                  {rec.rec_type} · {rec.entity_key}
                </span>
                {rec.decided_note && (
                  <span
                    style={{
                      fontSize:  '0.78rem',
                      color:     'var(--cdl-muted)',
                      fontStyle: 'italic',
                    }}
                  >
                    {rec.decided_note}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

    </div>
  )
}
