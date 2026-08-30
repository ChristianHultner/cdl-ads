import Link from 'next/link'
import type { ExperimentRow } from './ExperimentsZone'
import styles from './DashboardZoneOne.module.css'

interface NeedsYouBandProps {
  approvalsWaiting: number
  experiments: ExperimentRow[]
}

export default function NeedsYouBand({ approvalsWaiting, experiments }: NeedsYouBandProps) {
  const verdicts = experiments
    .filter(experiment => experiment.verdictAt != null)
    .sort((a, b) => new Date(a.verdictAt!).getTime() - new Date(b.verdictAt!).getTime())
    .slice(0, 2)

  return (
    <section className={styles.needsYouSection}>
      <div className={styles.zoneLabel}>Needs you</div>
      <div className={styles.zoneCaption}>Everything on this dashboard that waits for a decision or a date.</div>
      <div className={styles.actions}>
        <Link className={`${styles.actionCard} ${styles.actionUrgent}`} href="/amazon/recommendations">
          <div className={styles.actionWhat}>{approvalsWaiting} {approvalsWaiting === 1 ? 'approval' : 'approvals'} waiting</div>
          <div className={styles.actionWhy}>Open the honest Amazon approval queue.</div>
        </Link>

        <div className={`${styles.actionCard} ${styles.actionDate}`}>
          <div className={styles.actionWhat}>Next verdicts</div>
          <div className={styles.actionWhy}>
            {verdicts.length > 0
              ? verdicts.map(verdict => `${verdict.name} · ${formatDate(verdict.verdictAt!)}`).join(' · ')
              : 'No live verdict dates.'}
          </div>
        </div>

        <div className={styles.actionCard}>
          <div className={styles.actionWhat}>Monthly export ritual</div>
          <div className={styles.actionWhy}>First weekend: console + vendor exports -&gt; importer</div>
        </div>
      </div>
    </section>
  )
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Madrid',
  }).format(new Date(value))
}
