import styles from './DashboardZoneOne.module.css'

export interface ExperimentRow {
  id: number
  name: string
  hypothesis: string
  market: string
  startedAt: string | null
  horizonDays: number
  verdictAt: string | null
  status: string
}

export default function ExperimentsZone({ rows }: { rows: ExperimentRow[] }) {
  if (rows.length === 0) return null

  return (
    <section className={styles.experimentsSection}>
      <div className={styles.zoneLabel}>Running experiments</div>
      <div className={styles.zoneCaption}>Every live bet, its bar, and its clock. Nothing spends without a row here.</div>
      <div className={styles.experiments}>
        {rows.map(row => {
          const elapsedDays = row.startedAt ? daysElapsed(row.startedAt, row.horizonDays) : 0
          const progress = row.startedAt && row.horizonDays > 0
            ? elapsedDays / row.horizonDays * 100
            : 0
          const live = row.status === 'LIVE'
          const proposed = row.status === 'PROPOSED'

          return (
            <article className={styles.experiment} key={row.id}>
              <div>
                <div className={styles.experimentName}>{row.name}</div>
                <div className={styles.experimentHypothesis}>{row.hypothesis}</div>
              </div>
              <div>
                <div className={styles.experimentBar}>
                  <span className={styles.experimentFill} style={{ width: `${progress}%` }} />
                  {row.startedAt && <span className={styles.experimentVerdictLine} />}
                </div>
                <div className={styles.experimentDays}>
                  {row.startedAt
                    ? `day ${elapsedDays} of ${row.horizonDays} · verdict ${formatVerdictDate(row.verdictAt)}`
                    : `not started · ${row.horizonDays}-day horizon`}
                </div>
              </div>
              <div className={styles.experimentStatus}>
                <span className={`${styles.experimentBadge} ${live ? styles.badgeLive : proposed ? styles.badgeWaiting : styles.badgeNeutral}`}>
                  {live ? 'live' : proposed ? 'awaiting approval' : row.status.toLowerCase()}
                </span>
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function daysElapsed(startedAt: string, horizonDays: number) {
  const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 86_400_000)
  return Math.min(horizonDays, Math.max(0, elapsed))
}

function formatVerdictDate(verdictAt: string | null) {
  if (!verdictAt) return '—'
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Madrid',
  }).format(new Date(verdictAt))
}
