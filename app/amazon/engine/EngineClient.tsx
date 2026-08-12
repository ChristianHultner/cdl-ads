'use client'

// app/amazon/engine/EngineClient.tsx
// Renders parsed doctrine.md sections: tab nav, mermaid diagrams, prose, fullscreen.

import { useState, useEffect, useId, useCallback, useRef } from 'react'
import type { DocSection, Block } from './page'

// ── Mermaid instance guard (initialize once per page load) ────────────────────

let mermaidReady = false
async function getMermaid() {
  const m = (await import('mermaid')).default
  if (!mermaidReady) {
    m.initialize({
      startOnLoad: false,
      theme: 'default',
      flowchart: { useMaxWidth: false, htmlLabels: true },
      securityLevel: 'loose',
    })
    mermaidReady = true
  }
  return m
}

// ── MermaidDiagram ────────────────────────────────────────────────────────────

let _diagramSeq = 0

function MermaidDiagram({ chart }: { chart: string }) {
  const [svg, setSvg]         = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string>('')
  const [full, setFull]       = useState(false)
  const uid = useRef(`mdg${++_diagramSeq}`).current

  useEffect(() => {
    let live = true
    setLoading(true); setSvg(''); setError('')

    getMermaid().then(async m => {
      // mermaid 11 render returns { svg, bindFunctions }
      const out = await m.render(uid, chart)
      const rendered = typeof out === 'string' ? out : out.svg
      if (live) { setSvg(rendered); setLoading(false) }
    }).catch(e => {
      if (live) { setError(String(e)); setLoading(false) }
    })

    return () => { live = false }
  }, [chart, uid])

  return (
    <div style={{ margin: '1.5rem 0' }}>
      {/* toolbar */}
      {svg && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.4rem' }}>
          <button
            onClick={() => setFull(true)}
            style={{
              fontSize: '0.72rem', padding: '0.2rem 0.6rem',
              border: '1px solid #c8dfe9', borderRadius: 4,
              background: 'var(--cdl-sky)', cursor: 'pointer',
              color: 'var(--cdl-ink)',
            }}
          >⛶ Fullscreen</button>
        </div>
      )}

      {/* diagram – horizontal scroll */}
      <div style={{
        overflowX: 'auto', overflowY: 'hidden',
        border: '1px solid #e4ecf0', borderRadius: 6,
        padding: '1rem', background: '#fafcfd',
        minHeight: '80px',
      }}>
        {loading && (
          <div style={{ textAlign: 'center', color: '#aaa', padding: '2rem 0', fontSize: '0.85rem' }}>
            Rendering diagram…
          </div>
        )}
        {error && (
          <pre style={{ color: '#c00', fontSize: '0.75rem', whiteSpace: 'pre-wrap' }}>{error}</pre>
        )}
        {svg && (
          <div dangerouslySetInnerHTML={{ __html: svg }} style={{ minWidth: 'min-content' }} />
        )}
      </div>

      {/* fullscreen modal */}
      {full && svg && (
        <div
          role="dialog"
          aria-modal
          onClick={() => setFull(false)}
          style={{
            position: 'fixed', inset: 0,
            background: 'rgba(0,0,0,0.80)',
            zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '2rem',
          }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{
              background: '#fff', borderRadius: 10,
              padding: '2rem',
              maxWidth: '95vw', maxHeight: '92vh',
              overflow: 'auto',
              boxShadow: '0 8px 40px rgba(0,0,0,0.4)',
              position: 'relative',
            }}
          >
            <button
              onClick={() => setFull(false)}
              style={{
                position: 'absolute', top: '0.75rem', right: '0.75rem',
                fontSize: '0.8rem', padding: '0.25rem 0.6rem',
                border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer',
                background: '#f5f5f5',
              }}
            >✕ Close</button>
            <div
              dangerouslySetInnerHTML={{ __html: svg }}
              style={{ marginTop: '1.5rem' }}
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Prose renderer ────────────────────────────────────────────────────────────
// Lightweight markdown → JSX. Handles: bold, code-spans, code-blocks,
// blockquotes, ### headings, hr, bullets, numbered items, paragraphs.
// FINDINGS: ✅ RESOLVED items get a green badge.

function inlineRender(text: string): React.ReactNode[] {
  // Split on **bold**, `code`, and ✅ RESOLVED markers
  const parts: React.ReactNode[] = []
  const re = /(\*\*[\s\S]*?\*\*|`[^`]+`|✅\s*RESOLVED\s*[\d-]*)/g
  let last = 0, m: RegExpExecArray | null, i = 0

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) {
      parts.push(<strong key={i++}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('`')) {
      parts.push(
        <code key={i++} style={{
          fontFamily: 'monospace', fontSize: '0.82em',
          background: '#eef2f5', padding: '0.1em 0.35em', borderRadius: 3,
        }}>{tok.slice(1, -1)}</code>
      )
    } else if (tok.startsWith('✅')) {
      parts.push(
        <span key={i++} style={{
          display: 'inline-flex', alignItems: 'center', gap: '0.25rem',
          background: '#d4f5d4', color: '#1a6b1a',
          fontSize: '0.72rem', fontWeight: 700,
          padding: '0.15rem 0.5rem', borderRadius: 12,
          marginLeft: '0.5rem', verticalAlign: 'middle',
        }}>✅ {tok.replace('✅', '').trim()}</span>
      )
    }
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

const CODE_FENCE = /^```[\s\S]*?^```/m

function ProseBlock({ text, isFinding }: { text: string; isFinding: boolean }) {
  const lines = text.split('\n')
  const out: React.ReactNode[] = []
  let i = 0

  const flush = (content: React.ReactNode, key: number) => { out.push(content); }

  while (i < lines.length) {
    const line = lines[i]

    // horizontal rule
    if (/^---+\s*$/.test(line)) {
      out.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid #e0e8ec', margin: '1rem 0' }} />)
      i++; continue
    }

    // ### heading
    if (line.startsWith('### ')) {
      out.push(
        <h3 key={i} style={{ fontSize: '0.9rem', fontWeight: 700, margin: '1.25rem 0 0.5rem', color: 'var(--cdl-blue)' }}>
          {inlineRender(line.slice(4))}
        </h3>
      )
      i++; continue
    }

    // #### heading
    if (line.startsWith('#### ')) {
      out.push(
        <h4 key={i} style={{ fontSize: '0.82rem', fontWeight: 700, margin: '1rem 0 0.25rem', color: 'var(--cdl-ink)' }}>
          {inlineRender(line.slice(5))}
        </h4>
      )
      i++; continue
    }

    // blockquote (> …)
    if (line.startsWith('> ')) {
      const qLines: string[] = []
      while (i < lines.length && lines[i].startsWith('> ')) {
        qLines.push(lines[i].slice(2)); i++
      }
      out.push(
        <blockquote key={i} style={{
          borderLeft: '3px solid var(--cdl-sky)', margin: '0.75rem 0',
          paddingLeft: '1rem', color: '#555', fontSize: '0.85rem',
        }}>
          {qLines.map((ql, qi) => <div key={qi}>{inlineRender(ql)}</div>)}
        </blockquote>
      )
      continue
    }

    // fenced code block (non-mermaid)
    if (line.startsWith('```')) {
      const fence = line.slice(3).trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]); i++
      }
      i++ // consume closing ```
      out.push(
        <pre key={i} style={{
          background: '#f0f4f6', borderRadius: 5, padding: '0.75rem 1rem',
          fontSize: '0.76rem', overflowX: 'auto', margin: '0.75rem 0',
          fontFamily: 'monospace',
        }}>
          <code>{codeLines.join('\n')}</code>
        </pre>
      )
      continue
    }

    // bullet list
    if (line.startsWith('- ') || line.startsWith('* ')) {
      const items: string[] = []
      while (i < lines.length && (lines[i].startsWith('- ') || lines[i].startsWith('* '))) {
        items.push(lines[i].slice(2)); i++
      }
      out.push(
        <ul key={i} style={{ paddingLeft: '1.4rem', margin: '0.5rem 0', fontSize: '0.85rem' }}>
          {items.map((it, ii) => <li key={ii} style={{ marginBottom: '0.2rem' }}>{inlineRender(it)}</li>)}
        </ul>
      )
      continue
    }

    // FINDINGS numbered item: "1. **Title** …"
    if (isFinding && /^\d+\.\s/.test(line)) {
      const numMatch = line.match(/^(\d+)\.\s+(.*)/)
      if (numMatch) {
        const num = numMatch[1]
        const rest: string[] = [numMatch[2]]
        i++
        // Collect indented continuation lines
        while (i < lines.length && (lines[i].startsWith('   ') || lines[i] === '')) {
          rest.push(lines[i]); i++
        }
        const fullText = rest.join('\n').trim()
        // Is it resolved?
        const isResolved = fullText.includes('✅ RESOLVED')
        out.push(
          <div key={`finding-${num}`} style={{
            display: 'flex', gap: '0.75rem',
            margin: '0.75rem 0',
            padding: '0.75rem 1rem',
            borderRadius: 6,
            background: isResolved ? '#f0faf0' : '#fff8f0',
            border: `1px solid ${isResolved ? '#b8deb8' : '#f0d8b0'}`,
          }}>
            <span style={{
              flexShrink: 0, width: '1.4rem', height: '1.4rem',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: '50%',
              background: isResolved ? '#28a745' : '#e0a800',
              color: '#fff', fontSize: '0.7rem', fontWeight: 700,
            }}>{num}</span>
            <div style={{ fontSize: '0.84rem', lineHeight: 1.55 }}>
              {fullText.split('\n').map((fl, fi) => (
                <div key={fi} style={{ marginBottom: fi === 0 ? '0.2rem' : 0 }}>
                  {inlineRender(fl)}
                </div>
              ))}
            </div>
          </div>
        )
        continue
      }
    }

    // blank line
    if (line.trim() === '') { i++; continue }

    // normal paragraph — collect until blank or special line
    const paraLines: string[] = []
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('### ') &&
      !lines[i].startsWith('#### ') &&
      !lines[i].startsWith('> ') &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('- ') &&
      !lines[i].startsWith('* ') &&
      !/^---+\s*$/.test(lines[i]) &&
      !(isFinding && /^\d+\.\s/.test(lines[i]))
    ) {
      paraLines.push(lines[i]); i++
    }
    if (paraLines.length) {
      out.push(
        <p key={`p${i}`} style={{ margin: '0.5rem 0', fontSize: '0.85rem', lineHeight: 1.6 }}>
          {inlineRender(paraLines.join(' '))}
        </p>
      )
    }
  }

  return <>{out}</>
}

// ── Tab nav labels ────────────────────────────────────────────────────────────

const TAB_LABELS: Record<string, string> = {
  a: 'a · Pipeline',
  b: 'b · Bid Gates',
  c: 'c · Push',
  d: 'd · Grading',
  e: 'e · Lifecycle',
  findings: 'Findings',
}

// ── EngineClient (root) ───────────────────────────────────────────────────────

interface Props {
  sections: DocSection[]
}

export default function EngineClient({ sections }: Props) {
  const [activeId, setActiveId] = useState<string>(sections[0]?.id ?? 'a')
  const activeSection = sections.find(s => s.id === activeId) ?? sections[0]
  const isFinding = activeSection?.id === 'findings'

  return (
    <div style={{ fontFamily: 'inherit' }}>
      {/* ── Page header ── */}
      <div style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ fontSize: '1.35rem', fontWeight: 700, margin: '0 0 0.4rem', color: 'var(--cdl-blue)' }}>
          Engine Decision Trees
        </h1>
        <p style={{
          fontSize: '0.78rem', color: '#666', margin: 0,
          background: '#f0f4f6', display: 'inline-block',
          padding: '0.3rem 0.75rem', borderRadius: 20,
        }}>
          📄 Thresholds shown reflect <strong>doctrine.md</strong> — live params may be tuned in{' '}
          <code style={{ fontFamily: 'monospace', fontSize: '0.9em' }}>engine_parameters</code>.
        </p>
      </div>

      {/* ── Section tabs ── */}
      <div style={{
        display: 'flex', gap: '0.35rem', flexWrap: 'wrap',
        borderBottom: '2px solid #d8e6ed',
        marginBottom: '2rem', paddingBottom: '0',
      }}>
        {sections.map(s => {
          const label = TAB_LABELS[s.id] ?? s.title
          const active = s.id === activeId
          return (
            <button
              key={s.id}
              onClick={() => setActiveId(s.id)}
              style={{
                padding: '0.45rem 1rem',
                fontSize: '0.78rem',
                fontWeight: active ? 700 : 400,
                color: active ? 'var(--cdl-blue)' : 'var(--cdl-ink)',
                border: 'none',
                borderBottom: active ? '2px solid var(--cdl-blue)' : '2px solid transparent',
                background: 'transparent',
                cursor: 'pointer',
                marginBottom: '-2px',
                borderRadius: '4px 4px 0 0',
                whiteSpace: 'nowrap',
              }}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* ── Active section ── */}
      {activeSection && (
        <div key={activeSection.id}>
          <h2 style={{
            fontSize: '1.05rem', fontWeight: 700, margin: '0 0 1.25rem',
            color: 'var(--cdl-ink)',
          }}>
            {activeSection.title}
          </h2>

          {activeSection.blocks.map((block, bi) =>
            block.type === 'diagram' ? (
              <MermaidDiagram key={bi} chart={block.code!} />
            ) : (
              <ProseBlock key={bi} text={block.text!} isFinding={isFinding} />
            )
          )}
        </div>
      )}
    </div>
  )
}
