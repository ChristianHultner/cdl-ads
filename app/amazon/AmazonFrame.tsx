'use client'

import { usePathname } from 'next/navigation'
import { dayLabel } from '@/lib/amazon/yardstick'
import s from './ui.module.css'

// Transitional routes: Results and Health point at the current pages
// until each new page replaces them (frames ADS-UI-3 … ADS-UI-6).
const NAV: { href: string; label: string; badge?: boolean; match: string[] }[] = [
  { href: '/amazon', label: 'Overview', match: [] },
  { href: '/amazon/decisions', label: 'Decisions', badge: true, match: ['/amazon/decisions', '/amazon/recommendations'] },
  { href: '/amazon/campaigns', label: 'Campaigns', match: ['/amazon/campaigns'] },
  { href: '/amazon/scorecard', label: 'Results', match: ['/amazon/scorecard', '/amazon/results', '/amazon/engine'] },
  { href: '/amazon/spend', label: 'Health', match: ['/amazon/spend', '/amazon/health', '/amazon/accounts'] },
]

// Pages already built on the new look render edge to edge; older pages keep
// the padding they were designed with.
const NEW_PAGES = new Set(['/amazon', '/amazon/decisions'])

export default function AmazonFrame({
  drafts, dataTo, failed, checked, children,
}: { drafts: number; dataTo: string | null; failed: number; checked: boolean; children: React.ReactNode }) {
  const path = usePathname() ?? ''
  const isActive = (item: (typeof NAV)[number]) =>
    item.href === '/amazon' ? path === '/amazon' : item.match.some(m => path === m || path.startsWith(m + '/'))

  const warn = !checked || failed > 0 || !dataTo
  const chip = !checked
    ? 'Could not check the data'
    : failed > 0
      ? `${failed} sync step${failed === 1 ? '' : 's'} failed in the last 24 h`
      : dataTo
        ? `Data to ${dayLabel(dataTo)} · all steps ran`
        : 'No ad data yet'

  return (
    <>
      <div className={s.bar}>
        <div className={s.barInner}>
          <nav aria-label="Amazon" className={s.nav}>
            {NAV.map(item => {
              const active = isActive(item)
              return (
                <a key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
                   className={active ? s.navLinkActive : s.navLink}>
                  {item.label}
                  {item.badge && drafts > 0 ? <span className={s.badge}>{drafts}</span> : null}
                </a>
              )
            })}
          </nav>
          <a href="/amazon/spend" className={warn ? s.dataChipWarn : s.dataChip}>
            {!warn ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                   strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
            ) : null}
            {chip}
          </a>
        </div>
      </div>
      <div className={NEW_PAGES.has(path) ? undefined : s.legacy}>{children}</div>
    </>
  )
}
