'use client'

import { usePathname } from 'next/navigation'

const AMAZON_NAV = [
  { href: '/amazon/campaigns',       label: 'Campaigns' },
  { href: '/amazon/recommendations', label: 'Recommendations' },
  { href: '/amazon/spend',           label: 'Spend' },
  { href: '/amazon/accounts',        label: 'Accounts' },
]

export default function AmazonLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()

  return (
    <>
      {/* Channel sub-nav — negative margins break out of the root layout's padding wrapper */}
      <nav
        style={{
          background: 'var(--cdl-sky)',
          borderBottom: '1px solid #c8dfe9',
          padding: '0 2.5rem',
          display: 'flex',
          alignItems: 'center',
          height: '40px',
          marginTop: '-2rem',
          marginLeft: '-2.5rem',
          marginRight: '-2.5rem',
          marginBottom: '2rem',
        }}
      >
        {AMAZON_NAV.map(({ href, label }) => {
          const active = pathname === href || pathname.startsWith(href + '/')
          return (
            <a
              key={href}
              href={href}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: '100%',
                padding: '0 0.85rem',
                fontSize: '0.82rem',
                fontWeight: active ? 700 : 400,
                color: active ? 'var(--cdl-blue)' : 'var(--cdl-ink)',
                borderBottom: active
                  ? '2px solid var(--cdl-blue)'
                  : '2px solid transparent',
                whiteSpace: 'nowrap',
                textDecoration: 'none',
              }}
            >
              {label}
            </a>
          )
        })}
      </nav>
      {children}
    </>
  )
}
