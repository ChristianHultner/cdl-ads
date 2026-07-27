'use client'

import { useState } from 'react'

// ── Flip to false when Christian authorises real pushes ───────────────────────
const DRY_RUN = true

// ── Types ─────────────────────────────────────────────────────────────────────
export interface ProfileMeta {
  profileId: string
  label: string   // country_code, e.g. "ES"
  count: number   // APPROVED recs in this profile
}

interface ScriptResult {
  exit: number
  pushed: number
  tail: string[]
}

interface ProfileResult {
  profileId: string
  dryRun: boolean
  missingEnv: string[]
  scripts: Record<string, ScriptResult>
  error?: string
}

interface Props {
  totalApproved: number
  profiles: ProfileMeta[]
}

// ── Human-readable script names ───────────────────────────────────────────────
const SCRIPT_LABELS: Record<string, string> = {
  'push-negatives':        'Negatives',
  'push-negative-targets': 'Negative Targets',
  'push-bid-adjustments':  'Bid Adjustments',
  'push-keywords':         'Keywords',
  'push-new-targets':      'New Targets',
  'push-structure':        'Structure',
}

// ── Root component ─────────────────────────────────────────────────────────────
export function PushAllButton({ totalApproved, profiles }: Props) {
  const [phase, setPhase]     = useState<'idle' | 'modal' | 'running' | 'done'>('idle')
  const [results, setResults] = useState<ProfileResult[]>([])
  const [current, setCurrent] = useState<string | null>(null)

  const disabled = totalApproved === 0

  async function handleConfirm() {
    setPhase('running')
    setResults([])

    for (const { profileId } of profiles) {
      setCurrent(profileId)
      try {
        const res = await fetch('/api/push-approved', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ profileId, dryRun: DRY_RUN }),
        })
        const data: ProfileResult = await res.json()
        setResults(prev => [...prev, data])
      } catch (err) {
        setResults(prev => [
          ...prev,
          {
            profileId,
            dryRun:     DRY_RUN,
            missingEnv: [],
            scripts:    {},
            error:      String(err),
          },
        ])
      }
    }

    setCurrent(null)
    setPhase('done')
  }

  const marketCount = profiles.length

  return (
    <>
      {/* ── Trigger button ─────────────────────────────────────────────────── */}
      <button
        onClick={() => { if (!disabled) setPhase('modal') }}
        disabled={disabled}
        style={{
          cursor:       disabled ? 'not-allowed' : 'pointer',
          padding:      '5px 16px',
          fontFamily:   'inherit',
          fontSize:     '0.85rem',
          fontWeight:   700,
          borderRadius: '5px',
          border:       '1px solid var(--cdl-blue)',
          background:   disabled
            ? 'rgba(0,147,208,0.04)'
            : 'rgba(0,147,208,0.12)',
          color:        disabled ? 'var(--cdl-muted)' : 'var(--cdl-blue)',
          transition:   'background 0.12s',
          marginBottom: '1.5rem',
          display:      'inline-flex',
          alignItems:   'center',
          gap:          '0.35rem',
        }}
      >
        Push approved ({totalApproved})
        {DRY_RUN && (
          <span style={{ fontWeight: 400, fontSize: '0.78rem', opacity: 0.75 }}>
            — dry-run
          </span>
        )}
      </button>

      {/* ── Confirm modal ──────────────────────────────────────────────────── */}
      {phase === 'modal' && (
        <div
          role="dialog"
          aria-modal="true"
          style={{
            position:       'fixed',
            inset:          0,
            background:     'rgba(0,0,0,0.42)',
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'center',
            zIndex:         1000,
          }}
        >
          <div style={{
            background:   '#fff',
            borderRadius: '10px',
            padding:      '1.5rem 2rem',
            maxWidth:     '440px',
            width:        '90vw',
            boxShadow:    '0 4px 32px rgba(0,0,0,0.18)',
          }}>
            <h3 style={{ marginBottom: '0.75rem' }}>Confirm push</h3>
            <p style={{
              fontSize:     '0.92rem',
              lineHeight:   1.55,
              marginBottom: '1rem',
              color:        'var(--cdl-ink)',
            }}>
              Push <strong>{totalApproved}</strong> approved
              recommendation{totalApproved !== 1 ? 's' : ''} across{' '}
              <strong>{marketCount}</strong> market{marketCount !== 1 ? 's' : ''}?
            </p>
            {DRY_RUN && (
              <p style={{
                fontSize:     '0.82rem',
                color:        'var(--cdl-muted)',
                marginBottom: '1.25rem',
                lineHeight:   1.45,
                padding:      '0.4rem 0.65rem',
                background:   'rgba(138,151,165,0.1)',
                borderRadius: '4px',
              }}>
                ⚠️ Dry-run — no Amazon API calls will be made.
                Flip <code>DRY_RUN</code> in{' '}
                <code>app/recommendations/PushAllButton.tsx</code> to enable live pushes.
              </p>
            )}
            <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setPhase('idle')}
                style={{
                  cursor:       'pointer',
                  padding:      '5px 16px',
                  fontFamily:   'inherit',
                  fontSize:     '0.85rem',
                  fontWeight:   600,
                  borderRadius: '4px',
                  border:       '1px solid #c8dfe9',
                  background:   '#fff',
                  color:        'var(--cdl-ink)',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleConfirm}
                className="btn-approve"
                style={{ padding: '5px 20px', fontSize: '0.85rem' }}
              >
                {DRY_RUN ? 'Run dry-run' : 'Push now'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Progress / Results panel ───────────────────────────────────────── */}
      {(phase === 'running' || phase === 'done') && (
        <div style={{
          border:       '1px solid #c8dfe9',
          borderRadius: '8px',
          padding:      '1rem 1.25rem',
          marginBottom: '1.75rem',
          background:   '#f7fbfd',
        }}>
          <div style={{
            display:        'flex',
            alignItems:     'center',
            justifyContent: 'space-between',
            marginBottom:   results.length > 0 ? '0.85rem' : 0,
          }}>
            <h3 style={{ margin: 0 }}>
              Push results{' '}
              {phase === 'running' && current && (
                <span style={{
                  color:      'var(--cdl-muted)',
                  fontWeight: 400,
                  fontSize:   '0.82rem',
                }}>
                  — {current}…
                </span>
              )}
            </h3>
            {phase === 'done' && (
              <button
                onClick={() => { setPhase('idle'); setResults([]) }}
                style={{
                  cursor:       'pointer',
                  fontSize:     '0.78rem',
                  padding:      '2px 9px',
                  border:       '1px solid #c8dfe9',
                  borderRadius: '4px',
                  background:   '#fff',
                  color:        'var(--cdl-muted)',
                  fontFamily:   'inherit',
                }}
              >
                Dismiss
              </button>
            )}
          </div>

          {results.map(r => (
            <ProfileResultPanel
              key={r.profileId}
              result={r}
              profiles={profiles}
            />
          ))}

          {phase === 'running' &&
            current &&
            !results.find(r => r.profileId === current) && (
              <p style={{
                color:    'var(--cdl-muted)',
                fontSize: '0.85rem',
                margin:   0,
              }}>
                Waiting…
              </p>
            )}
        </div>
      )}
    </>
  )
}

// ── Per-profile result panel ──────────────────────────────────────────────────
function ProfileResultPanel({
  result,
  profiles,
}: {
  result: ProfileResult
  profiles: ProfileMeta[]
}) {
  const meta  = profiles.find(p => p.profileId === result.profileId)
  const label = meta?.label ?? result.profileId

  const hasIssues =
    result.error != null ||
    result.missingEnv.length > 0 ||
    Object.values(result.scripts).some(s => s.exit !== 0)

  const borderColor = hasIssues ? 'rgba(192,57,43,0.28)' : 'rgba(26,127,78,0.22)'
  const bgColor     = hasIssues ? 'rgba(192,57,43,0.04)' : 'rgba(26,127,78,0.04)'
  const headBg      = hasIssues ? 'rgba(192,57,43,0.08)' : 'rgba(26,127,78,0.07)'

  return (
    <div style={{
      border:       `1px solid ${borderColor}`,
      borderRadius: '6px',
      marginBottom: '0.7rem',
      background:   bgColor,
      overflow:     'hidden',
    }}>
      {/* section header */}
      <div style={{
        padding:      '0.45rem 0.9rem',
        display:      'flex',
        alignItems:   'center',
        gap:          '0.6rem',
        flexWrap:     'wrap',
        borderBottom: '1px solid #eef4f8',
        background:   headBg,
      }}>
        <strong style={{ fontSize: '0.88rem' }}>{label}</strong>
        {result.dryRun && <span className="badge badge-muted">dry-run</span>}
        {hasIssues
          ? <span className="badge badge-warn">issues</span>
          : <span className="badge badge-ok">ok</span>}
        {meta && (
          <span style={{
            color:     'var(--cdl-muted)',
            fontSize:  '0.78rem',
            marginLeft:'auto',
          }}>
            {meta.count} rec{meta.count !== 1 ? 's' : ''}
          </span>
        )}
      </div>

      <div style={{ padding: '0.65rem 0.9rem' }}>
        {/* Missing env vars — surfaced prominently */}
        {result.missingEnv.length > 0 && (
          <div style={{
            marginBottom: '0.65rem',
            padding:      '0.4rem 0.7rem',
            background:   'rgba(192,57,43,0.07)',
            borderRadius: '4px',
            fontSize:     '0.82rem',
            color:        'var(--cdl-warn)',
          }}>
            <strong>Missing env vars → add to Vercel dashboard:</strong>{' '}
            <code style={{ fontFamily: 'monospace' }}>
              {result.missingEnv.join(', ')}
            </code>
          </div>
        )}

        {/* Network / JSON error */}
        {result.error && (
          <div style={{
            marginBottom: '0.65rem',
            color:        'var(--cdl-warn)',
            fontSize:     '0.82rem',
          }}>
            <strong>Error:</strong> {result.error}
          </div>
        )}

        {/* Per-script rows */}
        {Object.entries(result.scripts).map(([name, sr]) => (
          <ScriptRow key={name} name={name} result={sr} />
        ))}
      </div>
    </div>
  )
}

// ── Single-script row ─────────────────────────────────────────────────────────
function ScriptRow({ name, result }: { name: string; result: ScriptResult }) {
  const [open, setOpen] = useState(false)
  const label = SCRIPT_LABELS[name] ?? name
  const ok    = result.exit === 0

  return (
    <div style={{ marginBottom: '0.3rem' }}>
      <div style={{
        display:    'flex',
        alignItems: 'center',
        gap:        '0.5rem',
        fontSize:   '0.82rem',
        flexWrap:   'wrap',
      }}>
        <span style={{
          color:      ok ? 'var(--cdl-ok)' : 'var(--cdl-warn)',
          fontWeight: 700,
          minWidth:   '1em',
          flexShrink: 0,
        }}>
          {ok ? '✓' : '✗'}
        </span>
        <span style={{ fontWeight: 600, minWidth: '9.5rem', flexShrink: 0 }}>
          {label}
        </span>
        {result.pushed > 0 && (
          <span className="badge badge-ok">{result.pushed} pushed</span>
        )}
        {!ok && (
          <span className="badge badge-warn">exit {result.exit}</span>
        )}
        {result.tail.length > 0 && (
          <button
            onClick={() => setOpen(v => !v)}
            style={{
              cursor:       'pointer',
              fontSize:     '0.72rem',
              padding:      '1px 7px',
              border:       '1px solid #c8dfe9',
              borderRadius: '3px',
              background:   '#fff',
              color:        'var(--cdl-muted)',
              fontFamily:   'inherit',
              marginLeft:   'auto',
              flexShrink:   0,
            }}
          >
            {open ? 'hide' : 'log'}
          </button>
        )}
      </div>

      {open && result.tail.length > 0 && (
        <pre style={{
          margin:      '0.25rem 0 0 1.6rem',
          fontSize:    '0.71rem',
          lineHeight:  1.45,
          color:       ok ? 'var(--cdl-ink)' : 'var(--cdl-warn)',
          background:  ok ? '#f0f7fa' : 'rgba(192,57,43,0.05)',
          padding:     '0.45rem 0.7rem',
          borderRadius:'4px',
          overflow:    'auto',
          maxHeight:   '11rem',
          whiteSpace:  'pre-wrap',
          wordBreak:   'break-word',
        }}>
          {result.tail.join('\n')}
        </pre>
      )}
    </div>
  )
}
