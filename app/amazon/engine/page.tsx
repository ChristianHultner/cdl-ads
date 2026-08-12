// app/amazon/engine/page.tsx
// Server component — reads docs/doctrine.md at request time (single source of truth).
// docs/ is bundled into the Vercel function via next.config outputFileTracingIncludes.

import { readFileSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import EngineClient from './EngineClient'

export const dynamic = 'force-dynamic'

// ── Types (shared with EngineClient via props) ────────────────────────────────

export interface Block {
  type: 'diagram' | 'prose'
  /** Present when type = 'diagram' */
  code?: string
  /** Present when type = 'prose' */
  text?: string
}

export interface DocSection {
  id: string        // 'a' | 'b' | 'c' | 'd' | 'e' | 'findings'
  title: string     // raw header text, e.g. 'a. CANDIDATE PIPELINE'
  blocks: Block[]
}

// ── Doctrine parser ───────────────────────────────────────────────────────────

function parseDoctrine(raw: string): DocSection[] {
  const sections: DocSection[] = []

  // Split on lines that start a top-level ## header (keep delimiter with the part).
  const parts = raw.split(/(?=\n## )/)

  for (const part of parts) {
    const lines = part.trimStart().split('\n')
    const headerIdx = lines.findIndex(l => l.startsWith('## '))
    if (headerIdx === -1) continue

    const title = lines[headerIdx].replace(/^## /, '').trim()
    const idMatch = title.match(/^([a-z])\./)
    const id = idMatch
      ? idMatch[1]
      : title.toLowerCase().replace(/[^a-z0-9]+/g, '-')

    const body = lines.slice(headerIdx + 1).join('\n')

    // Slice body into alternating prose / diagram blocks.
    const blocks: Block[] = []
    const mermaidRe = /```mermaid\n([\s\S]*?)```/g
    let last = 0
    let m: RegExpExecArray | null

    while ((m = mermaidRe.exec(body)) !== null) {
      const prose = body.slice(last, m.index).trim()
      if (prose) blocks.push({ type: 'prose', text: prose })
      blocks.push({ type: 'diagram', code: m[1].trim() })
      last = m.index + m[0].length
    }

    const tail = body.slice(last).trim()
    if (tail) blocks.push({ type: 'prose', text: tail })

    sections.push({ id, title, blocks })
  }

  return sections
}

// ── Git date of last doctrine.md commit ──────────────────────────────────────

function getDocDate(): string {
  try {
    const out = execSync('git log -1 --format=%ci -- docs/doctrine.md', {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    return out.split(' ')[0] ?? '' // 'YYYY-MM-DD'
  } catch {
    try {
      const { statSync } = require('fs') as typeof import('fs')
      return statSync(join(process.cwd(), 'docs', 'doctrine.md'))
        .mtime.toISOString().slice(0, 10)
    } catch {
      return ''
    }
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function EnginePage() {
  const docPath = join(process.cwd(), 'docs', 'doctrine.md')
  const raw = readFileSync(docPath, 'utf8')
  const sections = parseDoctrine(raw)
  const docDate = getDocDate()

  return <EngineClient sections={sections} docDate={docDate} />
}
