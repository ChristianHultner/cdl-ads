'use client'

import { useState } from 'react'
import { approveRecommendation } from './actions'

// Must match server-side ASIN_RE in actions.ts
const ASIN_RE = /^([0-9]{9}[0-9Xx]|B0[A-Za-z0-9]{8})$/i

interface Props {
  id: number
  proposedBid: number | undefined
}

export function CreativeTargetApproveForm({ id, proposedBid }: Props) {
  const [asin, setAsin] = useState('')
  const trimmed   = asin.trim()
  const asinValid = ASIN_RE.test(trimmed)
  const showWarn  = trimmed.length > 0 && !asinValid

  return (
    <form
      action={approveRecommendation}
      style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', flexShrink: 0 }}
    >
      <input type="hidden" name="id" value={id} />
      <input
        type="number"
        name="approved_bid"
        step="0.01"
        min="0.02"
        defaultValue={proposedBid}
        placeholder="bid"
        style={{
          width: '5.2rem',
          padding: '3px 6px',
          fontSize: '0.82rem',
          border: '1px solid #c8dfe9',
          borderRadius: '4px',
          fontFamily: 'inherit',
          textAlign: 'right' as const,
        }}
      />
      <input
        type="text"
        name="asin"
        value={asin}
        onChange={e => setAsin(e.target.value)}
        placeholder="ASIN from Amazon"
        autoComplete="off"
        spellCheck={false}
        style={{
          width: '10rem',
          padding: '3px 6px',
          fontSize: '0.82rem',
          fontFamily: 'monospace',
          border: `1px solid ${showWarn ? '#f0b429' : '#c8dfe9'}`,
          borderRadius: '4px',
        }}
      />
      <button
        type="submit"
        className="btn-approve"
        disabled={!asinValid}
        aria-disabled={!asinValid}
      >
        Approve
      </button>
    </form>
  )
}
