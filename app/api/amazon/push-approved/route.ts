import { NextRequest, NextResponse } from 'next/server'
import { neon } from '@neondatabase/serverless'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

// ── Static env vars every push script requires ────────────────────────────────
// LWA_CLIENT_ID and LWA_CLIENT_SECRET are NOT in Vercel env by default.
// If missing they'll appear in missingEnv and the run will be blocked
// (execute mode) or annotated (dryRun mode).
const STATIC_REQUIRED = [
  'DATABASE_URL',
  'LWA_CLIENT_ID',
  'LWA_CLIENT_SECRET',
] as const

// ── Script execution order (fixed per task spec) ──────────────────────────────
const SCRIPTS = [
  'push-negatives',
  'push-negative-targets',
  'push-bid-adjustments',
  'push-keywords',
  'push-new-targets',
  'push-structure',
  'push-budget-adjustments',
  'push-replace-ads',
] as const

type ScriptName = (typeof SCRIPTS)[number]

export interface ScriptResult {
  exit:    number
  pushed:  number  // from 'Execute complete: N pushed'
  partial: number  // from 'Execute complete: N pushed, M partial'
  skipped: number  // from 'Totals: X fetched, Y skipped'
  tail:    string[]  // last 25 lines of combined stdout+stderr
}

export interface PushProfileResponse {
  profileId: string
  dryRun: boolean
  missingEnv: string[]
  scripts: Partial<Record<ScriptName, ScriptResult>>
}

// ── Spawn one script, capture output ─────────────────────────────────────────
function spawnScript(
  name: string,
  profileId: string,
  execute: boolean,
): Promise<ScriptResult> {
  return new Promise(resolve => {
    // join(process.cwd(), ...) is evaluated at runtime; Turbopack cannot
    // statically trace this path as a module import.
    const cwd        = process.cwd()
    const scriptFile = join(cwd, 'scripts', name + '.mjs')
    const args       = [scriptFile, '--profile', profileId]
    if (execute) args.push('--execute')

    // Child inherits process.env — DATABASE_URL / LWA_* flow through.
    const child = spawn('node', args, {
      cwd,
      env:   process.env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const lines: string[] = []
    const collect = (buf: Buffer) =>
      buf.toString().split('\n').forEach(l => { if (l.trim()) lines.push(l) })

    child.stdout?.on('data', collect)
    child.stderr?.on('data', collect)

    child.on('close', code => {
      const execLine   = lines.find(l => /execute complete:/i.test(l))
      const totalsLine = lines.find(l => /^\s*Totals:/i.test(l))
      const pushed  = execLine   ? (Number(execLine.match(/(\d+)\s+pushed/i)?.[1])   || 0) : 0
      const partial = execLine   ? (Number(execLine.match(/(\d+)\s+partial/i)?.[1])  || 0) : 0
      const skipped = totalsLine ? (Number(totalsLine.match(/(\d+)\s+skipped/i)?.[1]) || 0) : 0
      resolve({ exit: code ?? 1, pushed, partial, skipped, tail: lines.slice(-25) })
    })

    child.on('error', err =>
      resolve({ exit: 1, pushed: 0, partial: 0, skipped: 0, tail: [`spawn error: ${err.message}`] }),
    )
  })
}

// ── POST /api/amazon/push-approved ───────────────────────────────────────────
// Body: { profileId: string, dryRun?: boolean }
// dryRun defaults to true (safe).
// One profile per invocation; client loops profiles sequentially.
export async function POST(req: NextRequest) {
  // Parse body
  let body: { profileId?: unknown; dryRun?: unknown }
  try { body = await req.json() }
  catch { return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 }) }

  const { profileId, dryRun = true } = body
  if (typeof profileId !== 'string' || !profileId.trim()) {
    return NextResponse.json({ error: 'profileId (string) required' }, { status: 400 }) 
  }

  // ── Check static env vars ──────────────────────────────────────────────────
  const missingEnv: string[] = []
  for (const key of STATIC_REQUIRED) {
    if (!process.env[key]) missingEnv.push(key)
  }

  // ── Resolve per-profile refresh-token env var name from DB ────────────────
  let profileEnvVar: string | null = null
  if (process.env.DATABASE_URL) {
    try {
      const sql = neon(process.env.DATABASE_URL)
      const rows = (await sql`
        SELECT c.env_var_name
          FROM amazon_profiles p
          JOIN amazon_credentials c ON c.id = p.credential_id
         WHERE p.profile_id::text = ${profileId}
         LIMIT 1
      `) as Array<{ env_var_name: string }>

      if (rows.length === 0) {
        return NextResponse.json(
          { error: `Profile ${profileId} not found in amazon_profiles` },
          { status: 404 },
        )
      }
      profileEnvVar = rows[0].env_var_name
      if (profileEnvVar && !process.env[profileEnvVar]) {
        missingEnv.push(profileEnvVar)
      }
    } catch (e) {
      return NextResponse.json(
        { error: `DB lookup failed: ${e instanceof Error ? e.message : String(e)}` },
        { status: 500 },
      )
    }
  }

  // ── dryRun=true: env-audit only, no scripts spawned ──────────────────────
  // Flip dryRun to false in a later frame to enable real execute runs.
  if (dryRun) {
    const scripts = Object.fromEntries(
      SCRIPTS.map(name => [
        name,
        {
          exit:    0,
          pushed:  0,
          partial: 0,
          skipped: 0,
          tail: [
            `[dryRun] would run: node scripts/${name}.mjs --profile ${profileId} --execute`,
            ...(missingEnv.length > 0
              ? [`[dryRun] blocked — missing env vars: ${missingEnv.join(', ')}`]
              : ['[dryRun] env vars present — would proceed']),
          ],
        } satisfies ScriptResult,
      ]),
    ) as Record<ScriptName, ScriptResult>

    return NextResponse.json({
      profileId,
      dryRun:     true,
      missingEnv,
      scripts,
    } satisfies PushProfileResponse)
  }

  // ── execute mode: gate on missing vars ────────────────────────────────────
  if (missingEnv.length > 0) {
    return NextResponse.json(
      {
        error:      'Missing required env vars — add them to Vercel env dashboard',
        missingEnv,
      },
      { status: 422 },
    )
  }

  // ── Run all scripts sequentially for this profile ─────────────────────────
  const scripts: Partial<Record<ScriptName, ScriptResult>> = {}
  for (const name of SCRIPTS) {
    scripts[name] = await spawnScript(name, profileId, true)
  }

  return NextResponse.json({
    profileId,
    dryRun:     false,
    missingEnv: [],
    scripts,
  } satisfies PushProfileResponse)
}
