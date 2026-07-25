'use client'

import { usePathname } from 'next/navigation'

const NAV = [
  { href: '/',                label: 'Overview' },
  { href: '/accounts',        label: 'Accounts' },
  { href: '/campaigns',       label: 'Campaigns' },
  { href: '/spend',           label: 'Spend' },
  { href: '/recommendations', label: 'Recommendations' },
]

export default function NavBar() {
  const pathname = usePathname()

  return (
    <nav style={{
      background: 'var(--cdl-sky)',
      borderBottom: '1px solid #c8dfe9',
      padding: '0 2.5rem',
      display: 'flex',
      alignItems: 'center',
      height: '52px',
      gap: '0',
    }}>
      <span style={{
        fontFamily: 'var(--font-fraunces, Fraunces, Georgia, serif)',
        fontWeight: 700,
        fontSize: '1.05rem',
        color: 'var(--cdl-blue)',
        whiteSpace: 'nowrap',
        marginRight: '2.25rem',
        letterSpacing: '-0.01em',
      }}>
        Cuento de Luz · Ads
      </span>
      <div style={{ display: 'flex', height: '100%', alignItems: 'stretch' }}>
        {NAV.map(({ href, label }) => {
          const active = pathname === href
          return (
            <a
              key={href}
              href={href}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '0 1rem',
                fontSize: '0.88rem',
                fontWeight: active ? 700 : 400,
                color: active ? 'var(--cdl-blue)' : 'var(--cdl-ink)',
                borderBottom: active
                  ? '2px solid var(--cdl-blue)'
                  : '2px solid transparent',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </a>
          )
        })}
      </div>
    </nav>
  )
}
