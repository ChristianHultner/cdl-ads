// One-line machine status footer.
// Watchdog dot: green=OK, red=anything else. Actions count = PUSHED recs this month.

export interface MachineData {
  actionsThisMonth: number
  watchdogVerdict:  string // 'OK' | other
  watchdogChecked:  string // ISO timestamp
}

export default function MachineFooter({ data }: { data: MachineData }) {
  const isOk  = data.watchdogVerdict === 'OK'
  const dotCl = isOk ? 'var(--cdl-ok)' : 'var(--cdl-warn)'

  return (
    <div style={{
      marginTop: '1.5rem',
      borderTop: '1px solid #e2ecf0',
      paddingTop: '0.75rem',
      display: 'flex',
      alignItems: 'center',
      flexWrap: 'wrap',
      gap: '0 1.25rem',
      fontSize: '0.78rem',
      color: 'var(--cdl-muted)',
    }}>
      <span>
        <strong style={{ color: 'var(--cdl-ink)' }}>{data.actionsThisMonth}</strong> actions pushed this month
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
          background: dotCl, flexShrink: 0,
        }} />
        watchdog {data.watchdogVerdict}
      </span>
      <a
        href="/amazon/scorecard"
        style={{ color: 'var(--cdl-blue)', fontWeight: 600, textDecoration: 'none' }}
      >
        → scorecard
      </a>
    </div>
  )
}
