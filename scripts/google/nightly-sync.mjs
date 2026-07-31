// scripts/google/nightly-sync.mjs
// ─────────────────────────────────────────────────────────────────────────────
// Nightly Google Ads sync orchestrator.
//
// ENV SOURCING: launchd runs this via bash -lc which explicitly sources
//   ~/secrets/neon.env and ~/secrets/cdl-ads-google.env before invoking node.
//   The plist ProgramArguments handles sourcing; no reliance on login shell
//   config or inherited env from a parent process.
//
// FAILURE POLICY: a step failure is logged (ok=false, detail=stderr tail) and
//   the orchestrator CONTINUES to the next step. Partial nightly beats none;
//   idempotent upserts self-heal on the next nightly run.
//
// EXIT: 0 if all steps ok; 1 if any step failed (visible to launchd).
// ─────────────────────────────────────────────────────────────────────────────

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { Pool, neonConfig } from '@neondatabase/serverless';

neonConfig.webSocketConstructor = WebSocket;

const __dir = fileURLToPath(new URL('.', import.meta.url));

// ─── Trailing window: today-7 .. today-1 in Europe/Madrid ───────────────────
function madridDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d);
}
const fromDate = madridDate(-7);
const toDate   = madridDate(-1);
console.log(`nightly-sync: window ${fromDate}..${toDate}`);

// ─── DB pool for sync log ────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.GOOGLE_DATABASE_URL });

// ─── Step definitions (sequential) ──────────────────────────────────────────
const STEPS = [
  { name: 'sync-structure',       script: 'sync-structure.mjs',       args: ['--execute'] },
  { name: 'sync-targeting',       script: 'sync-targeting.mjs',       args: ['--execute'] },
  { name: 'sync-campaign-daily',  script: 'sync-campaign-daily.mjs',  args: [`--from=${fromDate}`, `--to=${toDate}`, '--execute'] },
  { name: 'sync-search-terms',    script: 'sync-search-terms.mjs',    args: [`--from=${fromDate}`, `--to=${toDate}`, '--execute'] },
  { name: 'sync-asset-daily',     script: 'sync-asset-daily.mjs',     args: [`--from=${fromDate}`, `--to=${toDate}`, '--execute'] },
  { name: 'sync-recommendations', script: 'sync-recommendations.mjs', args: ['--execute'] },
];

// ─── Row parser: UPSERTED rows=N  or  SNAPSHOT inserted=N ───────────────────
function parseRows(stdout) {
  const m1 = (stdout ?? '').match(/UPSERTED rows=(\d+)/);
  if (m1) return parseInt(m1[1], 10);
  const m2 = (stdout ?? '').match(/SNAPSHOT inserted=(\d+)/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

// ─── Run steps ───────────────────────────────────────────────────────────────
let anyFailed = false;

for (const step of STEPS) {
  // a. Log start row
  const { rows: startRows } = await pool.query(
    `INSERT INTO google_sync_log (run_started_at, step, ok)
     VALUES (now(), $1, null)
     RETURNING id`,
    [step.name]
  );
  const logId = startRows[0].id;

  // b. Spawn proven script with --execute
  const result = spawnSync(
    process.execPath,
    [step.script, ...step.args],
    { cwd: __dir, env: process.env, encoding: 'utf8' }
  );

  const ok = result.status === 0;
  let rowsReported = null;
  let detail = null;

  if (ok) {
    rowsReported = parseRows(result.stdout);
    // Store result line (UPSERTED / SNAPSHOT / last stdout line) as detail
    const lastLine = (result.stdout ?? '').trim().split('\n').pop() ?? null;
    detail = lastLine || null;
    console.log(`STEP ${step.name} OK rows=${rowsReported ?? 'n/a'}`);
  } else {
    anyFailed = true;
    // Stderr tail, falling back to stdout tail; 500-char cap
    const errText = ((result.stderr || result.stdout) ?? 'no output').trim();
    detail = errText.slice(-500);
    console.error(`STEP ${step.name} FAILED: ${detail}`);
    // Continue — do not abort remaining steps
  }

  // c. Log finish
  await pool.query(
    `UPDATE google_sync_log
     SET run_finished_at = now(), ok = $1, detail = $2, rows_reported = $3
     WHERE id = $4`,
    [ok, detail, rowsReported, logId]
  );
}

await pool.end();

if (anyFailed) {
  console.error('nightly-sync: one or more steps FAILED (see google_sync_log)');
  process.exit(1);
}
console.log('nightly-sync: all steps complete');
