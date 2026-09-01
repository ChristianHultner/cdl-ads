export const dynamic = 'force-dynamic'
export const maxDuration = 300

import Link from 'next/link'
import { getGoogleDb } from '@/lib/google/db'
import { SPECS } from '@/lib/google/spec-registry'
import { validateSpec } from '@/lib/google/spec-validator'
import { dryRun, executeBuild } from './actions'

interface BuildLogRow {
  id: string
  started_at: string
  finished_at: string | null
  mode: 'DRY_RUN' | 'EXECUTE'
  spec_file: string
  campaign: string
  ok: boolean | null
  operations: number | null
  campaign_resource: string | null
  report: unknown
  lines: unknown
  error: string | null
}

interface GreenDryRunRow {
  spec_file: string
  campaign: string
}

const cardStyle = {
  border: '1px solid #c8dfe9',
  borderRadius: '8px',
  padding: '1.25rem',
  background: '#fff',
} as const

const buttonStyle = {
  border: 0,
  borderRadius: '6px',
  padding: '0.48rem 0.9rem',
  font: 'inherit',
  fontSize: '0.82rem',
  fontWeight: 700,
  cursor: 'pointer',
} as const

function buildKey(specFile: string, campaign: string): string {
  return `${specFile}\u0000${campaign}`
}

function fmtDateTime(value: string | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-GB', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function outputLines(value: unknown): string[] {
  return Array.isArray(value) ? value.map((line) => String(line)) : []
}

function resultLabel(ok: boolean | null): string {
  if (ok === null) return 'RUNNING'
  return ok ? 'OK' : 'FAILED'
}

function resultColour(ok: boolean | null): string {
  if (ok === null) return 'var(--cdl-blue)'
  return ok ? 'var(--cdl-ok)' : 'var(--cdl-warn)'
}

function LatestResult({ row }: { row: BuildLogRow | undefined }) {
  if (!row) {
    return (
      <p style={{ margin: 0, color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
        No build result yet.
      </p>
    )
  }

  const lines = outputLines(row.lines)
  return (
    <div style={{ marginTop: '1rem' }}>
      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          alignItems: 'center',
          flexWrap: 'wrap',
          marginBottom: '0.55rem',
          fontSize: '0.8rem',
        }}
      >
        <strong>{row.mode}</strong>
        <strong style={{ color: resultColour(row.ok) }}>
          {resultLabel(row.ok)}
        </strong>
        <span>{row.operations ?? 0} operations</span>
        <span style={{ color: 'var(--cdl-muted)' }}>
          {fmtDateTime(row.finished_at ?? row.started_at)}
        </span>
      </div>

      {row.ok === null && (
        <p style={{ color: 'var(--cdl-blue)', margin: '0 0 0.55rem' }}>
          Build is running. This receipt will update when the action finishes.
        </p>
      )}

      <pre
        style={{
          margin: 0,
          padding: '0.8rem',
          maxHeight: '20rem',
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          borderRadius: '6px',
          background: '#f5f8fa',
          border: '1px solid #e1e9ed',
          fontFamily: 'var(--font-ibm-plex-mono), monospace',
          fontSize: '0.75rem',
          lineHeight: 1.45,
        }}
      >
        {lines.length > 0 ? lines.join('\n') : 'No output lines.'}
      </pre>

      {row.error && (
        <pre
          style={{
            margin: '0.6rem 0 0',
            padding: '0.75rem',
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            color: 'var(--cdl-warn)',
            background: '#fff0f0',
            border: '1px solid #f5a0a0',
            borderRadius: '6px',
            fontFamily: 'var(--font-ibm-plex-mono), monospace',
            fontSize: '0.75rem',
          }}
        >
          {row.error}
        </pre>
      )}
    </div>
  )
}

export default async function GoogleBuildPage() {
  const sql = getGoogleDb()
  const [greenRows, latestRows, history] = await Promise.all([
    sql`
      SELECT DISTINCT spec_file, campaign
        FROM google_build_log
       WHERE mode = 'DRY_RUN'
         AND ok = true
         AND finished_at >= now() - interval '60 minutes'
    ` as unknown as Promise<GreenDryRunRow[]>,
    sql`
      SELECT DISTINCT ON (spec_file, campaign)
             id::text,
             started_at::text,
             finished_at::text,
             mode,
             spec_file,
             campaign,
             ok,
             operations,
             campaign_resource,
             report,
             lines,
             error
        FROM google_build_log
       ORDER BY spec_file, campaign, started_at DESC, id DESC
    ` as unknown as Promise<BuildLogRow[]>,
    sql`
      SELECT id::text,
             started_at::text,
             finished_at::text,
             mode,
             spec_file,
             campaign,
             ok,
             operations,
             campaign_resource,
             report,
             lines,
             error
        FROM google_build_log
       ORDER BY started_at DESC, id DESC
       LIMIT 20
    ` as unknown as Promise<BuildLogRow[]>,
  ])

  const greenKeys = new Set(
    greenRows.map((row) => buildKey(row.spec_file, row.campaign)),
  )
  const latestByCampaign = new Map(
    latestRows.map((row) => [buildKey(row.spec_file, row.campaign), row]),
  )

  return (
    <div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <h1>Google Campaign Builder</h1>
        <Link
          href="/google"
          style={{ color: 'var(--cdl-blue)', fontSize: '0.85rem', fontWeight: 700 }}
        >
          ← Google Ads
        </Link>
      </div>

      <p style={{ margin: '-0.5rem 0 1.5rem', color: 'var(--cdl-muted)' }}>
        Validate a registered spec first. Execute unlocks for 60 minutes after a
        green dry run and always creates the campaign born PAUSED.
      </p>

      {SPECS.length === 0 ? (
        <p style={{ ...cardStyle, color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
          No campaign specs are registered.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
          {SPECS.map((entry) => {
            const validation = validateSpec(entry.spec)
            const campaigns = Array.isArray(entry.spec.campaigns)
              ? entry.spec.campaigns
              : []

            return (
              <section key={entry.id} style={cardStyle}>
                <h2 style={{ marginBottom: '0.25rem' }}>{entry.file}</h2>

                {validation.ok ? (
                  <p
                    style={{
                      margin: '0 0 1rem',
                      color: 'var(--cdl-ok)',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                    }}
                  >
                    VALID · {validation.summary.campaigns} campaigns ·{' '}
                    {validation.summary.adGroups} ad groups ·{' '}
                    {validation.summary.keywords} keywords ·{' '}
                    {validation.summary.rsas} RSAs ·{' '}
                    {validation.summary.callouts} callouts ·{' '}
                    {validation.summary.structuredSnippets} structured snippets
                  </p>
                ) : (
                  <div
                    style={{
                      margin: '0 0 1rem',
                      padding: '0.75rem',
                      color: 'var(--cdl-warn)',
                      background: '#fff0f0',
                      border: '1px solid #f5a0a0',
                      borderRadius: '6px',
                      fontSize: '0.82rem',
                    }}
                  >
                    <strong>SPEC INVALID</strong>
                    <ul style={{ margin: '0.35rem 0 0 1.2rem' }}>
                      {validation.errors.map((error) => (
                        <li key={error}>{error}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {campaigns.length === 0 ? (
                  <p style={{ color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
                    No campaigns in this spec.
                  </p>
                ) : (
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}
                  >
                    {campaigns.map((campaign) => {
                      const key = buildKey(entry.file, campaign.name)
                      const green = greenKeys.has(key)
                      const latest = latestByCampaign.get(key)
                      const runDry = dryRun.bind(null, entry.id, campaign.name)
                      const runExecute = executeBuild.bind(
                        null,
                        entry.id,
                        campaign.name,
                      )

                      return (
                        <article
                          key={campaign.name}
                          style={{
                            padding: '1rem',
                            border: '1px solid #e1e9ed',
                            borderRadius: '8px',
                            background: '#fbfdfe',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'flex-start',
                              gap: '1rem',
                              flexWrap: 'wrap',
                            }}
                          >
                            <div>
                              <h3 style={{ marginBottom: '0.15rem' }}>
                                {campaign.name}
                              </h3>
                              <span
                                style={{
                                  color: 'var(--cdl-muted)',
                                  fontSize: '0.78rem',
                                }}
                              >
                                {campaign.geo.country} · {campaign.language} · €
                                {campaign.budget_eur_day.toFixed(2)}/day · born{' '}
                                {campaign.born_paused ? 'PAUSED' : 'NOT PAUSED'}
                              </span>
                            </div>

                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'flex-start',
                                gap: '0.75rem',
                                flexWrap: 'wrap',
                              }}
                            >
                              <form action={runDry}>
                                <button
                                  type="submit"
                                  style={{
                                    ...buttonStyle,
                                    color: '#fff',
                                    background: 'var(--cdl-blue)',
                                  }}
                                >
                                  Dry run
                                </button>
                              </form>

                              {green && (
                                <form
                                  action={runExecute}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: '0.55rem',
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <label
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: '0.35rem',
                                      fontSize: '0.78rem',
                                      color: 'var(--cdl-warn)',
                                      fontWeight: 700,
                                    }}
                                  >
                                    <input
                                      type="checkbox"
                                      name="confirm_execute"
                                      value="yes"
                                      required
                                    />
                                    I confirm this creates real resources (born PAUSED)
                                  </label>
                                  <button
                                    type="submit"
                                    style={{
                                      ...buttonStyle,
                                      color: '#fff',
                                      background: 'var(--cdl-warn)',
                                    }}
                                  >
                                    Execute
                                  </button>
                                </form>
                              )}
                            </div>
                          </div>

                          {!green && (
                            <p
                              style={{
                                margin: '0.65rem 0 0',
                                color: 'var(--cdl-muted)',
                                fontSize: '0.78rem',
                              }}
                            >
                              Execute locked: no green dry run in the last 60 minutes.
                            </p>
                          )}

                          <LatestResult row={latest} />
                        </article>
                      )
                    })}
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}

      <h2 style={{ marginTop: '2.5rem' }}>Build History — Last 20</h2>
      {history.length === 0 ? (
        <p style={{ ...cardStyle, color: 'var(--cdl-muted)', fontStyle: 'italic' }}>
          No campaign build receipts yet.
        </p>
      ) : (
        <div className="table-card">
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Mode</th>
                  <th>Spec</th>
                  <th>Campaign</th>
                  <th>Result</th>
                  <th className="num">Operations</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {history.map((row) => (
                  <tr key={row.id}>
                    <td>{fmtDateTime(row.started_at)}</td>
                    <td>{row.mode}</td>
                    <td>{row.spec_file}</td>
                    <td>{row.campaign}</td>
                    <td style={{ color: resultColour(row.ok), fontWeight: 700 }}>
                      {resultLabel(row.ok)}
                    </td>
                    <td className="num">{row.operations ?? 0}</td>
                    <td className="wrap">{row.error ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
