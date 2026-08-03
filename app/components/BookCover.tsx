'use client'

import { useState } from 'react'

const CDN_BASE = 'https://media.cuentodeluz.com/covers'

/**
 * Lightweight cover accent sourced from the public media CDN.
 * Gracefully falls back to a neutral book-glyph placeholder on 404 —
 * never shows a broken-image icon.
 *
 * Props:
 *   isbn13  – print/HC ISBN-13 (keyed by title_cache / book_clusters)
 *   alt     – accessible label (falls back to isbn13)
 *   size    – 'sm' ~40px (default) | 'md' ~64px
 */
export function BookCover({
  isbn13,
  alt,
  size = 'sm',
}: {
  isbn13: string
  alt?: string
  size?: 'sm' | 'md'
}) {
  const [errored, setErrored] = useState(false)
  const dim = size === 'sm' ? 40 : 64

  const sharedStyle: React.CSSProperties = {
    width:        `${dim}px`,
    height:       `${dim}px`,
    borderRadius: '3px',
    flexShrink:   0,
  }

  if (errored) {
    return (
      <span
        aria-label={alt ?? isbn13}
        role="img"
        style={{
          ...sharedStyle,
          display:        'inline-flex',
          alignItems:     'center',
          justifyContent: 'center',
          background:     'var(--cdl-sky, #e8f4fa)',
          fontSize:       size === 'sm' ? '14px' : '20px',
          color:          'var(--cdl-muted, #888)',
          userSelect:     'none',
        }}
      >
        📖
      </span>
    )
  }

  return (
    <img
      src={`${CDN_BASE}/${isbn13}.jpg`}
      alt={alt ?? isbn13}
      loading="lazy"
      width={dim}
      height={dim}
      style={{ ...sharedStyle, objectFit: 'cover', display: 'inline-block' }}
      onError={() => setErrored(true)}
    />
  )
}
