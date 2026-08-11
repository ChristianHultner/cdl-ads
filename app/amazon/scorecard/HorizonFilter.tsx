'use client'

import { useRouter, usePathname, useSearchParams } from 'next/navigation'

export function HorizonFilter({ current }: { current: string }) {
  const router      = useRouter()
  const pathname    = usePathname()
  const searchParams = useSearchParams()

  function go(h: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (h === 'all') {
      params.delete('horizon')
    } else {
      params.set('horizon', h)
    }
    const qs = params.toString()
    router.push(pathname + (qs ? '?' + qs : ''))
  }

  const options: { value: string; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 't7',  label: 'T7' },
    { value: 't14', label: 'T14' },
  ]

  return (
    <div className="filter-bar" style={{ marginBottom: '1.5rem' }}>
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => go(o.value)}
          className={'filter-link' + (current === o.value ? ' active' : '')}
          style={{ cursor: 'pointer', border: '1px solid #c8dfe9', background: current === o.value ? 'var(--cdl-blue)' : '#fff', color: current === o.value ? '#fff' : 'var(--cdl-ink)', borderRadius: '4px', padding: '4px 14px', fontSize: '0.83rem', fontWeight: 600 }}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
