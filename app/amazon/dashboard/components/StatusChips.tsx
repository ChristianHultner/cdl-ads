import styles from './DashboardZoneOne.module.css'

export interface DashboardStatus {
  approvalsWaiting: number
  nextVerdictName: string | null
  nextVerdictAt: string | null
  syncedAt: string | null
}

export default function StatusChips({ status }: { status: DashboardStatus }) {
  const approvalsLabel = status.approvalsWaiting === 1
    ? '1 approval waiting'
    : `${status.approvalsWaiting} approvals waiting`

  return (
    <div className={styles.chips}>
      <span className={styles.chip}>
        <span className={`${styles.dot} ${status.approvalsWaiting > 0 ? styles.dotAmber : styles.dotGreen}`} />
        <b>{approvalsLabel}</b>
      </span>

      <span className={styles.chip}>
        next verdict:{' '}
        <b>
          {status.nextVerdictName && status.nextVerdictAt
            ? `${status.nextVerdictName} · ${formatShortDate(status.nextVerdictAt)}`
            : 'none live'}
        </b>
      </span>

      <span className={styles.chip}>
        <span className={`${styles.dot} ${styles.dotGreen}`} />
        <b>{status.syncedAt ? `synced ${formatTime(status.syncedAt)}` : 'sync unavailable'}</b>
      </span>
    </div>
  )
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'Europe/Madrid',
  }).format(new Date(value))
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: 'Europe/Madrid',
  }).format(new Date(value))
}
